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
import uuid
import wave
import hashlib
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple
from functools import wraps
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd
import numpy as np
import feedparser
import yfinance as yf
<<<<<<< HEAD
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except Exception:
    plt = None

try:
    from wordcloud import WordCloud
except Exception:
    WordCloud = None
=======
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except Exception:
    plt = None

try:
    from wordcloud import WordCloud
except Exception:
    WordCloud = None
>>>>>>> origin/0709
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify, send_file, abort, render_template
from flask_cors import CORS
from pydantic import BaseModel, Field, ValidationError
from openai import OpenAI
from dotenv import load_dotenv

<<<<<<< HEAD
=======
# ── RAG / AI Services ──────────────────────────────────────
try:
    from services.rag_service import get_rag
    _rag = get_rag()
    _rag_available = _rag.kb_loaded
except Exception as _rag_exc:
    _rag = None
    _rag_available = False

>>>>>>> origin/0709
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
SIM_INITIAL_CASH = 100000.0
SIM_DATA_FILE = DATA_DIR / "sim_trade_local.json"
SIM_DATA_LOCK = Lock()

<<<<<<< HEAD
class Config:
    CG_API_KEY: str = os.getenv("CG_API_KEY", "")
    CACHE_TTL: int = 300 
    MARKET_COIN_LIMIT: int = int(os.getenv("MARKET_COIN_LIMIT", "24"))
    SFI_COIN_LIMIT: int = int(os.getenv("SFI_COIN_LIMIT", "20"))
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
=======
class Config:
    CG_API_KEY: str = os.getenv("CG_API_KEY", "")
    CACHE_TTL: int = 300 
    MARKET_COIN_LIMIT: int = int(os.getenv("MARKET_COIN_LIMIT", "24"))
    SFI_COIN_LIMIT: int = int(os.getenv("SFI_COIN_LIMIT", "20"))
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
>>>>>>> origin/0709
    
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
<<<<<<< HEAD
=======
    SIM_STRATEGY_PRESETS = {
        "conservative": {
            "label": "保守型",
            "btc_eth_min_pct": 0.70,
            "single_coin_max_pct": 0.10,
            "stable_min_pct": 0.30,
            "max_drawdown_warn": 0.10,
        },
        "balanced": {
            "label": "穩健型",
            "btc_eth_min_pct": 0.50,
            "single_coin_max_pct": 0.20,
            "stable_min_pct": 0.15,
            "max_drawdown_warn": 0.20,
        },
        "aggressive": {
            "label": "積極型",
            "btc_eth_min_pct": 0.30,
            "single_coin_max_pct": 0.35,
            "stable_min_pct": 0.05,
            "max_drawdown_warn": 0.35,
        },
    }
    MARKET_SCENARIOS = {
        "bull": {"price_multiplier": 1.3, "volatility_multiplier": 0.8, "label": "牛市"},
        "bear": {"price_multiplier": 0.7, "volatility_multiplier": 1.5, "label": "熊市"},
        "black_swan": {"price_multiplier": 0.4, "volatility_multiplier": 3.0, "label": "黑天鵝"},
    }
>>>>>>> origin/0709

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

def refresh_openai_client() -> Optional[OpenAI]:
    global client
    load_dotenv(override=True)
    latest_key = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
    if latest_key == Config.OPENAI_API_KEY:
        return client
    Config.OPENAI_API_KEY = latest_key
    client = OpenAI(api_key=latest_key) if latest_key and "sk-" in latest_key else None
    return client

def is_openai_auth_error(error: Exception) -> bool:
    text = str(error).lower()
    return (
        getattr(error, "status_code", None) == 401
        or error.__class__.__name__ == "AuthenticationError"
        or "incorrect api key" in text
        or "invalid api key" in text
    )

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

def sim_user_key(access_token: str) -> str:
    if access_token == DEMO_MEMBER_TOKEN:
        return "demo-member"
    digest = hashlib.sha256(str(access_token).encode("utf-8")).hexdigest()
    return f"user-{digest[:24]}"

def load_local_sim_store() -> Dict[str, Any]:
    with SIM_DATA_LOCK:
        try:
            if SIM_DATA_FILE.exists():
                data = json.loads(SIM_DATA_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
        except Exception as exc:
            print(f"Local sim store read failed: {exc}")
        return {"users": {}}

def save_local_sim_store(store: Dict[str, Any]) -> None:
    with SIM_DATA_LOCK:
        SIM_DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        SIM_DATA_FILE.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")

def default_local_sim_state(user_key: str, initial_cash: float = SIM_INITIAL_CASH) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    portfolio_id = f"local-{user_key}"
    return {
        "portfolio": {
            "id": portfolio_id,
            "user_id": user_key,
            "cash_balance": float(initial_cash),
            "initial_cash": float(initial_cash),
        },
        "positions": {},
        "trades": [],
        "equity_curve": [{
            "ts": now,
            "total_value_usd": float(initial_cash),
            "cash_balance": float(initial_cash),
        }],
        "capital_records": [{
            "id": str(uuid.uuid4()),
            "timestamp": now,
            "amount_usd": float(initial_cash),
            "note": "Demo 初始資金",
        }],
    }

def get_local_sim_state(access_token: str, initial_cash: float = SIM_INITIAL_CASH) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    user_key = sim_user_key(access_token)
    store = load_local_sim_store()
    users = store.setdefault("users", {})
    if user_key not in users:
        users[user_key] = default_local_sim_state(user_key, initial_cash)
        save_local_sim_store(store)
    return user_key, users[user_key], store

def local_sim_preferred(access_token: str) -> bool:
    if access_token == DEMO_MEMBER_TOKEN:
        return True
    user_key = sim_user_key(access_token)
    store = load_local_sim_store()
    state = (store.get("users") or {}).get(user_key) or {}
    return bool(state.get("prefer_local"))

def local_position_rows(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for symbol, pos in (state.get("positions") or {}).items():
        qty = float(pos.get("quantity") or 0)
        if qty > 0:
            rows.append({
                "symbol": symbol,
                "quantity": qty,
                "avg_price": float(pos.get("avg_price") or 0),
            })
    return sorted(rows, key=lambda row: row["symbol"])

def append_local_equity_point(state: Dict[str, Any], total_value: float, cash: float) -> None:
    curve = state.setdefault("equity_curve", [])
    curve.append({
        "ts": datetime.utcnow().isoformat(),
        "total_value_usd": float(total_value),
        "cash_balance": float(cash),
    })
    del curve[:-80]

def local_execute_sim_order(
    access_token: str,
    symbol: str,
    side: str,
    price: float,
    quantity: float,
    amount: float,
) -> Dict[str, Any]:
    _, state, store = get_local_sim_state(access_token)
    state["prefer_local"] = True
    portfolio = state.get("portfolio") or {}
    position_rows = local_position_rows(state)
    total_value = estimate_total_value_after_order(portfolio, position_rows, symbol, side, quantity, amount)
    cash = float(portfolio.get("cash_balance") or 0)
    positions = state.setdefault("positions", {})
    current = positions.get(symbol, {"quantity": 0.0, "avg_price": 0.0})
    old_qty = float(current.get("quantity") or 0)
    old_avg = float(current.get("avg_price") or 0)

    if side == "buy":
        new_qty = old_qty + quantity
        new_avg = ((old_qty * old_avg) + amount) / new_qty if new_qty > 0 else 0
        positions[symbol] = {"quantity": new_qty, "avg_price": new_avg}
        cash -= amount
    elif side == "sell":
        new_qty = old_qty - quantity
        cash += amount
        if new_qty <= 0:
            positions.pop(symbol, None)
        else:
            positions[symbol] = {"quantity": new_qty, "avg_price": old_avg}

    portfolio["cash_balance"] = cash
    trade = {
        "timestamp": datetime.utcnow().isoformat(),
        "symbol": symbol,
        "side": side,
        "price": price,
        "quantity": quantity,
        "amount_usd": amount,
    }
    state.setdefault("trades", []).insert(0, trade)
    del state["trades"][200:]
    append_local_equity_point(state, total_value, cash)
    save_local_sim_store(store)
    return trade

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
            request.user = {**DEMO_MEMBER_USER.copy(), "token": None, "is_demo": True}
            return f(*args, **kwargs)
        try:
            if not db: return jsonify({'error': '登入服務暫時不可用', 'code': 'auth/service-unavailable'}), 503
            user_response = db.client.auth.get_user(token)
            user = getattr(user_response, 'user', None)
            if not user: return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
            request.user = {'uid': user.id, 'email': user.email, 'token': token, 'is_demo': False}
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
            request.user = {'uid': 'guest', 'email': None, 'is_guest': True, 'token': None}
            return f(*args, **kwargs)
        if token == DEMO_MEMBER_TOKEN:
            request.user = {**DEMO_MEMBER_USER.copy(), "token": None, "is_demo": True}
            return f(*args, **kwargs)
        try:
            if not db: return jsonify({'error': '登入服務暫時不可用', 'code': 'auth/service-unavailable'}), 503
            user_response = db.client.auth.get_user(token)
            user = getattr(user_response, 'user', None)
            if not user: return jsonify({'error': '憑證無效或已過期', 'code': 'auth/invalid-token'}), 401
            request.user = {'uid': user.id, 'email': user.email, 'is_guest': False, 'token': token, 'is_demo': False}
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

<<<<<<< HEAD
    @staticmethod
    @ttl_cache(ttl_seconds=Config.CACHE_TTL)
    def get_all_tickers() -> List[Dict]:
        tickers = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": Config.SFI_COIN_LIMIT, "page": 1, "sparkline": "true"})
        if not tickers: return []
        final_list = []
=======
    @staticmethod
    @ttl_cache(ttl_seconds=Config.CACHE_TTL)
    def get_all_tickers() -> List[Dict]:
        tickers = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": Config.SFI_COIN_LIMIT, "page": 1, "sparkline": "true"})
        if not tickers: return []
        final_list = []
>>>>>>> origin/0709
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
<<<<<<< HEAD
            for idx, t in enumerate(tickers):
                final_list.append(DataManager._market_coin_to_entry(t, rank=idx + 1))
        return final_list

    @staticmethod
    @ttl_cache(ttl_seconds=Config.CACHE_TTL)
    def get_market_tickers() -> List[Dict]:
        tickers = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": Config.MARKET_COIN_LIMIT, "page": 1, "sparkline": "false"})
        if not tickers: return []
        return [DataManager._market_coin_to_entry(t, rank=idx + 1) for idx, t in enumerate(tickers)]
=======
            for idx, t in enumerate(tickers):
                final_list.append(DataManager._market_coin_to_entry(t, rank=idx + 1))
        return final_list

    @staticmethod
    @ttl_cache(ttl_seconds=Config.CACHE_TTL)
    def get_market_tickers() -> List[Dict]:
        tickers = DataManager._cg_get("/coins/markets", {"vs_currency": "usd", "order": "market_cap_desc", "per_page": Config.MARKET_COIN_LIMIT, "page": 1, "sparkline": "false"})
        if not tickers: return []
        return [DataManager._market_coin_to_entry(t, rank=idx + 1) for idx, t in enumerate(tickers)]
>>>>>>> origin/0709

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

AI_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_crypto_price",
            "description": "Get the latest USD price for a crypto symbol using CoinGecko.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "Crypto symbol, e.g. BTC, ETH, SOL",
                    }
                },
                "required": ["symbol"],
            },
        },
    }
]

def _resolve_coin_id(symbol: str) -> str:
    symbol = (symbol or "").strip().upper()
    if not symbol:
        return ""
    if symbol in CG_ID_MAP:
        return CG_ID_MAP[symbol]
    search_hits = DataManager.search_sfi_assets(symbol)
    if search_hits:
        return search_hits[0].get("id") or symbol.lower()
    return symbol.lower()

def get_crypto_price(symbol: str) -> Dict[str, Any]:
    symbol = (symbol or "").strip().upper()
    if not symbol:
        return {"ok": False, "error": "symbol is required"}
    coin_id = _resolve_coin_id(symbol)
    if not coin_id:
        return {"ok": False, "error": "symbol not found", "symbol": symbol}
    payload = DataManager._cg_get(
        "/simple/price",
        {"ids": coin_id, "vs_currencies": "usd", "include_24hr_change": "true"},
    ) or {}
    raw = payload.get(coin_id) or {}
    price = raw.get("usd")
    change = raw.get("usd_24h_change")
    if price is None:
        return {"ok": False, "error": "price not found", "symbol": symbol, "coin_id": coin_id}
    return {
        "ok": True,
        "symbol": symbol,
        "coin_id": coin_id,
        "price_usd": float(price),
        "change_24h": float(change) if change is not None else None,
        "source": "coingecko",
    }

def build_ai_system_prompt(risk_profile: str) -> str:
    profile = (risk_profile or "穩健型").strip() or "穩健型"
    return (
        "你是專業加密貨幣交易員。"
        f"用戶目前的風險承受度為【{profile}】。"
        "請根據風險屬性，用簡明扼要、專業的口吻回答用戶的投資問題。"
    )

def map_history_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    for row in rows or []:
        role = (row.get("message_type") or "").strip()
        content = row.get("content") or ""
        if role not in {"user", "assistant", "system"}:
            continue
        messages.append({"role": role, "content": content})
    return messages

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
    PTT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", ";Not A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }

    @staticmethod
    def _build_ptt_session() -> requests.Session:
        session = requests.Session()
        session.headers.update(SocialMediaEngine.PTT_HEADERS)
        session.cookies.set("over18", "1")
        return session

    @staticmethod
    def _get_ptt_response(url: str, session: Optional[requests.Session] = None, timeout: float = 5, max_retries: int = 3):
        active_session = session or SocialMediaEngine._build_ptt_session()
        for attempt in range(1, max_retries + 1):
            try:
                response = active_session.get(url, timeout=timeout)
                response.raise_for_status()
                time.sleep(random.uniform(2, 4))
                return response
            except (requests.ConnectionError, requests.Timeout, ConnectionResetError) as error:
                if attempt >= max_retries:
                    print(f"PTT Error: {error}")
                    return None
                time.sleep(5)
            except requests.RequestException as error:
                print(f"PTT Error: {error}")
                return None
            except Exception as error:
                print(f"PTT Error: {error}")
                return None
        return None

    @staticmethod
    def get_content_summary(url: str) -> str:
        try:
            res = SocialMediaEngine._get_ptt_response(url, timeout=1.5)
            if not res:
                return ""
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
            session = SocialMediaEngine._build_ptt_session()
            url = "https://www.ptt.cc/bbs/DigiCurrency/index.html"
            for _ in range(2):
                res = SocialMediaEngine._get_ptt_response(url, session=session, timeout=5)
                if not res:
                    break
                soup = BeautifulSoup(res.text, "html.parser")
                divs = soup.find_all("div", class_="r-ent")[:15]
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
                    res = client.chat.completions.create(model=os.getenv("OPENAI_MODEL", "gpt-5.4"), messages=[{"role": "user", "content": prompt}], response_format={"type": "json_object"})
                    word_freqs = json.loads(res.choices[0].message.content)
            except Exception as e:
                word_freqs = {"比特幣": 100, "以太幣": 85, "市場趨勢": 80, "區塊鏈": 75, "ETF": 95, "聯準會": 60, "機構資金": 80, "降息": 55, "牛市": 70, "波動": 45}

            font_path = "C:/Windows/Fonts/msjh.ttc" if os.path.exists("C:/Windows/Fonts/msjh.ttc") else None
            buf = None
<<<<<<< HEAD
            try:
                if WordCloud is not None and plt is not None:
                    wc = WordCloud(width=1000, height=450, background_color="#f8fafc", colormap="tab20", font_path=font_path, max_words=60)
                    if word_freqs: wc.generate_from_frequencies(word_freqs)
                    else: wc.generate(text_all)
                    fig, ax = plt.subplots(figsize=(10, 4.5))
                    ax.imshow(wc, interpolation="bilinear")
                    ax.axis("off")
                    plt.tight_layout(pad=0)
                    buf = io.BytesIO()
                    fig.savefig(buf, format="png", bbox_inches="tight", transparent=True)
                    buf.seek(0)
                    wc_base64 = base64.b64encode(buf.read()).decode("utf-8")
            except Exception:
                pass
            finally:
                if buf is not None:
                    buf.close()
                if plt is not None:
                    plt.close("all")
=======
            try:
                if WordCloud is not None and plt is not None:
                    wc = WordCloud(width=1000, height=450, background_color="#f8fafc", colormap="tab20", font_path=font_path, max_words=60)
                    if word_freqs: wc.generate_from_frequencies(word_freqs)
                    else: wc.generate(text_all)
                    fig, ax = plt.subplots(figsize=(10, 4.5))
                    ax.imshow(wc, interpolation="bilinear")
                    ax.axis("off")
                    plt.tight_layout(pad=0)
                    buf = io.BytesIO()
                    fig.savefig(buf, format="png", bbox_inches="tight", transparent=True)
                    buf.seek(0)
                    wc_base64 = base64.b64encode(buf.read()).decode("utf-8")
            except Exception:
                pass
            finally:
                if buf is not None:
                    buf.close()
                if plt is not None:
                    plt.close("all")
>>>>>>> origin/0709

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
        return {"narrative_scores": scores, "top_narrative": top_narrative, "top_score": top_score, "wordcloud": wc_base64, "top_coins": top_coins_data, "related_news": related_news}

# ==========================================
# 💼 3. Pydantic Models 
# ==========================================
Market = Literal["CRYPTO", "ALT", "US", "JP", "BTC", "RISK", "PERSONAL"]
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
    portfolio_summary: Dict[str, Any] = Field(default_factory=dict)
    use_coingecko: bool = True
    vs_currency: str = "usd"

class Line(BaseModel):
    speaker: Speaker
    text: str = Field(..., min_length=1, max_length=160)

class PodcastLLMOut(BaseModel):
    title: str = Field(..., min_length=5, max_length=80)
    bullets: List[str] = Field(..., min_length=3, max_length=5)
    lines: List[Line] = Field(..., min_length=14, max_length=28)

class ScamScanResult(BaseModel):
    risk_level: Literal["high", "medium", "low"]
    report: str = Field(..., min_length=1)

def build_fallback_podcast(req: PodcastGenerateRequest) -> Dict[str, Any]:
    topic_map = {
        "CRYPTO": "整體市場快報",
        "ALT": "新興幣市場快報",
        "BTC": "BTC 盤勢晨報",
        "RISK": "風險提醒特輯",
        "PERSONAL": "專屬資產 Podcast",
        "US": "美股市場快報",
        "JP": "日股市場快報",
    }
    topic = topic_map.get(req.market, "市場快報")
    watchlist = [str(s).upper() for s in (req.watchlist or ["BTC", "ETH", "SOL"])][:4]
    focus = "、".join(watchlist)
    lines = [
        {"speaker": "主持人", "text": f"歡迎收聽 Smart Invest，今天這集是{topic}。"},
        {"speaker": "分析師", "text": f"這集會先用比較白話的方式看 {focus}，重點放在趨勢、風險和下一步。"},
        {"speaker": "主持人", "text": "如果市場短線波動很大，第一件事不是追價，而是先確認自己的配置比例。"},
        {"speaker": "分析師", "text": "對，新手最常見的風險是單一幣種太集中，或是在上漲後一次投入太多。"},
        {"speaker": "主持人", "text": "所以今天的重點可以拆成三個：先看方向、再看風險、最後才決定要不要模擬下單。"},
        {"speaker": "分析師", "text": "如果你看到 24 小時漲幅很大，建議先用健康度檢查或 FOMO 檢測確認是不是過熱。"},
        {"speaker": "主持人", "text": "對於還不確定的標的，可以先放進觀察清單，不一定要立刻買。"},
        {"speaker": "分析師", "text": "保守一點的做法，是用 BTC 和 ETH 當核心，再少量觀察波動較大的幣種。"},
        {"speaker": "主持人", "text": "如果想練習操作，可以先到模擬交易，用小額虛擬資金測試進出場節奏。"},
        {"speaker": "分析師", "text": "模擬交易的重點不是猜中一次，而是看自己遇到漲跌時會不會失控。"},
        {"speaker": "主持人", "text": "總結一下，今天先不要急著追高，先把市場方向和配置風險看清楚。"},
        {"speaker": "分析師", "text": "沒錯，等風險可控，再用分批方式建立部位，會比一次 All in 更穩。"},
        {"speaker": "主持人", "text": "這集就到這裡，下一步可以回市場總覽或健康度檢查繼續看。"},
        {"speaker": "分析師", "text": "記得，AI 只是輔助整理，真正下決策前還是要看自己的資金和風險承受度。"},
    ]
    if req.market == "PERSONAL" and req.portfolio_summary:
        total = float(req.portfolio_summary.get("total_value_usd") or 0)
        cash = float(req.portfolio_summary.get("cash") or 0)
        raw_positions = req.portfolio_summary.get("positions") or []
        position_text = "、".join([
            f"{str(pos.get('symbol') or '').upper()} 約 {float(pos.get('market_value') or 0):,.0f} 美元"
            for pos in raw_positions[:4] if pos.get("symbol")
        ]) or "目前尚未投入幣種"
        lines[1:1] = [
            {"speaker": "分析師", "text": f"先看你的模擬帳戶，目前總資產約 {total:,.0f} 美元，保留現金約 {cash:,.0f} 美元。"},
            {"speaker": "主持人", "text": f"目前投入的幣種摘要是 {position_text}，我們會把這個配置放進今天的觀察裡。"},
        ]
    return {
        "title": topic,
        "bullets": ["先看市場方向", "確認配置風險", "用模擬交易練習"],
        "script": "\n".join([f"{line['speaker']}：{line['text']}" for line in lines]),
        "estimated_seconds": 80,
        "lines": lines,
        "fallback": True,
    }

class TTSRequest(BaseModel):
    text: str = ""
    lines: List[Line] = Field(default_factory=list)
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


def _resolve_yahoo_ticker(symbol: str) -> str:
    clean_symbol = str(symbol or "").strip().upper()
    if not clean_symbol:
        return ""
    if clean_symbol.endswith("-USD") or clean_symbol.endswith("-USDT"):
        return clean_symbol
    return f"{clean_symbol}-USD"


def _parse_positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _normalize_price_series(points: Any) -> List[List[float]]:
    normalized: List[List[float]] = []
    for point in points or []:
        timestamp = None
        price = None

        if isinstance(point, (list, tuple)) and len(point) >= 2:
            timestamp, price = point[0], point[1]
        elif isinstance(point, dict):
            timestamp = point.get("timestamp") or point.get("time") or point.get("date")
            price = point.get("price") or point.get("close")

        try:
            timestamp_ms = int(float(timestamp))
            price_value = float(price)
        except (TypeError, ValueError):
            continue

        if not np.isfinite(price_value):
            continue
        normalized.append([timestamp_ms, price_value])

    normalized.sort(key=lambda item: item[0])

    deduped: List[List[float]] = []
    seen_timestamps = set()
    for timestamp, price in normalized:
        if timestamp in seen_timestamps:
            continue
        seen_timestamps.add(timestamp)
        deduped.append([timestamp, price])

    return deduped


def _fetch_yfinance_series(symbol: str, days: int) -> List[List[float]]:
    yahoo_symbol = _resolve_yahoo_ticker(symbol)
    if not yahoo_symbol:
        return []

    period_days = max(30, int(days or 30))
    try:
        history = yf.Ticker(yahoo_symbol).history(period=f"{period_days}d", interval="1d", auto_adjust=True)
    except Exception:
        return []

    if history is None or history.empty or "Close" not in history:
        return []

    close_prices = pd.to_numeric(history["Close"], errors="coerce").dropna()
    if close_prices.empty:
        return []

    prices: List[List[float]] = []
    for timestamp, price in close_prices.items():
        try:
            timestamp_ms = int(pd.Timestamp(timestamp).timestamp() * 1000)
            price_value = float(price)
        except (TypeError, ValueError, OverflowError):
            continue
        if not np.isfinite(price_value):
            continue
        prices.append([timestamp_ms, price_value])

    return prices


def calculate_portfolio_risk_health(req: RiskHealthRequest) -> Dict[str, float]:
    holdings = [holding for holding in (req.holdings or []) if str(holding.ticker or "").strip()]
    if not holdings:
        return {
            "top1_weight": 0.0,
            "top3_weight": 0.0,
            "annual_vol": 0.0,
            "max_drawdown": 0.0,
            "herfindahl": 0.0,
        }

    raw_weights = np.array([max(0.0, float(holding.weight or 0.0)) for holding in holdings], dtype=float)
    total_weight = float(raw_weights.sum())
    if total_weight <= 0:
        weights = np.zeros_like(raw_weights)
    else:
        weights = raw_weights / total_weight

    top_weights = sorted((float(weight) for weight in weights), reverse=True)
    top1 = top_weights[0] if top_weights else 0.0
    top3 = float(sum(top_weights[:3])) if top_weights else 0.0
    herfindahl = float(np.sum(np.square(weights))) if len(weights) else 0.0

    period_days = max(30, int(req.days or 90))
    aligned_returns: Dict[str, pd.Series] = {}

    for holding in holdings:
        yahoo_symbol = _resolve_yahoo_ticker(holding.ticker)
        if not yahoo_symbol:
            continue
        try:
            history = yf.Ticker(yahoo_symbol).history(period=f"{period_days}d", interval="1d", auto_adjust=True)
        except Exception:
            continue

        if history is None or history.empty or "Close" not in history:
            continue

        close_prices = pd.to_numeric(history["Close"], errors="coerce").dropna()
        if len(close_prices) < 2:
            continue

        returns = close_prices.pct_change().dropna()
        if returns.empty:
            continue

        aligned_returns[str(holding.ticker).strip().upper()] = returns.tail(period_days)

    if aligned_returns:
        returns_df = pd.DataFrame(aligned_returns).sort_index().fillna(0.0)
        weight_lookup = {
            str(holding.ticker).strip().upper(): float(weight)
            for holding, weight in zip(holdings, weights)
        }
        portfolio_returns = returns_df.mul(pd.Series(weight_lookup), axis=1).sum(axis=1)
        portfolio_value = (1.0 + portfolio_returns).cumprod()
        running_max = portfolio_value.cummax()
        drawdowns = portfolio_value / running_max - 1.0
        annual_vol = float(portfolio_returns.std(ddof=0) * math.sqrt(365)) if len(portfolio_returns) else 0.0
        max_drawdown = float(abs(drawdowns.min())) if len(drawdowns) else 0.0
    else:
        annual_vol = 0.0
        max_drawdown = 0.0

    return {
        "top1_weight": round(top1, 6),
        "top3_weight": round(top3, 6),
        "annual_vol": round(max(0.0, annual_vol), 6),
        "max_drawdown": round(max(0.0, max_drawdown), 6),
        "herfindahl": round(herfindahl, 6),
    }

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

@app.route('/narrative-radar')
def narrative_radar_page():
    return render_template('narrative_radar.html')

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

@app.route('/member')
def member_page():
    return render_template('member.html')

@app.route('/version', methods=['GET'])
def version():
    commit = (os.getenv('RENDER_GIT_COMMIT') or '').strip()
    return jsonify({"version": commit or "本地開發中"})

<<<<<<< HEAD
=======
@app.route('/api/market-scenarios', methods=['GET'])
def market_scenarios():
    return jsonify({
        "scenarios": {
            "normal": {"label": "一般市場", "price_multiplier": 1.0, "volatility_multiplier": 1.0, "advice": "按照策略正常操作"},
            **{k: {"label": v["label"], "price_multiplier": v["price_multiplier"], "volatility_multiplier": v["volatility_multiplier"]} for k, v in Config.MARKET_SCENARIOS.items()}
        },
        "active": "normal"
    })

>>>>>>> origin/0709
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

@app.route('/api/market', methods=['GET'])
@ttl_cache(ttl_seconds=Config.CACHE_TTL)
<<<<<<< HEAD
def api_market():
    crypto_list = DataManager.get_market_tickers()
=======
def api_market():
    crypto_list = DataManager.get_market_tickers()
>>>>>>> origin/0709
    if not crypto_list:
        return jsonify({"timestamp": "", "data": []})

    market_rows = []
    for coin in crypto_list:
        symbol = (coin.get('symbol') or '').upper()
        market_rows.append({
            "id": coin.get('id') or symbol.lower(),
            "symbol": symbol,
            "name": coin.get('name') or coin.get('cn_name') or symbol,
            "cn_name": coin.get('cn_name') or coin.get('name') or symbol,
            "current_price": coin.get('price_usd', 0),
            "price_usd": coin.get('price_usd', 0),
            "price_change_percentage_24h": coin.get('change', 0),
            "change": coin.get('change', 0),
            "market_cap_rank": coin.get('rank', 0),
            "rank": coin.get('rank', 0),
        })

    return jsonify({"timestamp": "", "data": market_rows})

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
    return jsonify([{"id": c.get("id"), "symbol": (c.get("symbol") or "").upper(), "name": c.get("name"), "current_price": c.get("current_price"), "market_cap": c.get("market_cap"), "price_change_percentage_24h": c.get("price_change_percentage_24h"), "market_cap_rank": c.get("market_cap_rank")} for c in data])

@app.route("/api/sfi/search", methods=["GET"])
def search_sfi_assets():
    query = request.args.get("q", "").strip()
    if not query: return jsonify({"data": []})
    return jsonify({"data": DataManager.search_sfi_assets(query)})

@app.route("/crypto/series", methods=["GET"])
def crypto_price_series():
    ticker = request.args.get("ticker", "ETH").upper()
    vs_currency = request.args.get("vs_currency", "usd")
    days = _parse_positive_int(request.args.get("days", "30"), 30)
    cid = CG_ID_MAP.get(ticker, ticker.lower()) 
    prices: List[List[float]] = []
    source = "coingecko"

    try:
        data = DataManager._cg_get(f"/coins/{cid}/market_chart", {"vs_currency": vs_currency, "days": days}) or {}
        prices = _normalize_price_series(data.get("prices", []))
    except Exception:
        prices = []

    if len(prices) < min(30, days):
        fallback_prices = _fetch_yfinance_series(ticker, days)
        if len(fallback_prices) > len(prices):
            prices = fallback_prices
            source = "yfinance"

    return jsonify({"ticker": ticker, "coin_id": cid, "vs": vs_currency, "days": days, "source": source, "prices": prices})

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
@token_required
def api_ai_chat():
    user_uid = request.user.get('uid')
    access_token = request.user.get('token')
    is_demo = bool(request.user.get('is_demo'))
    req = request.get_json(silent=True) or {}
    user_msg = (req.get("message") or "").strip()
    risk_profile = req.get("risk_profile", "穩健型")
    incoming_conversation_id = (req.get("conversation_id") or "").strip()
    client_messages = req.get("messages") if isinstance(req.get("messages"), list) else []

    if not user_msg:
        return jsonify({"reply": "請先輸入訊息內容。"}), 400
    if not client:
        return jsonify({"reply": "API Key 未設定，無法連線 AI。"})

    conversation_id = None
    history_rows: List[Dict[str, Any]] = []
    if db:
        try:
            if incoming_conversation_id:
                conversation_id = incoming_conversation_id
                if access_token:
                    history_rows = db.get_conversation_history_authed(access_token, conversation_id)
                else:
                    history_rows = db.get_conversation_history(conversation_id)

            if not conversation_id:
                title = user_msg[:30].strip()
                if len(user_msg) > 30:
                    title = f"{title}..."
                if access_token:
                    conversation_id = db.create_conversation_authed(
                        access_token,
                        user_uid,
                        title,
                        os.getenv("OPENAI_MODEL", "gpt-5.4"),
                    )
                else:
                    conversation_id = db.create_conversation(
                        user_uid,
                        title,
                        os.getenv("OPENAI_MODEL", "gpt-5.4"),
                    )
        except Exception:
            app.logger.exception("ai_chat conversation setup failed")
            conversation_id = None

        if conversation_id:
            try:
                save_ok = False
                if access_token:
                    save_ok = db.save_message_authed(
                        access_token,
                        conversation_id,
                        user_uid,
                        "user",
                        user_msg,
                        prompt_tokens=0,
                        completion_tokens=0,
                        tokens_used=0,
                    )
                else:
                    save_ok = db.save_message(
                        conversation_id,
                        user_uid,
                        "user",
                        user_msg,
                        tokens_used=0,
                        prompt_tokens=0,
                        completion_tokens=0,
                    )

                if not save_ok and access_token:
                    conversation_id = db.create_conversation_authed(
                        access_token,
                        user_uid,
                        user_msg[:30].strip() or "Chat",
                        os.getenv("OPENAI_MODEL", "gpt-5.4"),
                    )
                    if conversation_id:
                        db.save_message_authed(
                            access_token,
                            conversation_id,
                            user_uid,
                            "user",
                            user_msg,
                            prompt_tokens=0,
                            completion_tokens=0,
                            tokens_used=0,
                        )
            except Exception:
                app.logger.exception("ai_chat save user message failed")

    try:
        system_prompt = build_ai_system_prompt(risk_profile)
<<<<<<< HEAD
        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
=======
        # ── RAG injection ──
        rag_context = ""
        try:
            if _rag and _rag_available:
                rag = _rag.augment_chat(user_msg, risk_profile)
                ctx = "\n".join(rag.get("context", []))
                if ctx:
                    rag_context = f"\n\n【參考知識】\n{ctx}"
        except Exception:
            pass  # RAG failure → silent fallback
        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt + rag_context}]
>>>>>>> origin/0709

        if history_rows:
            messages.extend(map_history_rows(history_rows))
        elif client_messages:
            for item in client_messages:
                role = (item.get("role") or "").strip()
                content = item.get("content") or ""
                if role in {"user", "assistant", "system"} and content:
                    messages.append({"role": role, "content": content})

        messages.append({"role": "user", "content": user_msg})

        prompt_tokens_total = 0
        completion_tokens_total = 0
        reply_text = ""
        tool_loops = 0
        while tool_loops < 3:
            res = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-5.4"),
                messages=messages,
                tools=AI_TOOL_DEFINITIONS,
                tool_choice="auto",
            )
            usage = getattr(res, "usage", None)
            if usage:
                prompt_tokens_total += int(getattr(usage, "prompt_tokens", 0) or 0)
                completion_tokens_total += int(getattr(usage, "completion_tokens", 0) or 0)

            message = res.choices[0].message
            tool_calls = getattr(message, "tool_calls", None) or []
            if tool_calls:
                messages.append({
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            },
                        }
                        for call in tool_calls
                    ],
                })

                for call in tool_calls:
                    raw_args = getattr(call.function, "arguments", "")
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                    except Exception:
                        args = {}

                    if call.function.name == "get_crypto_price":
                        result = get_crypto_price(args.get("symbol"))
                    else:
                        result = {"ok": False, "error": f"Unknown tool: {call.function.name}"}

                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": json.dumps(result, ensure_ascii=True),
                    })

                tool_loops += 1
                continue

            reply_text = message.content or ""
            break

        tokens_used = prompt_tokens_total + completion_tokens_total

        if db and conversation_id:
            try:
                if access_token:
                    db.save_message_authed(
                        access_token,
                        conversation_id,
                        user_uid,
                        "assistant",
                        reply_text,
                        prompt_tokens=prompt_tokens_total,
                        completion_tokens=completion_tokens_total,
                        tokens_used=tokens_used,
                    )
                else:
                    db.save_message(
                        conversation_id,
                        user_uid,
                        "assistant",
                        reply_text,
                        tokens_used=tokens_used,
                        prompt_tokens=prompt_tokens_total,
                        completion_tokens=completion_tokens_total,
                    )
            except Exception:
                app.logger.exception("ai_chat save assistant message failed")

        payload = {"reply": reply_text or ""}
        if conversation_id:
            payload["conversation_id"] = conversation_id
        return jsonify(payload)
    except Exception as e:
        return jsonify({"reply": f"系統錯誤: {str(e)}"})

@app.route('/api/ai-chat/history', methods=['GET'])
@token_required
def api_ai_chat_history():
    conversation_id = (request.args.get("conversation_id") or "").strip()
    if not conversation_id:
        return jsonify({"error": "conversation_id is required"}), 400
    if not db:
        return jsonify({"error": "database unavailable"}), 503

    access_token = request.user.get("token")
    try:
        if access_token:
            rows = db.get_conversation_history_authed(access_token, conversation_id)
        else:
            rows = db.get_conversation_history(conversation_id)
        return jsonify({"conversation_id": conversation_id, "messages": rows})
    except Exception:
        app.logger.exception("ai_chat history failed")
        return jsonify({"error": "history fetch failed"}), 500

@app.route('/api/ai-chat/conversations', methods=['GET'])
@token_required
def api_ai_chat_conversations():
    if not db:
        return jsonify({"error": "database unavailable"}), 503

    access_token = request.user.get("token")
    user_uid = request.user.get("uid")
    limit_raw = request.args.get("limit", "50")
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(200, limit))

    try:
        if access_token:
            rows = db.list_conversations_authed(access_token, user_uid, limit=limit)
        else:
            rows = db.list_conversations(user_uid, limit=limit)

        conversations = [
            {"id": row.get("id"), "title": row.get("conversation_title") or "Chat"}
            for row in rows
            if row.get("id")
        ]
        return jsonify({"conversations": conversations})
    except Exception:
        app.logger.exception("ai_chat conversations failed")
        return jsonify({"error": "conversation list fetch failed"}), 500

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


def require_sim_trade_token() -> Tuple[Optional[str], Optional[Tuple[Any, int]]]:
    if request.user.get("is_demo"):
        return DEMO_MEMBER_TOKEN, None
    if not db:
        return None, (jsonify({'error': '交易服務暫時不可用，Demo 會員仍可使用本機模擬交易。', 'code': 'sim-trade/service-unavailable'}), 503)
    token = request.user.get("token")
    if not token:
        return None, (jsonify({'error': '請先登入系統', 'code': 'auth/unauthorized'}), 401)
    return token, None


def normalize_trade(row: Dict[str, Any]) -> Dict[str, Any]:
    if not row:
        return {}
    return {
        "timestamp": row.get("executed_at") or row.get("timestamp"),
        "symbol": row.get("symbol"),
        "side": row.get("side"),
        "price": float(row.get("price") or 0),
        "quantity": float(row.get("quantity") or 0),
        "amount_usd": float(row.get("amount_usd") or 0),
    }


def estimate_total_value_after_order(
    portfolio: Dict[str, Any],
    position_rows: List[Dict[str, Any]],
    symbol: str,
    side: str,
    quantity: float,
    amount_usd: float,
) -> float:
    cash = float(portfolio.get("cash_balance", 0))
    positions: Dict[str, Dict[str, float]] = {}
    for row in position_rows:
        sym = str(row.get("symbol", "")).upper()
        if not sym:
            continue
        positions[sym] = {
            "quantity": float(row.get("quantity") or 0),
            "avg_price": float(row.get("avg_price") or 0),
        }

    if side == "buy":
        if cash < amount_usd:
            raise ValueError("模擬帳戶現金不足。")
        current = positions.get(symbol, {"quantity": 0.0, "avg_price": 0.0})
        old_qty = float(current.get("quantity", 0))
        old_cost = old_qty * float(current.get("avg_price", 0))
        new_qty = old_qty + quantity
        new_avg = (old_cost + amount_usd) / new_qty if new_qty > 0 else 0
        positions[symbol] = {"quantity": new_qty, "avg_price": new_avg}
        cash -= amount_usd
    elif side == "sell":
        current = positions.get(symbol, {"quantity": 0.0, "avg_price": 0.0})
        old_qty = float(current.get("quantity", 0))
        if old_qty < quantity:
            raise ValueError("持倉不足，無法賣出。")
        new_qty = old_qty - quantity
        if new_qty <= 0:
            positions.pop(symbol, None)
        else:
            positions[symbol] = {"quantity": new_qty, "avg_price": float(current.get("avg_price", 0))}
        cash += amount_usd
    else:
        raise ValueError("下單方向只能是 buy 或 sell。")

    total_value = cash
    for sym, pos in positions.items():
        qty = float(pos.get("quantity", 0))
        if qty <= 0:
            continue
        current_price = get_coin_price_usd(sym)
        total_value += qty * current_price
    return total_value


def sim_snapshot(access_token: str) -> Dict[str, Any]:
    use_local = local_sim_preferred(access_token)
    capital_records: List[Dict[str, Any]] = []
    portfolio = {} if use_local else (db.sim_get_or_create_portfolio(access_token, SIM_INITIAL_CASH) if db else {})
    if not portfolio:
        _, state, _ = get_local_sim_state(access_token)
        use_local = True
        portfolio = state.get("portfolio") or {}
        position_rows = local_position_rows(state)
        equity_rows = state.get("equity_curve") or []
        capital_records = state.get("capital_records") or []
    else:
        position_rows = db.sim_list_positions(access_token) if db else []
        equity_rows = db.sim_list_equity_curve(access_token, limit=80) if db else []
    if not portfolio:
        raise ValueError("無法取得模擬投資組合。")
    cash = float(portfolio.get("cash_balance", 0))
    initial_cash = float(portfolio.get("initial_cash") or SIM_INITIAL_CASH)

    positions = []
    total_value = cash
    for row in position_rows:
        symbol = str(row.get("symbol", "")).upper()
        qty = float(row.get("quantity", 0))
        if not symbol or qty <= 0:
            continue
        current_price = get_coin_price_usd(symbol)
        avg_price = float(row.get("avg_price") or current_price)
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

    unrealized_pnl = total_value - initial_cash
    pnl_pct = (unrealized_pnl / initial_cash * 100) if initial_cash else 0

    if not equity_rows and db and not use_local:
        portfolio_id = portfolio.get("id")
        user_id = portfolio.get("user_id")
        if portfolio_id and user_id:
            db.sim_insert_equity_point(
                access_token,
                str(user_id),
                str(portfolio_id),
                total_value,
                cash,
            )
            equity_rows = db.sim_list_equity_curve(access_token, limit=80)

    if use_local:
        _, state, store = get_local_sim_state(access_token)
        capital_records = state.get("capital_records") or []
        if not equity_rows:
            append_local_equity_point(state, total_value, cash)
            save_local_sim_store(store)
            equity_rows = state.get("equity_curve") or []

    equity_rows = sorted(equity_rows, key=lambda row: row.get("ts") or "")
    equity_curve = [
        {
            "timestamp": row.get("ts"),
            "total_value_usd": float(row.get("total_value_usd") or 0),
        }
        for row in equity_rows
    ]

    return {
        "cash": cash,
        "positions": positions,
        "total_value_usd": total_value,
        "unrealized_pnl": unrealized_pnl,
        "pnl_pct": pnl_pct,
        "equity_curve": equity_curve,
        "capital_records": capital_records,
    }


def execute_sim_order(
    access_token: str,
    symbol: str,
    side: str,
    quantity: Optional[float] = None,
    amount_usd: Optional[float] = None,
) -> Dict[str, Any]:
    symbol = symbol.upper()
    side = side.lower()
    price = get_coin_price_usd(symbol)
    if amount_usd and not quantity:
        quantity = float(amount_usd) / price
    quantity = float(quantity or 0)
    amount = float(amount_usd or (quantity * price))
    if quantity <= 0 or amount <= 0:
        raise ValueError("請輸入有效的下單數量或金額。")

    use_local = local_sim_preferred(access_token)
    portfolio = {} if use_local else (db.sim_get_or_create_portfolio(access_token, SIM_INITIAL_CASH) if db else {})
    position_rows = []
    state = None
    store = None
    if not portfolio:
        _, state, store = get_local_sim_state(access_token)
        use_local = True
        portfolio = state.get("portfolio") or {}
        position_rows = local_position_rows(state)
        use_local = True
    else:
        position_rows = db.sim_list_positions(access_token) if db else []
    if not portfolio:
        raise ValueError("無法取得模擬投資組合。")
    total_value = estimate_total_value_after_order(portfolio, position_rows, symbol, side, quantity, amount)

    if use_local:
        return local_execute_sim_order(access_token, symbol, side, price, quantity, amount)

    result = db.sim_execute_order(
        access_token,
        symbol,
        side,
        price=price,
        quantity=quantity,
        amount_usd=amount,
        total_value_usd=total_value,
        initial_cash=float(portfolio.get("initial_cash") or SIM_INITIAL_CASH),
    ) if db else {}

    trade = normalize_trade(result.get("trade") if isinstance(result, dict) else {})
    if not trade:
        return local_execute_sim_order(access_token, symbol, side, price, quantity, amount)
    return trade


@app.route("/api/sim-trade/portfolio", methods=["GET"])
@token_required
def api_sim_trade_portfolio():
    access_token, error = require_sim_trade_token()
    if error:
        return error
    return jsonify({"portfolio": sim_snapshot(access_token)})


@app.route("/api/sim-trade/history", methods=["GET"])
@token_required
def api_sim_trade_history():
    limit = int(request.args.get("limit", 50))
    access_token, error = require_sim_trade_token()
    if error:
        return error
    if access_token == DEMO_MEMBER_TOKEN:
        _, state, _ = get_local_sim_state(access_token)
        trades = state.get("trades") or []
    else:
        trades = db.sim_list_transactions(access_token, limit=limit) if db else []
        if not trades:
            _, state, _ = get_local_sim_state(access_token)
            trades = state.get("trades") or []
    return jsonify({"trades": [normalize_trade(row) for row in trades]})


@app.route("/api/sim-trade/order", methods=["POST"])
@token_required
def api_sim_trade_order():
    req = request.get_json(silent=True) or {}
    try:
        access_token, error = require_sim_trade_token()
        if error:
            return error
        trade = execute_sim_order(
            access_token,
            req.get("symbol", "BTC"),
            req.get("side", "buy"),
            req.get("quantity"),
            req.get("amount_usd"),
        )
        return jsonify({"success": True, "trade": trade, "portfolio": sim_snapshot(access_token)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/sim-trade/reset", methods=["POST"])
@token_required
def api_sim_trade_reset():
    access_token, error = require_sim_trade_token()
    if error:
        return error
    if access_token == DEMO_MEMBER_TOKEN or not db:
        user_key = sim_user_key(access_token)
        store = load_local_sim_store()
        store.setdefault("users", {})[user_key] = default_local_sim_state(user_key, SIM_INITIAL_CASH)
        save_local_sim_store(store)
    else:
        db.sim_reset_portfolio(access_token, SIM_INITIAL_CASH, SIM_INITIAL_CASH)
    return jsonify({"success": True, "portfolio": sim_snapshot(access_token)})


@app.route("/api/sim-trade/deposit", methods=["POST"])
@token_required
def api_sim_trade_deposit():
    req = request.get_json(silent=True) or {}
    try:
        access_token, error = require_sim_trade_token()
        if error:
            return error
        amount_usd = req.get("amount_usd")
        amount_twd = req.get("amount_twd")
        if amount_usd is None and amount_twd is not None:
            amount_usd = float(amount_twd) / 32.0
        amount = float(amount_usd or 0)
        if amount <= 0:
            return jsonify({"error": "請輸入大於 0 的新增資金。"}), 400

        _, state, store = get_local_sim_state(access_token)
        state["prefer_local"] = True
        portfolio = state.get("portfolio") or {}
        portfolio["cash_balance"] = float(portfolio.get("cash_balance") or 0) + amount
        portfolio["initial_cash"] = float(portfolio.get("initial_cash") or 0) + amount
        snapshot_total = portfolio["cash_balance"]
        for row in local_position_rows(state):
            snapshot_total += float(row.get("quantity") or 0) * get_coin_price_usd(str(row.get("symbol") or ""))
        now = datetime.utcnow().isoformat()
        state.setdefault("capital_records", []).insert(0, {
            "id": str(uuid.uuid4()),
            "timestamp": now,
            "amount_usd": amount,
            "note": str(req.get("note") or "").strip(),
        })
        del state["capital_records"][100:]
        append_local_equity_point(state, snapshot_total, portfolio["cash_balance"])
        save_local_sim_store(store)
        return jsonify({"success": True, "portfolio": sim_snapshot(access_token), "capital_records": state.get("capital_records") or []})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/sim-trade/capital/<record_id>", methods=["DELETE"])
@token_required
def api_sim_trade_delete_capital(record_id: str):
    if not request.user.get("is_demo"):
        return jsonify({"error": "只有 Demo 帳號可以刪除資金紀錄。"}), 403

    try:
        access_token = DEMO_MEMBER_TOKEN
        _, state, store = get_local_sim_state(access_token)
        records = state.setdefault("capital_records", [])
        target_index = next((
            idx for idx, item in enumerate(records)
            if str(item.get("id") or item.get("timestamp") or "") == str(record_id)
        ), -1)
        if target_index < 0:
            return jsonify({"error": "找不到要刪除的資金紀錄。"}), 404

        record = records[target_index]
        amount = float(record.get("amount_usd") or 0)
        portfolio = state.get("portfolio") or {}
        cash = float(portfolio.get("cash_balance") or 0)
        if amount > cash:
            return jsonify({"error": "目前現金不足以刪除此筆資金，請先賣出持倉或重置 Demo 帳戶。"}), 400

        records.pop(target_index)
        portfolio["cash_balance"] = cash - amount
        portfolio["initial_cash"] = max(0.0, float(portfolio.get("initial_cash") or 0) - amount)
        total_value = portfolio["cash_balance"]
        for row in local_position_rows(state):
            total_value += float(row.get("quantity") or 0) * get_coin_price_usd(str(row.get("symbol") or ""))
        append_local_equity_point(state, total_value, portfolio["cash_balance"])
        save_local_sim_store(store)
        return jsonify({"success": True, "portfolio": sim_snapshot(access_token), "capital_records": records})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


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

<<<<<<< HEAD
    try:
        prompt = f"""
你是 Smart Invest 的加密資產 AI Agent。請把使用者任務拆成新手也看得懂、可以今天執行的行動計畫。
=======
    # ── RAG injection ──
    rag_context = ""
    try:
        if _rag and _rag_available:
            rag = _rag.augment_agent(goal, profile, str(budget))
            ctx = "\n".join(rag.get("context", []))
            if ctx:
                rag_context = f"\n\n參考知識：\n{ctx}"
    except Exception:
        pass

    try:
        prompt = f"""
你是 Smart Invest 的加密資產 AI Agent。請把使用者任務拆成新手也看得懂、可以今天執行的行動計畫。
{rag_context}
>>>>>>> origin/0709

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
            model=os.getenv("OPENAI_MODEL_AGENT", "gpt-5.4"),
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
        access_token, error = require_sim_trade_token()
        if error:
            return error
        snapshot = sim_snapshot(access_token)
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
                access_token,
                item["symbol"],
                "buy",
                amount_usd=order_amount,
            ))

        return jsonify({
            "success": True,
            "scaled": scale < 1.0,
            "scale": scale,
            "trades": trades,
            "portfolio": sim_snapshot(access_token),
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

@app.route('/api/scam-scan', methods=['POST'])
def api_scam_scan():
    req = request.get_json(silent=True) or {}
    text = (req.get("text") or "").strip()
    scam_client = refresh_openai_client()
    if not scam_client:
        return jsonify({"risk_level": "unknown", "report": "API Key 未設定，無法連線 AI。"})
    if not text:
        return jsonify({"risk_level": "unknown", "report": "請提供要檢測的內容。"})
<<<<<<< HEAD
=======
    # ── RAG: scam pattern knowledge supplement ──
    rag_supplement = ""
    try:
        if _rag and _rag_available:
            rag = _rag.augment_scam(text)
            snippets = rag.get("rag_snippets", [])
            if snippets:
                rag_supplement = "\n參考詐騙模式知識：\n" + "\n".join(snippets[:2])
    except Exception:
        pass

>>>>>>> origin/0709
    try:
        system_prompt = (
            "你是金融反詐騙專家。請只輸出 JSON，格式為 "
            "{\"risk_level\": \"high|medium|low\", \"report\": \"...\"}。"
            "risk_level 必須是 high、medium 或 low。report 請用中文整理："
            "1.風險等級 2.疑點解析 3.防範建議。"
<<<<<<< HEAD
        )
=======
            "不要用模糊語句降低風險警示，若有不確定處請明確標示。"
        ) + rag_supplement
>>>>>>> origin/0709
        completion = scam_client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_MODEL", "gpt-5.4"),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"內容：{text}"}
            ],
            response_format=ScamScanResult
        )
        parsed = completion.choices[0].message.parsed
        risk_level = parsed.risk_level if parsed and parsed.risk_level in {"high", "medium", "low"} else "unknown"
        report = parsed.report if parsed and parsed.report else "目前沒有取得分析報告。"
        return jsonify({"risk_level": risk_level, "report": report})
    except Exception as e:
        return jsonify({"risk_level": "unknown", "report": f"系統錯誤: {str(e)}"})

@app.route("/podcast/generate", methods=["POST"])
def generate_podcast():
    try: req = PodcastGenerateRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    personal_summary = ""
    if req.market == "PERSONAL" and req.portfolio_summary:
        personal_summary = f"\n會員模擬資產摘要={json.dumps(req.portfolio_summary, ensure_ascii=False)[:1800]}\n請在開場自然唸出會員目前總資產、現金與已投入的幣種市值摘要。"
    prompt = f"市場={req.market}\n風險={req.profile.risk_level}\n關注清單={req.watchlist}\n事件={req.events}{personal_summary}\n請用口語播報市場與配置重點。"
<<<<<<< HEAD
=======
    # ── RAG injection ──
    rag_context = ""
    try:
        if _rag and _rag_available:
            rag = _rag.augment_podcast(req.market, market_context=f"市場={req.market} 風險={req.profile.risk_level}")
            ctx = "\n".join(rag.get("context", []))
            if ctx:
                rag_context = f"\n風格參考：\n{ctx}"
    except Exception:
        pass
    system_msg = "你是加密貨幣晨報 Podcast 主持人與分析師。請遵循 Podcast 風格指南，開場含日期與市場概覽，結尾含投資提醒。輸出 JSON。" + rag_context
>>>>>>> origin/0709
    try:
        podcast_client = refresh_openai_client()
        if not podcast_client: return jsonify(build_fallback_podcast(req))
        completion = podcast_client.beta.chat.completions.parse(
<<<<<<< HEAD
            model=os.getenv("OPENAI_MODEL", "gpt-5.4"), 
            messages=[{"role": "system", "content": "你是加密貨幣晨報 Podcast 主持人與分析師。輸出 JSON。"}, {"role": "user", "content": prompt}],
=======
            model=os.getenv("OPENAI_MODEL", "gpt-5.4"),
            messages=[{"role": "system", "content": system_msg}, {"role": "user", "content": prompt}],
>>>>>>> origin/0709
            response_format=PodcastLLMOut
        )
        out = completion.choices[0].message.parsed
        lines = out.lines
        estimated_seconds = max(35, int(sum(len(l.text) for l in lines) / 3.0))
        return jsonify({"title": out.title, "bullets": out.bullets, "script": "\n".join([f"{l.speaker}：{l.text}" for l in lines]), "estimated_seconds": estimated_seconds, "lines": [l.model_dump() for l in lines]})
    except Exception as e:
        fallback = build_fallback_podcast(req)
        fallback["debug"] = f"OpenAI fallback: {type(e).__name__}"
        return jsonify(fallback)

@app.route("/api/podcast/generate", methods=["POST"])
def api_generate_podcast_alias():
    return generate_podcast()

def create_dialogue_wav(podcast_client: OpenAI, req: TTSRequest, model: str, out_path: Path) -> None:
    segment_paths: List[Path] = []
    output_params: Optional[Tuple[int, int, int, str, str]] = None
    output_frames: List[bytes] = []
    voices = {"主持人": "nova", "分析師": "onyx"}

    try:
        for index, line in enumerate(req.lines[:28]):
            segment_text = re.sub(r"\s+", " ", line.text).strip()
            if not segment_text:
                continue

            segment_path = AUDIO_DIR / f"{out_path.stem}_{index}.wav"
            segment_paths.append(segment_path)
            with podcast_client.audio.speech.with_streaming_response.create(
                model=model,
                voice=voices.get(line.speaker, "nova"),
                input=segment_text[:900],
                speed=req.speed,
                response_format="wav",
            ) as response:
                response.stream_to_file(segment_path)

            with wave.open(str(segment_path), "rb") as source:
                params = (
                    source.getnchannels(),
                    source.getsampwidth(),
                    source.getframerate(),
                    source.getcomptype(),
                    source.getcompname(),
                )
                if output_params and params != output_params:
                    raise RuntimeError("TTS WAV format mismatch")
                output_params = params
                output_frames.append(source.readframes(source.getnframes()))

        if not output_params or not output_frames:
            raise ValueError("Podcast dialogue is empty")

        channels, sample_width, frame_rate, comp_type, comp_name = output_params
        pause_frames = max(1, int(frame_rate * 0.16))
        pause = b"\x00" * pause_frames * channels * sample_width
        with wave.open(str(out_path), "wb") as target:
            target.setnchannels(channels)
            target.setsampwidth(sample_width)
            target.setframerate(frame_rate)
            target.setcomptype(comp_type, comp_name)
            for index, frames in enumerate(output_frames):
                target.writeframes(frames)
                if index < len(output_frames) - 1:
                    target.writeframes(pause)
    finally:
        for segment_path in segment_paths:
            segment_path.unlink(missing_ok=True)

@app.route("/podcast/tts", methods=["POST"])
<<<<<<< HEAD
def podcast_tts():
    podcast_client = refresh_openai_client()
    if not podcast_client:
        return jsonify({"detail": "尚未設定 OPENAI_API_KEY，因此無法生成雲端語音。請在專案根目錄建立 .env，加入 OPENAI_API_KEY=你的_key，然後重啟 Flask。"}), 503
=======
def podcast_tts():
    podcast_client = refresh_openai_client()
    if not podcast_client:
        return jsonify({"detail": "尚未設定 OPENAI_API_KEY，因此無法生成雲端語音。請在專案根目錄建立 .env，加入 OPENAI_API_KEY=你的_key，然後重啟 Flask。"}), 503
>>>>>>> origin/0709
    try: req = TTSRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    if not req.lines and not req.text.strip():
        return jsonify({"detail": "Podcast dialogue is empty"}), 422
    clean = re.sub(r"^(主持人|分析師)：", "", req.text, flags=re.MULTILINE).strip()[:3800]
    audio_id = uuid.uuid4().hex[:10]
    filename = f"podcast_{date.today().isoformat()}_{audio_id}.{'wav' if req.lines else 'mp3'}"
    out_path = AUDIO_DIR / filename
    preferred_model = os.getenv("OPENAI_TTS_MODEL", req.model or "gpt-4o-mini-tts")
    tts_models = []
    for model_name in [preferred_model, "gpt-4o-mini-tts", "tts-1"]:
        if model_name and model_name not in tts_models:
            tts_models.append(model_name)
    errors = []
    try:
        for tts_model in tts_models:
            try:
                if req.lines:
                    create_dialogue_wav(podcast_client, req, tts_model, out_path)
                    return send_file(out_path, mimetype="audio/wav", as_attachment=True, download_name=filename)
                with podcast_client.audio.speech.with_streaming_response.create(model=tts_model, voice=req.voice, input=clean, speed=req.speed, response_format="mp3") as response:
                    response.stream_to_file(out_path)
                return send_file(out_path, mimetype="audio/mpeg", as_attachment=True, download_name=filename)
            except Exception as model_error:
                if is_openai_auth_error(model_error):
                    return jsonify({"detail": "OpenAI API Key 驗證失敗。請重新產生一把新的 API key，貼到 .env 的 OPENAI_API_KEY，然後重啟 Flask。"}), 401
                errors.append(f"{tts_model}: {type(model_error).__name__}: {str(model_error)[:180]}")
        raise RuntimeError(" | ".join(errors))
    except Exception as e:
        return jsonify({"detail": f"TTS failed: {type(e).__name__}: {str(e)[:240]}"}), 502

@app.route("/api/podcast/tts", methods=["POST"])
def api_podcast_tts_alias():
    return podcast_tts()


@app.route("/portfolio/risk-health", methods=["POST"])
<<<<<<< HEAD
=======
@token_required
>>>>>>> origin/0709
def portfolio_risk_health():
    try:
        req = RiskHealthRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e:
        return jsonify({"detail": str(e)}), 422

    return jsonify({"risk_health": calculate_portfolio_risk_health(req)})

@app.route("/portfolio/analyze-llm", methods=["POST"])
<<<<<<< HEAD
=======
@token_required
>>>>>>> origin/0709
def analyze_portfolio_llm():
    try: req = RiskHealthRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e: return jsonify({"detail": str(e)}), 422
    rh_dict = calculate_portfolio_risk_health(req)
    if client is None: return jsonify({"risk_health": rh_dict, "narrative": "未設定金鑰，改用規則摘要。請注意波動風險。", "highlights": ["提醒：無 AI 金鑰"]})
    holdings_text = ", ".join([f"{h.ticker}({h.weight:.2f})" for h in req.holdings])
<<<<<<< HEAD
=======
    # ── RAG: health education supplement ──
    rag_context = ""
    try:
        if _rag and _rag_available:
            rag = _rag.augment_health(rh_dict, holdings_text)
            ctx = "\n".join(rag.get("context", []))
            if ctx:
                rag_context = f"\n參考配置原則：\n{ctx}"
    except Exception:
        pass
>>>>>>> origin/0709
    prompt = f"請用非常白話的中文分析配置：\n【持幣】{holdings_text}\n【指標】Top1={rh_dict['top1_weight']:.2f}, 年化波動={rh_dict['annual_vol']:.2f}, 最大回撤={rh_dict['max_drawdown']:.2f}"
    try:
        completion = client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_MODEL_PORTFOLIO", "gpt-5.4"),
<<<<<<< HEAD
            messages=[{"role": "system", "content": "你是專業的加密貨幣財富管理顧問。"}, {"role": "user", "content": prompt}],
=======
            messages=[{"role": "system", "content": "你是專業的加密貨幣財富管理顧問。請根據配置原則給出分析。" + rag_context}, {"role": "user", "content": prompt}],
>>>>>>> origin/0709
            response_format=PortfolioLLMOut
        )
        out = completion.choices[0].message.parsed
        return jsonify({"risk_health": rh_dict, "narrative": out.narrative, "highlights": out.highlights or []})
    except Exception as e: return jsonify({"risk_health": rh_dict, "narrative": "LLM 分析連線失敗，請檢查金鑰。", "highlights": ["連線異常"]})

@app.route("/api/portfolio/analyze", methods=["POST"])
<<<<<<< HEAD
=======
@token_required
>>>>>>> origin/0709
def api_portfolio_analyze_alias():
    req = request.get_json(silent=True) or {}
    amount = parse_budget_amount(req.get("amount"), 10000.0)
    risk_level = str(req.get("risk_level") or "穩健型")
    allocation = build_agent_allocation(risk_level, amount)
    lines = [
        f"{item['symbol']}：{int(item['weight'] * 100)}%，約 ${item['amount_usd']:,.0f}"
        for item in allocation
    ]
    return jsonify({
        "narrative": "建議先用分散配置降低單一幣種波動，並保留現金或穩定幣做緩衝。\n" + "\n".join(lines),
        "highlights": [
            "這是規則型試算，仍需搭配市場總覽與健康度檢查。",
            "若短線漲幅過大，先分批進場，避免一次追高。"
        ],
        "allocation": allocation,
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
