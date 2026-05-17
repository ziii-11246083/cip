from __future__ import annotations

import math
import os
import random
import re
import statistics
import time
import copy
import io
import base64
import json
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple
from functools import wraps
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import pandas as pd
import numpy as np
import feedparser
import yfinance as yf
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from wordcloud import WordCloud
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify, send_file, abort, render_template
from flask_cors import CORS
from pydantic import BaseModel, Field, ValidationError
from openai import OpenAI
from dotenv import load_dotenv

# 載入環境變數
load_dotenv()

# Supabase Client
try:
    from supabase_client import get_db
except ImportError:
    print("請確認已安裝 supabase 套件: pip install supabase")

# ==========================================
# 🔧 1. 系統配置、金鑰設定
# ==========================================
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
SIM_PORTFOLIOS: Dict[str, Dict[str, Any]] = {}
SIM_LOCK = Lock()
SIM_INITIAL_CASH = 100000.0

class Config:
    CG_API_KEY: str = os.getenv("CG_API_KEY", "")
    CACHE_TTL: int = 300 
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    
    COIN_META = {
        'BTC': {'cn_name': '比特幣'}, 'ETH': {'cn_name': '以太幣'}, 'BNB': {'cn_name': '幣安幣'},
        'SOL': {'cn_name': '索拉納'}, 'XRP': {'cn_name': '瑞波幣'}, 'DOGE': {'cn_name': '狗狗幣'},
        'ADA': {'cn_name': '艾達幣'}, 'TRX': {'cn_name': '波場幣'}, 'AVAX': {'cn_name': '雪崩幣'},
        'USDC': {'cn_name': 'USD Coin', 'is_stable': True}, 'USDT': {'cn_name': '泰達幣', 'is_stable': True}
    }
    STABLE_COINS = {'USDC', 'FDUSD', 'USDT', 'DAI', 'TUSD', 'USDE'}
    NARRATIVES = {
        "AI & Compute": {"keywords": ["ai", "gpu", "nvidia", "fetch", "render"], "coins": ["FET-USD", "RNDR-USD"]},
        "RWA": {"keywords": ["rwa", "blackrock", "ondo", "tokenization"], "coins": ["ONDO-USD", "MKR-USD"]},
        "Meme Coins": {"keywords": ["meme", "doge", "pepe", "shib"], "coins": ["DOGE-USD", "PEPE-USD"]},
        "Layer 2": {"keywords": ["layer 2", "layer2", "optimism", "arb", "arbitrum"], "coins": ["OP-USD", "ARB-USD"]},
    }
    RSS_FEEDS = [
        "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "https://cointelegraph.com/rss",
        "https://decrypt.co/feed",
        "https://cryptopotato.com/feed/",
        "https://news.bitcoin.com/feed/"
    ]

CG_ID_MAP = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "ripple",
    "BNB": "binancecoin", "ADA": "cardano", "DOGE": "dogecoin", "AVAX": "avalanche-2",
    "MATIC": "matic-network", "ARB": "arbitrum", "OP": "optimism", "DOT": "polkadot",
    "LINK": "chainlink", "UNI": "uniswap", "LTC": "litecoin", "BCH": "bitcoin-cash",
    "USDT": "tether", "USDC": "usd-coin", "DAI": "dai", "TRX": "tron", "PEPE": "pepe"
}

app = Flask(__name__)
CORS(app) 
np.seterr(divide='ignore', invalid='ignore')
client: Optional[OpenAI] = OpenAI(api_key=Config.OPENAI_API_KEY) if Config.OPENAI_API_KEY and "sk-" in Config.OPENAI_API_KEY else None

# 初始化 Supabase
try:
    db = get_db()
    print("Supabase initialized" if db else "Supabase disabled")
except Exception as e:
    print(f"Supabase init failed: {e}")
    db = None

DEMO_MEMBER_TOKEN = "smartinvest-demo-member-token"
DEMO_MEMBER_USER = {
    "uid": "demo-member",
    "email": "test@smartinvest.local",
    "is_guest": False,
    "is_demo": True,
}

@app.context_processor
def inject_public_config() -> Dict[str, str]:
    return {
        "supabase_url": os.getenv("SUPABASE_URL", ""),
        "supabase_anon_key": os.getenv("SUPABASE_ANON_KEY", ""),
    }

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            if auth_header.startswith('Bearer '):
                token = auth_header.split(' ')[1]
        if not token:
            return jsonify({'error': '請先登入系統', 'code': 'auth/unauthorized'}), 401
        if token == DEMO_MEMBER_TOKEN:
            request.user = DEMO_MEMBER_USER.copy()
            return f(*args, **kwargs)
        try:
            if not db: return jsonify({'error': '登入服務暫時不可用', 'code': 'auth/service-unavailable'}), 503
            user_response = db.client.auth.get_user(token)
            user = getattr(user_response, 'user', None)
            if not user: return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
            request.user = {'uid': user.id, 'email': user.email}
        except Exception:
            return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
        return f(*args, **kwargs)
    return decorated

def optional_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            if auth_header.startswith('Bearer '):
                token = auth_header.split(' ')[1]
        if not token:
            request.user = {'uid': 'guest', 'email': None, 'is_guest': True}
            return f(*args, **kwargs)
        if token == DEMO_MEMBER_TOKEN:
            request.user = DEMO_MEMBER_USER.copy()
            return f(*args, **kwargs)
        try:
            if not db: return jsonify({'error': '登入服務暫時不可用', 'code': 'auth/service-unavailable'}), 503
            user_response = db.client.auth.get_user(token)
            user = getattr(user_response, 'user', None)
            if not user: return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
            request.user = {'uid': user.id, 'email': user.email, 'is_guest': False}
        except Exception:
            return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
        return f(*args, **kwargs)
    return decorated

def ttl_cache(ttl_seconds: int):
    def decorator(func):
        cache = {}
        @wraps(func)
        def wrapper(*args, **kwargs):
            now = time.time()
            key = str(args) + str(kwargs)
            if key in cache and 'timestamp' in cache[key] and now - cache[key]['timestamp'] < ttl_seconds:
                return copy.deepcopy(cache[key]['data'])
            result = func(*args, **kwargs)
            if result: cache[key] = {'data': result, 'timestamp': now}
            return copy.deepcopy(result)
        return wrapper
    return decorator

# ==========================================
# 🌐 2. 核心引擎
# ==========================================
class DataManager:
    @staticmethod
    def _cg_get(path: str, params: dict = None) -> Any:
        url = f"https://api.coingecko.com/api/v3{path}"
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
        if Config.CG_API_KEY and Config.CG_API_KEY.startswith("CG-") and Config.CG_API_KEY.isascii():
            headers['x-cg-demo-api-key'] = Config.CG_API_KEY
        try:
            res = requests.get(url, params=params, headers=headers, timeout=10)
            if res.status_code == 200: return res.json()
        except Exception: pass
        return None

    @staticmethod
    def _market_coin_to_entry(t: Dict, rank: Optional[int] = None) -> Dict:
        symbol = (t.get('symbol') or '').upper()
        meta = Config.COIN_META.get(symbol, {})
        market_rank = rank or t.get('market_cap_rank') or 0
        return {
            "id": t.get('id') or CG_ID_MAP.get(symbol, symbol.lower()),
            "symbol": symbol,
            "price_usd": float(t.get('current_price')) if t.get('current_price') else 0.0,
            "change": float(t.get('price_change_percentage_24h')) if t.get('price_change_percentage_24h') else 0.0,
            "rank": int(market_rank) if market_rank else 0,
            "name": t.get('name') or symbol,
            "cn_name": meta.get('cn_name', t.get('name') or symbol),
            "is_stable": meta.get('is_stable', symbol in Config.STABLE_COINS),
            "history_prices": t.get('sparkline_in_7d', {}).get('price', []),
            "risk": {}
        }

    @staticmethod
    def _attach_risk_to_coin(coin: Dict, btc_prices: List[float]) -> Dict:
        symbol = coin.get('symbol', '')
        history_prices = coin.get('history_prices', [])
        price_usd = coin.get('price_usd', 0.0)

        if symbol == 'BTC':
            coin['risk'] = {"level": "base", "msg": "市場基準", "corr": 1.0, "score": 0, "lambda": 0, "beta": 1}
        elif len(btc_prices) > 10 and len(history_prices) > 10:
            min_len = min(len(btc_prices), len(history_prices))
            df = pd.DataFrame({'BTC': btc_prices[-min_len:], symbol: history_prices[-min_len:]})
            coin['risk'] = RiskModel.calculate_copula_risk(symbol, df, coin.get('is_stable', False), price_usd)
        else:
            coin['risk'] = {"level": "base", "msg": "資料不足", "score": 0}

        if 'history_prices' in coin: del coin['history_prices']
        return coin

    @staticmethod
    @ttl_cache(ttl_seconds=Config.CACHE_TTL)
    def get_all_tickers() -> List[Dict]:
        tickers = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": 50, "page": 1, "sparkline": "true"})
        if not tickers: return []
        final_list = []
        if db:
            crypto_rows, price_rows = [], []
            for idx, t in enumerate(tickers):
                entry = DataManager._market_coin_to_entry(t, rank=idx + 1)
                final_list.append(entry)
                crypto_rows.append({"symbol": entry["symbol"], "name": entry["name"], "chinese_name": entry.get("cn_name"), "coingecko_id": entry.get("id")})
                price_rows.append({"symbol": entry["symbol"], "price": entry["price_usd"], "market_cap": float(t.get("market_cap", 0) or 0), "volume_24h": float(t.get("total_volume", 0) or 0), "price_change_24h": float(t.get("price_change_percentage_24h", 0) or 0), "timestamp": datetime.utcnow().isoformat()})
            symbol_to_id = db.upsert_cryptocurrencies(crypto_rows)
            insert_data = []
            for price_row in price_rows:
                crypto_id = symbol_to_id.get(price_row["symbol"])
                if crypto_id:
                    price_row["crypto_id"] = crypto_id
                    insert_data.append(price_row)
            if insert_data: db.bulk_insert_price_data(insert_data)
        else:
            for idx, t in enumerate(tickers):
                final_list.append(DataManager._market_coin_to_entry(t, rank=idx + 1))
        return final_list

    @staticmethod
    def build_historical_df(crypto_list: List[Dict]) -> pd.DataFrame:
        data_dict = {c['symbol']: c.get('history_prices', []) for c in crypto_list if len(c.get('history_prices', [])) > 10}
        if 'BTC' not in data_dict: return pd.DataFrame()
        min_len = min([len(v) for v in data_dict.values()])
        return pd.DataFrame({k: v[-min_len:] for k, v in data_dict.items()})

    @staticmethod
    @ttl_cache(ttl_seconds=180)
    def search_sfi_assets(query: str) -> List[Dict]:
        query = (query or "").strip().lower()
        if not query: return []
        base_coins = DataManager.get_all_tickers()
        btc_prices = next((coin.get('history_prices', []) for coin in base_coins if coin.get('symbol') == 'BTC'), [])

        local_ids = []
        for coin in base_coins:
            haystack = " ".join([str(coin.get('symbol', '')), str(coin.get('name', '')), str(coin.get('cn_name', '')), str(coin.get('id', ''))]).lower()
            if query in haystack and coin.get('id'): local_ids.append(coin['id'])

        search_payload = DataManager._cg_get("/search", {"query": query}) or {}
        remote_ids = [coin.get('id') for coin in (search_payload.get('coins') or []) if coin.get('id')]

        ordered_ids = []
        for coin_id in local_ids + remote_ids:
            if coin_id and coin_id not in ordered_ids: ordered_ids.append(coin_id)
            if len(ordered_ids) >= 8: break

        if not ordered_ids: return []

        market_payload = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "ids": ",".join(ordered_ids), "sparkline": "true", "price_change_percentage": "24h"}) or []
        results = []
        for raw_coin in market_payload:
            normalized = DataManager._market_coin_to_entry(raw_coin)
            results.append(DataManager._attach_risk_to_coin(normalized, btc_prices))

        def sort_key(coin: Dict) -> Tuple[int, int, int, int]:
            symbol = str(coin.get('symbol', '')).lower()
            name = str(coin.get('name', '')).lower()
            cn_name = str(coin.get('cn_name', '')).lower()
            rank = int(coin.get('rank') or 999999)
            exact = 0 if query in {symbol, name, cn_name} else 1
            starts = 0 if symbol.startswith(query) or name.startswith(query) or cn_name.startswith(query) else 1
            contains = 0 if query in f"{symbol} {name} {cn_name}" else 1
            return (exact, starts, contains, rank)

        results.sort(key=sort_key)
        return results

class AIAssistant:
    @staticmethod
    def generate_sfi_insight(score: int) -> str:
        if score >= 65: return "🔴 <b>AI 警告：溫室裡的花朵！</b><br>對大盤抵抗力差，容易跟著跳水。"
        elif score >= 40: return "🟡 <b>AI 判斷：正常的跟屁蟲。</b><br>表現中規中矩，沒有特別突出的防禦力。"
        else: return "🟢 <b>AI 提示：獨立的孤狼！</b><br>走勢與大盤脫鉤，適合當作資金避風港。"

    @staticmethod
    def generate_copula_insight(corr: float, lambda_lower: float) -> str:
        insight = ""
        if corr >= 0.6: insight += "📈 <b>【連體嬰】</b>走勢與比特幣極像，無法分散風險。<br>"
        elif corr <= 0.3: insight += "☁️ <b>【各自安好】</b>走勢獨立，適合分散資產。<br>"
        else: insight += "🤝 <b>【普通朋友】</b>平常跟隨大盤，偶爾走自己的路。<br>"
        if lambda_lower >= 0.3: insight += "⚠️ <b>嚴重警告：</b>股災時絕對會被拖下水。"
        elif lambda_lower <= 0.1: insight += "🛡️ <b>防禦屬性：</b>崩盤時具備抗跌能力。"
        return insight

    @staticmethod
    def generate_mc_insight(current_price: float, mean_path_end: float, volatility: float) -> str:
        trend = "向上翹 🚀" if mean_path_end > current_price * 1.02 else "往下垂 📉" if mean_path_end < current_price * 0.98 else "平緩 ⚖️"
        vol_insight = "藍線極散，未來不確定性極大 🎢" if volatility > 3.0 else "藍線緊密，未來幾天價格安定 🛌" if volatility < 1.0 else "波動風險正常"
        return f"➖ <b>預測黃線：</b>{trend}<br>📢 <b>風險判讀：</b>{vol_insight}"

class MonteCarloEngine:
    @staticmethod
    def simulate_price_paths(prices: List[float], days: int = 7, simulations: int = 100) -> Dict:
        try:
            if len(prices) < 10: return {}
            log_returns = np.log(np.array(prices[1:]) / np.array(prices[:-1]))
            drift = log_returns.mean() - (0.5 * log_returns.var())
            stdev = log_returns.std()
            if np.isnan(stdev) or stdev == 0: return {}
            simulation_data = []
            last_price = prices[-1]
            for _ in range(simulations):
                prices_path = [last_price]
                for _ in range(days):
                    prices_path.append(prices_path[-1] * np.exp(drift + stdev * np.random.normal()))
                simulation_data.append(prices_path)
            final_prices = [p[-1] for p in simulation_data]
            return {"paths": simulation_data, "mean_path": np.mean(simulation_data, axis=0).tolist(), "var_95": np.percentile(final_prices, 5), "current_price": last_price, "volatility": stdev * 100}
        except: return {}

class RiskModel:
    @staticmethod
    def calculate_copula_risk(symbol: str, df: pd.DataFrame, is_stable: bool, current_price: float) -> Dict:
        try:
            if is_stable: return {"level": "safe", "msg": "穩定資產", "corr": 0.01, "score": 1, "lambda": 0, "beta": 0}
            if symbol not in df.columns or 'BTC' not in df.columns: return {"level": "base", "msg": "資料不足", "score": 0}
            target_df = df[['BTC', symbol]].dropna()
            returns = target_df.pct_change().dropna()
            if len(target_df) < 10: return {"level": "base", "msg": "資料不足", "score": 0}

            corr = returns['BTC'].corr(returns[symbol])
            if np.isnan(corr): corr = 0.0
            u, v = returns['BTC'].rank(pct=True), returns[symbol].rank(pct=True)
            lambda_lower = np.sum((u <= 0.2) & (v <= 0.2)) / max(1, np.sum(u <= 0.2))
            tail_beta = returns[symbol][returns['BTC'] <= returns['BTC'].quantile(0.1)].mean() / max(0.0001, returns['BTC'][returns['BTC'] <= returns['BTC'].quantile(0.1)].mean())
            if np.isnan(tail_beta): tail_beta = 1.0
            
            raw_score = (lambda_lower * 0.5 + (corr if corr>0 else 0)*0.2 + ((min(2.0, max(0.5, float(np.clip(tail_beta, -2.0, 5.0)))) - 0.5) / 1.5) * 0.3) * 100
            sfi_score = int(np.clip(0 if np.isnan(raw_score) else raw_score, 0, 100))
            level, msg = ("danger", "極度脆弱") if sfi_score >= 65 else ("warning", "中度連動") if sfi_score >= 40 else ("safe", "走勢獨立")
            
            return {"level": level, "msg": msg, "corr": round(corr, 2), "score": sfi_score, "beta": round(tail_beta, 2), "lambda": round(lambda_lower, 2)}
        except: return {"level": "base", "msg": "運算錯誤", "score": 0}

class SocialMediaEngine:
    SIGNAL_KEYWORDS = ["ETF", "升息", "降息", "通膨", "監管", "支撐", "壓力", "均線", "鯨魚", "鏈上", "TVL", "質押", "空投", "白皮書", "核准", "通過", "上市", "減半", "現貨", "合約", "回購", "增持", "銷毀", "新高", "大漲", "突破", "趨勢", "佈局", "創新", "整合"]
    STRONG_HEADERS = ["[新聞]", "[情報]", "[翻譯]", "[數據]", "[分析]", "快訊"]

    @staticmethod
    def get_content_summary(url: str) -> str:
        try:
            res = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Cookie": "over18=1"}, timeout=1.5)
            if res.status_code != 200: return ""
            soup = BeautifulSoup(res.text, "html.parser")
            main_content = soup.find(id="main-content")
            if main_content:
                for tag in main_content.find_all(["div", "span"], class_=["article-metaline", "article-metaline-right", "push"]): tag.extract()
                return re.sub(r'\s+', ' ', main_content.get_text().strip())[:80] + "..."
            return ""
        except: return ""

    @staticmethod
    def process_single_ptt_post(div):
        try:
            title_div = div.find("div", class_="title")
            if not title_div or not title_div.a: return None
            title = title_div.a.text.strip()
            link = "https://www.ptt.cc" + title_div.a["href"]
            date_str = div.find("div", class_="date").text.strip()
            if len(date_str) == 4: date_str = "0" + date_str
            summary = SocialMediaEngine.get_content_summary(link)
            nrec = div.find("div", class_="nrec").text
            push_count = 100 if nrec == "爆" else 0 if not nrec or nrec.startswith("X") else int(nrec)
            return {"source": "PTT", "title": title, "author": div.find("div", class_="author").text, "date": date_str, "push": push_count, "link": link, "content": summary if summary else title}
        except: return None

    @staticmethod
    def scrape_ptt() -> List[Dict]:
        results = []
        try:
            session = requests.Session()
            session.cookies.set('over18', '1')
            url = "https://www.ptt.cc/bbs/DigiCurrency/index.html"
            for _ in range(2):
                res = session.get(url, timeout=5)
                soup = BeautifulSoup(res.text, "html.parser")
                divs = soup.find_all("div", class_="r-ent")
                with ThreadPoolExecutor(max_workers=5) as executor:
                    futures = [executor.submit(SocialMediaEngine.process_single_ptt_post, div) for div in divs]
                    for future in as_completed(futures):
                        if future.result(): results.append(future.result())
                prev_link = soup.find("a", string="‹ 上頁")
                if prev_link and "href" in prev_link.attrs: url = "https://www.ptt.cc" + prev_link["href"]
                else: break
        except Exception as e: print("PTT Error:", e)
        return results

    @staticmethod
    def scrape_cnyes() -> List[Dict]:
        posts = []
        try:
            res = requests.get("https://api.cnyes.com/media/api/v1/newslist/category/bc?limit=30", timeout=5)
            data = res.json()
            items = data.get("items", {}).get("data", [])
            for item in items:
                title = item.get("title", "").strip()
                news_id = item.get("newsId")
                publish_at = item.get("publishAt")
                if title and news_id:
                    date_str = datetime.fromtimestamp(publish_at).strftime("%m/%d") if publish_at else datetime.now().strftime("%m/%d")
                    posts.append({"source": "CNYES", "title": title, "author": "鉅亨網", "date": date_str, "push": random.randint(30, 95), "link": f"https://news.cnyes.com/news/id/{news_id}", "content": item.get("summary", "鉅亨網區塊鏈新聞快訊")})
        except Exception as e: print("CNYES Error:", e)
        return posts

    @staticmethod
    def scrape_rss_for_signals() -> List[Dict]:
        posts = []
        for url in Config.RSS_FEEDS:
            try:
                feed = feedparser.parse(url)
                source_name = "外媒快訊"
                if "coindesk" in url: source_name = "CoinDesk"
                elif "cointelegraph" in url: source_name = "Cointelegraph"
                elif "decrypt" in url: source_name = "Decrypt"
                elif "cryptopotato" in url: source_name = "CryptoPotato"
                elif "bitcoin.com" in url: source_name = "Bitcoin.com"
                
                for e in feed.entries[:20]:  
                    summary = re.sub(r"<[^>]+>", " ", getattr(e, "summary", "") or "").strip()
                    if hasattr(e, 'published_parsed') and e.published_parsed:
                        date_str = time.strftime("%m/%d", e.published_parsed)
                    else:
                        date_str = datetime.now().strftime("%m/%d")
                    posts.append({"source": source_name, "title": getattr(e, "title", ""), "author": source_name, "date": date_str, "push": random.randint(40, 99), "link": getattr(e, "link", ""), "content": summary})
            except Exception as e: print("RSS Error:", e)
        return posts

    @staticmethod
    def analyze_posts(posts: List[Dict]) -> Dict:
        signals = []
        keyword_counts = {"BTC": 0, "ETH": 0, "SOL": 0, "BNB": 0, "AI": 0, "ETF": 0, "看漲": 0, "突破": 0, "大跌": 0}
        
        valid_posts = [p for p in posts if p.get('title')]
        
        for post in valid_posts:
            score = 50 if post.get('source') in ['CNYES', 'CoinDesk', 'Cointelegraph', 'Decrypt', 'CryptoPotato', 'Bitcoin.com'] else 0
            
            title = post.get('title', '')
            content = post.get('content') or ""
            full_text = title + " " + content
            
            for key in keyword_counts:
                if key in title.upper(): keyword_counts[key] += 1
            if any(header in title for header in SocialMediaEngine.STRONG_HEADERS): score += 30
            if any(kw in full_text for kw in SocialMediaEngine.SIGNAL_KEYWORDS): score += 20
            
            push_count = post.get('push') or 0
            if push_count > 20: score += 10
            
            post['quality_score'] = score
            post['sentiment'] = random.choice(['BULLISH', 'BEARISH', 'NEUTRAL']) if score >= 40 else 'NEUTRAL'
            post['type'] = 'signal'
            signals.append(post)

        signals.sort(key=lambda x: (x.get('date', ''), x.get('quality_score', 0)), reverse=True)
        sorted_kws = sorted(keyword_counts.items(), key=lambda x: x[1], reverse=True)
        top_kws = [k for k, v in sorted_kws if v > 0][:3]
        
        if top_kws:
            reason_text = f"根據全球超過 {len(signals)} 篇外媒與社群情報綜合分析，市場目前焦點高度集中在「{', '.join(top_kws)}」等板塊。<br>整體資金動能顯示出一定的支撐力道，建議投資人密切關注總經數據與機構動向，並做好風險控管。"
        else:
            reason_text = f"成功抓取 {len(signals)} 篇最新市場情報。<br>綜合多方新聞來源，目前市場情緒平穩，未見明顯恐慌或極端貪婪跡象，適合穩健佈局。"

        sentiment_score = 68
        if keyword_counts["大跌"] > keyword_counts["突破"]: sentiment_score = 35

        return {
            "sentiment_score": sentiment_score, 
            "signal_count": len(signals), 
            "noise_count": 0,
            "hot_keywords": sorted_kws, 
            "signals": signals,
            "noises": [], 
            "sentiment_reason": reason_text
        }

    @staticmethod
    @ttl_cache(ttl_seconds=600)
    def fetch_narratives_full() -> Dict:
        entries = []
        for url in Config.RSS_FEEDS:
            try:
                feed = feedparser.parse(url)
                for e in feed.entries[:15]: 
                    entries.append({
                        "title": getattr(e, "title", "") or "",
                        "summary": re.sub(r"<[^>]+>", " ", getattr(e, "summary", "") or "").strip(),
                        "link": getattr(e, "link", "") or "",
                        "published": getattr(e, "published", "") or ""
                    })
            except: pass
        
        scores = {name: 0 for name in Config.NARRATIVES}
        for e in entries:
            text = (e["title"] + " " + e["summary"]).lower()
            for name, data in Config.NARRATIVES.items():
                for kw in data["keywords"]:
                    scores[name] += text.count(kw.lower())
        
        top_narrative = max(scores, key=scores.get) if max(scores.values(), default=0) > 0 else None
        top_score = scores.get(top_narrative, 0) if top_narrative else 0

        text_all = " ".join([e["title"] + " " + e["summary"] for e in entries])
        wc_base64 = ""
        if text_all.strip():
            word_freqs = {}
            try:
                if client:
                    prompt = f"分析以下英文新聞，提取40個核心「加密貨幣趨勢與技術」詞彙並翻譯成繁體中文。回傳 JSON，格式為 {{\"詞彙\": 分數(10~100)}}：\n\n{text_all[:4000]}"
                    res = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}], response_format={"type": "json_object"})
                    word_freqs = json.loads(res.choices[0].message.content)
            except Exception as e:
                word_freqs = {"比特幣": 100, "以太幣": 85, "市場趨勢": 80, "區塊鏈": 75, "ETF": 95, "聯準會": 60, "機構資金": 80, "降息": 55, "牛市": 70, "波動": 45}

            font_path = "C:/Windows/Fonts/msjh.ttc" if os.path.exists("C:/Windows/Fonts/msjh.ttc") else None
            try:
                wc = WordCloud(width=1000, height=450, background_color="#f8fafc", colormap="tab20", font_path=font_path, max_words=60)
                if word_freqs: wc.generate_from_frequencies(word_freqs)
                else: wc.generate(text_all)
                fig, ax = plt.subplots(figsize=(10, 4.5))
                ax.imshow(wc, interpolation="bilinear")
                ax.axis("off")
                plt.tight_layout(pad=0)
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches='tight', transparent=True)
                plt.close(fig)
                buf.seek(0)
                wc_base64 = base64.b64encode(buf.read()).decode('utf-8')
            except Exception as e: pass

        top_coins_data = []
        if top_narrative:
            coins = Config.NARRATIVES[top_narrative]["coins"]
            for sym in coins:
                try:
                    ticker = yf.Ticker(sym)
                    hist = ticker.history(period="5d")
                    if hist is not None and len(hist) >= 2:
                        current_price = float(hist['Close'].iloc[-1])
                        price_24h_ago = float(hist['Close'].iloc[-2])
                        pct_change = (current_price - price_24h_ago) / price_24h_ago * 100
                        top_coins_data.append({"symbol": sym.replace("-USD", ""), "price": round(current_price, 4), "change": round(pct_change, 2)})
                    else:
                        top_coins_data.append({"symbol": sym.replace("-USD", ""), "price": None, "change": None})
                except Exception as e:
                    top_coins_data.append({"symbol": sym.replace("-USD", ""), "price": None, "change": None})

        related_news = []
        return {"scores": scores, "top_narrative": top_narrative, "top_score": top_score, "wordcloud": wc_base64, "top_coins": top_coins_data, "related_news": related_news}

# ==========================================
# 💼 3. Pydantic Models 
# ==========================================
Market = Literal["CRYPTO", "ALT", "US", "JP", "BTC", "RISK"]
Speaker = Literal["主持人", "分析師"]

class UserProfile(BaseModel):
    risk_level: Literal["conservative", "balanced", "aggressive"] = "balanced"
    topics: List[str] = Field(default_factory=lambda: ["ETH", "DeFi", "L2"])
    voice_style: Literal["serious", "casual"] = "serious"

class PodcastGenerateRequest(BaseModel):
    user_id: str = "demo_user"
    market: Market = "CRYPTO"
    profile: UserProfile = Field(default_factory=UserProfile)
    watchlist: List[str] = Field(default_factory=lambda: ["ETH", "BTC", "SOL"])
    market_snapshot: Dict[str, float] = Field(default_factory=dict)
    events: List[str] = Field(default_factory=list)
    use_coingecko: bool = True
    vs_currency: str = "usd"

class Line(BaseModel):
    speaker: Speaker
    text: str = Field(..., min_length=1, max_length=160)

class PodcastLLMOut(BaseModel):
    title: str = Field(..., min_length=5, max_length=80)
    bullets: List[str] = Field(..., min_length=3, max_length=5)
    lines: List[Line] = Field(..., min_length=14, max_length=28)

class TTSRequest(BaseModel):
    text: str
    voice: str = "nova"
    model: str = "gpt-4o-mini-tts"
    speed: float = 1.0

class Holding(BaseModel):
    ticker: str
    weight: float = Field(..., ge=0, le=1)

class RiskHealthRequest(BaseModel):
    user_id: str = "demo_user"
    base_currency: Literal["USD", "JPY", "TWD"] = "USD"
    holdings: List[Holding]
    days: int = 90
    vs_currency: str = "usd"
    use_live_prices: bool = True
    seed: int = 42

class PortfolioLLMOut(BaseModel):
    narrative: str
    highlights: List[str] = Field(default_factory=list)

# ==========================================
# 🚦 4. Flask Routes & APIs
# ==========================================
@app.route("/", methods=["GET"])
@app.route("/ui", methods=["GET"])
def home():
    return render_template("index.html")

@app.route('/market')
def market_page():
    return render_template('market.html')

@app.route('/analysis/<symbol>')
def analysis_page(symbol): 
    return render_template('analysis.html', symbol=symbol)

@app.route('/social-sentiment')
def social_sentiment_page(): 
    return render_template('social_sentiment.html')

@app.route('/ai-coach')
def ai_coach_page():
    return render_template('ai_coach.html')

@app.route('/agent')
def ai_agent_page():
    return render_template('agent.html')

@app.route('/scam-detect')
def scam_detect_page():
    return render_template('scam_detect.html')

@app.route('/health')
def health_page():
    return render_template('health.html')

@app.route('/podcast')
def podcast_page():
    return render_template('podcast.html')

@app.route('/register')
def register_page():
    return render_template('register.html')

@app.route('/sim-trade')
def sim_trade_page():
    return render_template('sim_trade.html')

@app.route('/api/coingecko')
@ttl_cache(ttl_seconds=Config.CACHE_TTL)
def live_data():
    crypto_list = DataManager.get_all_tickers()
    if not crypto_list: return jsonify({"timestamp": "", "data": []})
    history_df = DataManager.build_historical_df(crypto_list)
    for coin in crypto_list:
        symbol, price_usd = coin['symbol'], coin['price_usd']
        if symbol == 'BTC': coin['risk'] = {"level": "base", "msg": "市場基準", "corr": 1.0, "score": 0, "lambda": 0, "beta": 1}
        else: coin['risk'] = RiskModel.calculate_copula_risk(symbol, history_df, coin.get('is_stable', False), price_usd)
        if 'history_prices' in coin: del coin['history_prices']
    return jsonify({"timestamp": "", "data": crypto_list})

@app.route('/api/narratives')
def get_narratives():
    return jsonify(SocialMediaEngine.fetch_narratives_full())

@app.route('/api/social-data')
@ttl_cache(ttl_seconds=60) 
def get_social_data():
    all_posts = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        f1 = executor.submit(SocialMediaEngine.scrape_ptt)
        f2 = executor.submit(SocialMediaEngine.scrape_cnyes)
        f3 = executor.submit(SocialMediaEngine.scrape_rss_for_signals)
        try: all_posts.extend(f1.result() + f2.result() + f3.result())
        except: pass
    if not all_posts: return jsonify({"sentiment_score": 0, "signal_count": 0, "noise_count": 0, "hot_keywords": [], "signals": [], "noises": [], "sentiment_reason": "查無資料"})
    return jsonify(SocialMediaEngine.analyze_posts(all_posts))

@app.route('/api/details/<symbol>')
def get_coin_details(symbol):
    try:
        crypto_list = DataManager.get_all_tickers()
        target_coin = next((c for c in crypto_list if c['symbol'] == symbol), None)
        btc_coin = next((c for c in crypto_list if c['symbol'] == 'BTC'), None)
        if not target_coin or not btc_coin: return jsonify({"error": "No data"})

        prices = target_coin.get('history_prices', [])
        btc_prices = btc_coin.get('history_prices', [])
        min_len = min(len(prices), len(btc_prices))
        df = pd.DataFrame({'BTC': btc_prices[-min_len:], symbol: prices[-min_len:]})
        returns = df.pct_change().dropna()
        
        is_stable = symbol in Config.STABLE_COINS
        risk_data = RiskModel.calculate_copula_risk(symbol, df, is_stable, prices[-1]) if len(prices) > 0 else {}
        sim_data = MonteCarloEngine.simulate_price_paths(prices[-30:]) if len(prices) > 30 else {}
        
        return jsonify({
            "btc_returns": [0 if np.isnan(x) else x for x in returns['BTC'].tolist()],
            "coin_returns": [0 if np.isnan(x) else x for x in returns[symbol].tolist()],
            "dates": list(range(len(returns))),
            "simulation": sim_data,
            "risk_data": risk_data, 
            "ai_insights": {
                "sfi": AIAssistant.generate_sfi_insight(risk_data.get('score', 0)),
                "copula": AIAssistant.generate_copula_insight(risk_data.get('corr', 0), risk_data.get('lambda', 0)),
                "mc": AIAssistant.generate_mc_insight(prices[-1], sim_data.get('mean_path', [0])[-1] if sim_data else prices[-1], sim_data.get('volatility', 0) if sim_data else 0)
            }
        })
    except Exception as e: return jsonify({"error": str(e)})

@app.route("/crypto/popular", methods=["GET"])
def crypto_popular():
    vs_currency = request.args.get("vs_currency", "usd")
    per_page = int(request.args.get("per_page", 20))
    params = {"vs_currency": vs_currency, "order": "market_cap_desc", "per_page": per_page, "page": 1, "sparkline": "false"}
    data = DataManager._cg_get("/coins/markets", params) or []
    return jsonify([{"id": c.get("id"), "symbol": (c.get("symbol") or "").upper(), "name": c.get("name"), "current_price": c.get("current_price"), "price_change_percentage_24h": c.get("price_change_percentage_24h"), "market_cap_rank": c.get("market_cap_rank")} for c in data])

@app.route("/api/sfi/search", methods=["GET"])
def search_sfi_assets():
    query = request.args.get("q", "").strip()
    if not query: return jsonify({"data": []})
    return jsonify({"data": DataManager.search_sfi_assets(query)})

@app.route("/crypto/series", methods=["GET"])
def crypto_price_series():
    ticker = request.args.get("ticker", "ETH").upper()
    vs_currency = request.args.get("vs_currency", "usd")
    days = request.args.get("days", "30")
    cid = CG_ID_MAP.get(ticker, ticker.lower()) 
    try:
        data = DataManager._cg_get(f"/coins/{cid}/market_chart", {"vs_currency": vs_currency, "days": days}) or {}
        return jsonify({"ticker": ticker, "coin_id": cid, "vs": vs_currency, "days": days, "prices": data.get("prices", [])})
    except Exception: return jsonify({"ticker": ticker, "coin_id": cid, "vs": vs_currency, "days": days, "prices": []})

@app.route("/crypto/debug/snapshot", methods=["POST"])
def crypto_debug_snapshot():
    req_data = request.get_json(silent=True) or {}
    tickers = req_data.get("tickers", ["BTC", "ETH", "SOL", "XRP"])
    ids = [CG_ID_MAP.get(t.upper(), t.lower()) for t in tickers]
    data = DataManager._cg_get("/simple/price", {"ids": ",".join(ids), "vs_currencies": "usd", "include_24hr_change": "true"}) or {}
    return jsonify(data)

@app.route('/api/ta/<symbol>')
def get_ta(symbol):
    try:
        crypto_list = DataManager.get_all_tickers()
        target = next((c for c in crypto_list if c['symbol'] == symbol.upper()), None)
        prices = target.get('history_prices', []) if target else []
        if len(prices) < 50: return jsonify({"rsi": 50, "sma": 0, "ema": 0, "signal": "中立"})
        df = pd.DataFrame(prices, columns=['price'])
        delta = df['price'].diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / loss
        rsi = 100 - (100 / (1 + rs)).iloc[-1]
        sma = df['price'].rolling(window=50).mean().iloc[-1]
        ema = df['price'].ewm(span=20, adjust=False).mean().iloc[-1]
        current = prices[-1]
        score = 0
        if rsi < 30: score += 1
        elif rsi > 70: score -= 1
        if current > sma: score += 1
        else: score -= 1
        signal = "強買" if score >= 2 else "買入" if score == 1 else "賣出" if score == -1 else "強賣" if score <= -2 else "中立"
        return jsonify({"rsi": round(rsi, 2), "sma": round(sma, 2), "ema": round(ema, 2), "signal": signal})
    except Exception: return jsonify({"rsi": "--", "sma": "--", "ema": "--", "signal": "--"})

@app.route('/api/check-fomo', methods=['POST'])
def api_check_fomo():
    req = request.get_json(silent=True) or {}
    symbol = req.get("symbol", "BTC")
    try: p_change = float(req.get("price_change_24h", 0.0))
    except: p_change = 0.0
    if p_change > 15: return jsonify({"level": "HIGH", "message": f"{symbol} 24小時內暴漲 {p_change}%，目前進場追高風險極大！建議冷靜等待回調。"})
    elif p_change < -15: return jsonify({"level": "HIGH", "message": f"{symbol} 24小時內暴跌 {p_change}%，恐慌拋售情緒嚴重，小心接刀風險！"})
    elif p_change > 5: return jsonify({"level": "MEDIUM", "message": f"{symbol} 短期走勢偏強 (上漲 {p_change}%)，可考慮分批建倉，請嚴格設定止損。"})
    else: return jsonify({"level": "LOW", "message": f"{symbol} 波動平緩 ({p_change}%)，無明顯 FOMO 跡象，適合依紀律執行定投。"})

@app.route('/api/ai-chat', methods=['POST'])
@optional_token
def api_ai_chat():
    user_uid = request.user.get('uid') 
    req = request.get_json(silent=True) or {}
    user_msg = req.get("message", "")
    risk_profile = req.get("risk_profile", "穩健型") 
    if not client: return jsonify({"reply": "API Key 未設定，無法連線 AI。"})
    try:
        prompt = f"你是專業加密貨幣交易員。用戶目前的風險承受度為【{risk_profile}】。請根據這個風險屬性，用簡明扼要、專業的口吻回答用戶的投資問題。用戶提問：{user_msg}"
        res = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}])
        return jsonify({"reply": res.choices[0].message.content})
    except Exception as e: return jsonify({"reply": f"系統錯誤: {str(e)}"})

def parse_budget_amount(value: Any, default: float = 100000.0) -> float:
    text = str(value or "")
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return default
    return max(0.0, float(match.group(0).replace(",", "")))


def build_agent_allocation(profile: str, budget: Any) -> List[Dict[str, Any]]:
    amount = parse_budget_amount(budget)
    profile_text = str(profile or "")
    if "保守" in profile_text:
        weights = [("BTC", 0.55), ("ETH", 0.25), ("USDC", 0.20)]
    elif "積極" in profile_text or "激進" in profile_text:
        weights = [("BTC", 0.30), ("ETH", 0.25), ("SOL", 0.25), ("LINK", 0.10), ("USDC", 0.10)]
    else:
        weights = [("BTC", 0.40), ("ETH", 0.30), ("SOL", 0.20), ("USDC", 0.10)]
    return [
        {"symbol": symbol, "weight": weight, "amount_usd": round(amount * weight, 2)}
        for symbol, weight in weights
    ]


def get_coin_price_usd(symbol: str) -> float:
    symbol = symbol.upper()
    coin_id = CG_ID_MAP.get(symbol, symbol.lower())
    data = DataManager._cg_get(
        "/simple/price",
        {"ids": coin_id, "vs_currencies": "usd"},
    ) or {}
    price = data.get(coin_id, {}).get("usd")
    if price:
        return float(price)
    fallback = {"BTC": 65000, "ETH": 3200, "SOL": 150, "USDC": 1, "USDT": 1, "LINK": 15}
    return float(fallback.get(symbol, 10))


def get_sim_portfolio(user_id: str) -> Dict[str, Any]:
    if user_id not in SIM_PORTFOLIOS:
        SIM_PORTFOLIOS[user_id] = {
            "cash": SIM_INITIAL_CASH,
            "positions": {},
            "trades": [],
            "equity_curve": [{"timestamp": datetime.utcnow().isoformat(), "total_value_usd": SIM_INITIAL_CASH}],
        }
    return SIM_PORTFOLIOS[user_id]


def sim_snapshot(user_id: str) -> Dict[str, Any]:
    portfolio = get_sim_portfolio(user_id)
    cash = float(portfolio.get("cash", 0))
    positions = []
    total_value = cash
    for symbol, raw in portfolio.get("positions", {}).items():
        qty = float(raw.get("quantity", 0))
        if qty <= 0:
            continue
        current_price = get_coin_price_usd(symbol)
        avg_price = float(raw.get("avg_price", current_price))
        market_value = qty * current_price
        total_value += market_value
        positions.append({
            "symbol": symbol,
            "quantity": qty,
            "avg_price": avg_price,
            "current_price": current_price,
            "market_value": market_value,
            "unrealized_pnl": (current_price - avg_price) * qty,
        })
    unrealized_pnl = total_value - SIM_INITIAL_CASH
    pnl_pct = (unrealized_pnl / SIM_INITIAL_CASH * 100) if SIM_INITIAL_CASH else 0
    portfolio["equity_curve"].append({"timestamp": datetime.utcnow().isoformat(), "total_value_usd": total_value})
    portfolio["equity_curve"] = portfolio["equity_curve"][-80:]
    return {
        "cash": cash,
        "positions": positions,
        "total_value_usd": total_value,
        "unrealized_pnl": unrealized_pnl,
        "pnl_pct": pnl_pct,
        "equity_curve": portfolio["equity_curve"],
    }


def execute_sim_order(user_id: str, symbol: str, side: str, quantity: Optional[float] = None, amount_usd: Optional[float] = None) -> Dict[str, Any]:
    symbol = symbol.upper()
    side = side.lower()
    price = get_coin_price_usd(symbol)
    if amount_usd and not quantity:
        quantity = float(amount_usd) / price
    quantity = float(quantity or 0)
    amount = float(amount_usd or (quantity * price))
    if quantity <= 0 or amount <= 0:
        raise ValueError("請輸入有效的下單數量或金額。")

    portfolio = get_sim_portfolio(user_id)
    positions = portfolio["positions"]
    if side == "buy":
        if portfolio["cash"] < amount:
            raise ValueError("模擬帳戶現金不足。")
        current = positions.get(symbol, {"quantity": 0.0, "avg_price": 0.0})
        old_qty = float(current.get("quantity", 0))
        old_cost = old_qty * float(current.get("avg_price", 0))
        new_qty = old_qty + quantity
        positions[symbol] = {"quantity": new_qty, "avg_price": (old_cost + amount) / new_qty}
        portfolio["cash"] -= amount
    elif side == "sell":
        current = positions.get(symbol, {"quantity": 0.0, "avg_price": price})
        old_qty = float(current.get("quantity", 0))
        if old_qty < quantity:
            raise ValueError("持倉不足，無法賣出。")
        current["quantity"] = old_qty - quantity
        if current["quantity"] <= 0:
            positions.pop(symbol, None)
        else:
            positions[symbol] = current
        portfolio["cash"] += amount
    else:
        raise ValueError("下單方向只能是 buy 或 sell。")

    trade = {
        "timestamp": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "symbol": symbol,
        "side": side,
        "price": price,
        "quantity": quantity,
        "amount_usd": amount,
    }
    portfolio["trades"].insert(0, trade)
    portfolio["trades"] = portfolio["trades"][:100]
    return trade


@app.route("/api/sim-trade/portfolio", methods=["GET"])
@token_required
def api_sim_trade_portfolio():
    with SIM_LOCK:
        return jsonify({"portfolio": sim_snapshot(request.user["uid"])})


@app.route("/api/sim-trade/history", methods=["GET"])
@token_required
def api_sim_trade_history():
    limit = int(request.args.get("limit", 50))
    with SIM_LOCK:
        portfolio = get_sim_portfolio(request.user["uid"])
        return jsonify({"trades": portfolio.get("trades", [])[:limit]})


@app.route("/api/sim-trade/order", methods=["POST"])
@token_required
def api_sim_trade_order():
    req = request.get_json(silent=True) or {}
    try:
        with SIM_LOCK:
            trade = execute_sim_order(
                request.user["uid"],
                req.get("symbol", "BTC"),
                req.get("side", "buy"),
                req.get("quantity"),
                req.get("amount_usd"),
            )
            return jsonify({"success": True, "trade": trade, "portfolio": sim_snapshot(request.user["uid"])})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/sim-trade/reset", methods=["POST"])
@token_required
def api_sim_trade_reset():
    with SIM_LOCK:
        SIM_PORTFOLIOS.pop(request.user["uid"], None)
        return jsonify({"success": True, "portfolio": sim_snapshot(request.user["uid"])})


@app.route('/api/agent-plan', methods=['POST'])
@token_required
def api_agent_plan():
    req = request.get_json(silent=True) or {}
    goal = (req.get("goal") or "").strip()
    profile = (req.get("profile") or "穩健型").strip()
    budget = (req.get("budget") or "未設定").strip()

    if not goal:
        return jsonify({"error": "請先輸入要交給 Agent 的任務。"}), 400

    fallback = {
        "summary": f"已根據「{goal[:42]}」整理出初步行動計畫",
        "allocation": build_agent_allocation(profile, budget),
        "steps": [
            "先確認任務目標、可投入資金與風險承受度，避免一開始就直接下單。",
            "到市場總覽檢查主流幣價格、24 小時漲跌與技術指標，判斷目前是否過熱。",
            "建立一組試算配置，並到健康度檢查查看 Top1、Top3 集中度、波動與最大回撤。",
            "如果任一幣種占比過高，先降低單一標的權重，再保留現金或穩定幣作為緩衝。",
            "最後把計畫轉成 1 到 3 個今天能執行的行動，例如觀察、分批、或暫緩。"
        ],
        "risks": [
            "不要因為短線上漲就一次投入全部資金，追高會放大回撤壓力。",
            "若配置集中在少數高波動幣種，帳面損益可能在短時間快速變化。",
            "AI Agent 只能提供決策輔助，仍需搭配即時市場資料與自己的資金狀況判斷。"
        ],
        "next_action": "建議先到市場總覽確認目前價格與漲跌，再把預算輸入健康度檢查做一次配置試算。"
    }

    if not client:
        return jsonify(fallback)

    try:
        prompt = f"""
你是 Smart Invest 的加密資產 AI Agent。請把使用者任務拆成新手也看得懂、可以今天執行的行動計畫。

使用者任務：{goal}
投資風格：{profile}
預算或資金範圍：{budget}

請只輸出 JSON，格式如下：
{{
  "summary": "一句話總結這次任務與建議方向",
  "steps": ["步驟1", "步驟2", "步驟3", "步驟4", "步驟5"],
  "risks": ["風險1", "風險2", "風險3"],
  "next_action": "最建議使用者下一步立刻做什麼",
  "allocation": [
    {"symbol": "BTC", "weight": 0.4, "amount_usd": 40000},
    {"symbol": "ETH", "weight": 0.3, "amount_usd": 30000}
  ]
}}
"""
        res = client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL_AGENT", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "你是專業但易懂的加密資產投資助理。重點是風險控管、分步執行、避免追高，不提供保證獲利承諾。"},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.35,
        )
        parsed = json.loads(res.choices[0].message.content or "{}")
        return jsonify({
            "summary": parsed.get("summary") or fallback["summary"],
            "steps": parsed.get("steps") or fallback["steps"],
            "risks": parsed.get("risks") or fallback["risks"],
            "next_action": parsed.get("next_action") or fallback["next_action"],
            "allocation": parsed.get("allocation") or fallback["allocation"],
        })
    except Exception as e:
        fallback["debug"] = str(e)
        return jsonify(fallback)


@app.route('/api/agent-auto-order', methods=['POST'])
@token_required
def api_agent_auto_order():
    req = request.get_json(silent=True) or {}
    raw_allocation = req.get("allocation") or build_agent_allocation(
        req.get("profile", "穩健型"),
        req.get("budget", "100000"),
    )

    cleaned_allocation = []
    for item in raw_allocation:
        try:
            symbol = str(item.get("symbol", "")).upper().strip()
            amount = float(item.get("amount_usd") or 0)
        except Exception:
            continue
        if symbol and amount > 0:
            cleaned_allocation.append({"symbol": symbol, "amount_usd": amount})

    if not cleaned_allocation:
        return jsonify({"error": "Agent 尚未產生有效的推薦配置。"}), 400

    try:
        with SIM_LOCK:
            snapshot = sim_snapshot(request.user["uid"])
            available_cash = float(snapshot.get("cash", 0))
            planned_total = sum(item["amount_usd"] for item in cleaned_allocation)
            scale = min(1.0, available_cash / planned_total) if planned_total > 0 else 0
            if scale <= 0:
                return jsonify({"error": "模擬帳戶現金不足，請先重置或調整配置。"}), 400

            trades = []
            for item in cleaned_allocation:
                order_amount = round(item["amount_usd"] * scale, 2)
                if order_amount <= 0:
                    continue
                trades.append(execute_sim_order(
                    request.user["uid"],
                    item["symbol"],
                    "buy",
                    amount_usd=order_amount,
                ))

            return jsonify({
                "success": True,
                "scaled": scale < 1.0,
                "scale": scale,
                "trades": trades,
                "portfolio": sim_snapshot(request.user["uid"]),
            })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

@app.route('/api/scam-scan', methods=['POST'])
def api_scam_scan():
    req = request.get_json(silent=True) or {}
    text = req.get("text", "")
    if not client: return jsonify({"report": "API Key 未設定，無法連線 AI。"})
    try:
        prompt = f"你是金融反詐騙專家。請分析以下內容是否有加密貨幣詐騙風險。請輸出：1.風險等級(高/中/低) 2.疑點解析 3.防範建議。\n內容：{text}"
        res = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}])
        return jsonify({"report": res.choices[0].message.content})
    except Exception as e: return jsonify({"report": f"系統錯誤: {str(e)}"})

@app.route("/podcast/generate", methods=["POST"])
def generate_podcast():
    try: req = PodcastGenerateRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    prompt = f"市場={req.market}\n風險={req.profile.risk_level}\n關注清單={req.watchlist}\n事件={req.events}\n請用口語播報市場與配置重點。"
    try:
        if not client: raise RuntimeError("NO KEY")
        completion = client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), 
            messages=[{"role": "system", "content": "你是加密貨幣晨報 Podcast 主持人與分析師。輸出 JSON。"}, {"role": "user", "content": prompt}],
            response_format=PodcastLLMOut
        )
        out = completion.choices[0].message.parsed
        lines = out.lines
        estimated_seconds = max(35, int(sum(len(l.text) for l in lines) / 3.0))
        return jsonify({"title": out.title, "bullets": out.bullets, "script": "\n".join([f"{l.speaker}：{l.text}" for l in lines]), "estimated_seconds": estimated_seconds, "lines": [l.model_dump() for l in lines]})
    except Exception as e: return jsonify({"title": "預設晨報", "bullets": ["無法連線 AI"], "script": "主持人：連線失敗", "estimated_seconds": 60, "lines": [{"speaker":"主持人","text":"連線失敗，請檢查金鑰或額度。"}]})

@app.route("/podcast/tts", methods=["POST"])
def podcast_tts():
    if not client: return jsonify({"detail": "OPENAI_API_KEY not set"}), 503
    try: req = TTSRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    clean = re.sub(r"^(主持人|分析師)：", "", req.text, flags=re.MULTILINE).strip()[:3800]
    filename = f"podcast_{date.today().isoformat()}.mp3"
    out_path = AUDIO_DIR / filename
    try:
        with client.audio.speech.with_streaming_response.create(model="tts-1", voice=req.voice, input=clean, speed=req.speed, response_format="mp3") as response:
            response.stream_to_file(out_path)
    except Exception as e: return jsonify({"detail": f"TTS failed: {type(e).__name__}"}), 502
    return send_file(out_path, mimetype="audio/mpeg", as_attachment=True, download_name=filename)

@app.route("/portfolio/analyze-llm", methods=["POST"])
def analyze_portfolio_llm():
    try: req = RiskHealthRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    weights = [h.weight for h in req.holdings]
    total, top1, top3 = sum(weights), sorted(weights, reverse=True)[0] if weights else 0, sum(sorted(weights, reverse=True)[:3]) if weights else 0
    vol, mdd = (random.uniform(0.3, 0.8) if weights else 0), (random.uniform(0.1, 0.4) if weights else 0)
    rh_dict = {"top1_weight": top1, "top3_weight": top3, "annual_vol": vol, "max_drawdown": mdd, "herfindahl": sum(w*w for w in weights)}
    if client is None: return jsonify({"risk_health": rh_dict, "narrative": "未設定金鑰，改用規則摘要。請注意波動風險。", "highlights": ["提醒：無 AI 金鑰"]})
    holdings_text = ", ".join([f"{h.ticker}({h.weight:.2f})" for h in req.holdings])
    prompt = f"請用非常白話的中文分析配置：\n【持幣】{holdings_text}\n【指標】Top1={top1:.2f}, 年化波動={vol:.2f}, 最大回撤={mdd:.2f}"
    try:
        completion = client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_MODEL_PORTFOLIO", "gpt-4o-mini"),
            messages=[{"role": "system", "content": "你是專業的加密貨幣財富管理顧問。"}, {"role": "user", "content": prompt}],
            response_format=PortfolioLLMOut
        )
        out = completion.choices[0].message.parsed
        return jsonify({"risk_health": rh_dict, "narrative": out.narrative, "highlights": out.highlights or []})
    except Exception as e: return jsonify({"risk_health": rh_dict, "narrative": "LLM 分析連線失敗，請檢查金鑰。", "highlights": ["連線異常"]})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
