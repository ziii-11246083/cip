import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

logger = logging.getLogger(__name__)


class SupabaseDB:
    _instance: Optional["SupabaseDB"] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.url = os.getenv("SUPABASE_URL", "").strip()
        self.anon_key = os.getenv("SUPABASE_ANON_KEY", "").strip()
        self.service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        self.key = (
            self.service_key
            or os.getenv("SUPABASE_KEY", "").strip()
            or self.anon_key
        )
        self.client: Optional[Client] = None
        self.available = False

        if not self.url or not self.key:
            logger.warning("Supabase credentials are missing; database features are disabled.")
            self._initialized = True
            return

        try:
            self.client = create_client(self.url, self.key)
            self.available = True
            logger.info("Supabase initialized successfully.")
        except Exception as exc:
            logger.exception("Failed to initialize Supabase: %s", exc)
            self.client = None
            self.available = False

        self._initialized = True

    def __bool__(self) -> bool:
        return self.available and self.client is not None

    def health(self) -> Dict[str, Any]:
        return {
            "available": bool(self),
            "url_configured": bool(self.url),
            "key_configured": bool(self.key),
            "anon_key_configured": bool(self.anon_key),
        }

    def _table(self, table_name: str):
        if not self.client:
            raise RuntimeError("Supabase client is unavailable.")
        return self.client.table(table_name)

    def _authed_client(self, access_token: str) -> Client:
        if not self.url:
            raise RuntimeError("Supabase URL is missing.")
        if not access_token:
            raise RuntimeError("Supabase access token is required.")
        api_key = self.anon_key or self.key
        if not api_key:
            raise RuntimeError("Supabase anon key is missing.")
        client = create_client(self.url, api_key)
        try:
            client.postgrest.auth(access_token)
        except Exception as exc:
            logger.exception("Failed to apply access token to Supabase client: %s", exc)
            raise
        return client

    def _authed_table(self, access_token: str, table_name: str):
        return self._authed_client(access_token).table(table_name)

    def _get_crypto_id(self, symbol: str) -> Optional[str]:
        response = self._table("cryptocurrencies").select("id").eq("symbol", symbol).maybe_single().execute()
        if response and isinstance(response.data, dict):
            return response.data.get("id")
        return None

    def create_user(self, email: str, password: str, username: Optional[str] = None) -> Dict[str, Any]:
        if not self.client:
            return {"success": False, "error": "Supabase client is unavailable."}

        try:
            response = self.client.auth.sign_up({"email": email, "password": password})
            user = getattr(response, "user", None)
            if user:
                self._table("user_profiles").upsert({
                    "user_id": user.id,
                    "full_name": username or email.split("@")[0],
                }, on_conflict="user_id").execute()
                return {"success": True, "user_id": user.id}
            return {"success": False, "error": "User signup returned no user object."}
        except Exception as exc:
            logger.exception("create_user failed: %s", exc)
            return {"success": False, "error": str(exc)}

    def get_user_profile(self, user_id: str) -> Dict[str, Any]:
        try:
            response = self._table("user_profiles").select("*").eq("user_id", user_id).maybe_single().execute()
            return response.data if response and response.data else {}
        except Exception as exc:
            logger.exception("get_user_profile failed: %s", exc)
            return {}

    def update_user_preferences(self, user_id: str, preferences: Dict[str, Any]) -> bool:
        try:
            self._table("user_preferences").upsert({
                "user_id": user_id,
                **preferences,
            }, on_conflict="user_id").execute()
            return True
        except Exception as exc:
            logger.exception("update_user_preferences failed: %s", exc)
            return False

    def add_cryptocurrency(self, symbol: str, name: str, chinese_name: Optional[str] = None, **kwargs) -> Optional[str]:
        try:
            response = self._table("cryptocurrencies").insert({
                "symbol": symbol,
                "name": name,
                "chinese_name": chinese_name or name,
                **kwargs,
            }).execute()
            return response.data[0]["id"] if response and response.data else None
        except Exception as exc:
            logger.exception("add_cryptocurrency failed: %s", exc)
            return None

    def get_or_create_cryptocurrency(self, symbol: str, name: str, chinese_name: Optional[str] = None, **kwargs) -> Optional[str]:
        try:
            crypto_id = self._get_crypto_id(symbol)
            if crypto_id:
                return crypto_id
            return self.add_cryptocurrency(symbol, name, chinese_name, **kwargs)
        except Exception as exc:
            logger.exception("get_or_create_cryptocurrency failed: %s", exc)
            return None

    def upsert_cryptocurrencies(self, coins: List[Dict[str, Any]]) -> Dict[str, str]:
        result: Dict[str, str] = {}
        if not coins:
            return result

        try:
            response = self._table("cryptocurrencies").upsert(
                coins,
                on_conflict="symbol",
                returning="representation",
            ).execute()
            if response and response.data:
                for row in response.data:
                    symbol = row.get("symbol")
                    crypto_id = row.get("id")
                    if symbol and crypto_id:
                        result[symbol] = crypto_id
            return result
        except Exception as exc:
            logger.exception("upsert_cryptocurrencies failed: %s", exc)
            return result

    def bulk_insert_price_data(self, price_records: List[Dict[str, Any]]) -> bool:
        if not price_records:
            return True
        try:
            self._table("coin_prices").insert(price_records).execute()
            return True
        except Exception as exc:
            logger.exception("bulk_insert_price_data failed: %s", exc)
            return False

    def insert_price_data(self, symbol: str, price_data: Dict[str, Any]) -> bool:
        try:
            crypto_id = self._get_crypto_id(symbol)
            if not crypto_id:
                return False
            self._table("coin_prices").insert({
                "crypto_id": crypto_id,
                "symbol": symbol,
                **price_data,
            }).execute()
            return True
        except Exception as exc:
            logger.exception("insert_price_data failed: %s", exc)
            return False

    def get_latest_price(self, symbol: str) -> Optional[Dict[str, Any]]:
        try:
            response = self._table("coin_prices").select("*").eq("symbol", symbol).order("timestamp", desc=True).limit(1).execute()
            return response.data[0] if response and response.data else None
        except Exception as exc:
            logger.exception("get_latest_price failed: %s", exc)
            return None

    def save_crypto_report(self, symbol: str, report_data: Dict[str, Any]) -> bool:
        try:
            crypto_id = self._get_crypto_id(symbol)
            if not crypto_id:
                return False
            self._table("crypto_reports").insert({
                "crypto_id": crypto_id,
                "symbol": symbol,
                **report_data,
            }).execute()
            return True
        except Exception as exc:
            logger.exception("save_crypto_report failed: %s", exc)
            return False

    def get_latest_report(self, symbol: str) -> Optional[Dict[str, Any]]:
        try:
            response = self._table("crypto_reports").select("*").eq("symbol", symbol).order("created_at", desc=True).limit(1).execute()
            return response.data[0] if response and response.data else None
        except Exception as exc:
            logger.exception("get_latest_report failed: %s", exc)
            return None

    def save_sentiment_analysis(self, symbol: str, sentiment_data: Dict[str, Any]) -> bool:
        try:
            crypto_id = self._get_crypto_id(symbol)
            if not crypto_id:
                return False
            self._table("sentiment_analysis").insert({
                "crypto_id": crypto_id,
                "symbol": symbol,
                **sentiment_data,
            }).execute()
            return True
        except Exception as exc:
            logger.exception("save_sentiment_analysis failed: %s", exc)
            return False

    def get_sentiment_trends(self, symbol: str, time_period: str = "24h") -> List[Dict[str, Any]]:
        try:
            response = self._table("sentiment_analysis").select("*").eq("symbol", symbol).eq("time_period", time_period).order("analyzed_at", desc=True).limit(10).execute()
            return response.data or []
        except Exception as exc:
            logger.exception("get_sentiment_trends failed: %s", exc)
            return []

    def log_user_activity(self, user_id: str, activity_data: Dict[str, Any]) -> bool:
        try:
            self._table("user_activities").insert({"user_id": user_id, **activity_data}).execute()
            return True
        except Exception as exc:
            logger.exception("log_user_activity failed: %s", exc)
            return False

    def add_to_watchlist(self, user_id: str, symbol: str, watchlist_name: str = "My Watchlist") -> bool:
        try:
            crypto_id = self._get_crypto_id(symbol)
            if not crypto_id:
                return False
            self._table("watchlist").upsert({
                "user_id": user_id,
                "crypto_id": crypto_id,
                "symbol": symbol,
                "watchlist_name": watchlist_name,
            }).execute()
            return True
        except Exception as exc:
            logger.exception("add_to_watchlist failed: %s", exc)
            return False

    def get_user_watchlist(self, user_id: str) -> List[Dict[str, Any]]:
        try:
            response = self._table("watchlist").select("*").eq("user_id", user_id).execute()
            return response.data or []
        except Exception as exc:
            logger.exception("get_user_watchlist failed: %s", exc)
            return []

    def sim_get_or_create_portfolio(self, access_token: str, initial_cash: float = 100000.0) -> Dict[str, Any]:
        try:
            client = self._authed_client(access_token)
            response = client.rpc("sim_get_or_create_portfolio", {
                "p_initial_cash": float(initial_cash),
            }).execute()
            if response and response.data:
                return response.data if isinstance(response.data, dict) else response.data[0]
            return {}
        except Exception as exc:
            logger.exception("sim_get_or_create_portfolio failed: %s", exc)
            return {}

    def sim_list_positions(self, access_token: str) -> List[Dict[str, Any]]:
        try:
            response = self._authed_table(access_token, "sim_positions")\
                .select("symbol, quantity, avg_price")\
                .order("symbol", desc=False)\
                .execute()
            return response.data or []
        except Exception as exc:
            logger.exception("sim_list_positions failed: %s", exc)
            return []

    def sim_list_transactions(self, access_token: str, limit: int = 50) -> List[Dict[str, Any]]:
        try:
            response = self._authed_table(access_token, "sim_transactions")\
                .select("symbol, side, price, quantity, amount_usd, executed_at")\
                .order("executed_at", desc=True)\
                .limit(limit)\
                .execute()
            return response.data or []
        except Exception as exc:
            logger.exception("sim_list_transactions failed: %s", exc)
            return []

    def sim_list_equity_curve(self, access_token: str, limit: int = 80) -> List[Dict[str, Any]]:
        try:
            response = self._authed_table(access_token, "sim_equity_curve")\
                .select("ts, total_value_usd, cash_balance")\
                .order("ts", desc=True)\
                .limit(limit)\
                .execute()
            return response.data or []
        except Exception as exc:
            logger.exception("sim_list_equity_curve failed: %s", exc)
            return []

    def sim_insert_equity_point(
        self,
        access_token: str,
        user_id: str,
        portfolio_id: str,
        total_value_usd: float,
        cash_balance: float,
    ) -> bool:
        try:
            self._authed_table(access_token, "sim_equity_curve").insert({
                "user_id": user_id,
                "portfolio_id": portfolio_id,
                "total_value_usd": float(total_value_usd),
                "cash_balance": float(cash_balance),
            }).execute()
            return True
        except Exception as exc:
            logger.exception("sim_insert_equity_point failed: %s", exc)
            return False

    def sim_execute_order(
        self,
        access_token: str,
        symbol: str,
        side: str,
        price: float,
        quantity: Optional[float] = None,
        amount_usd: Optional[float] = None,
        total_value_usd: Optional[float] = None,
        initial_cash: float = 100000.0,
    ) -> Dict[str, Any]:
        try:
            client = self._authed_client(access_token)
            payload = {
                "p_symbol": symbol,
                "p_side": side,
                "p_price": float(price),
                "p_quantity": float(quantity) if quantity is not None else None,
                "p_amount_usd": float(amount_usd) if amount_usd is not None else None,
                "p_total_value_usd": float(total_value_usd) if total_value_usd is not None else None,
                "p_initial_cash": float(initial_cash),
            }
            response = client.rpc("sim_execute_order", payload).execute()
            if response and response.data:
                return response.data if isinstance(response.data, dict) else response.data[0]
            return {}
        except Exception as exc:
            logger.exception("sim_execute_order failed: %s", exc)
            return {}

    def sim_reset_portfolio(self, access_token: str, initial_cash: float = 100000.0, total_value_usd: float = 100000.0) -> Dict[str, Any]:
        try:
            client = self._authed_client(access_token)
            response = client.rpc("sim_reset_portfolio", {
                "p_initial_cash": float(initial_cash),
                "p_total_value_usd": float(total_value_usd),
            }).execute()
            if response and response.data:
                return response.data if isinstance(response.data, dict) else response.data[0]
            return {}
        except Exception as exc:
            logger.exception("sim_reset_portfolio failed: %s", exc)
            return {}

    def create_conversation(self, user_id: str, title: Optional[str] = None, ai_model: str = "gpt-4o-mini") -> Optional[str]:
        try:
            response = self._table("ai_conversations").insert({
                "user_id": user_id,
                "conversation_title": title or f"Chat - {datetime.now().strftime('%Y-%m-%d %H:%M')}",
                "ai_model": ai_model,
            }).execute()
            return response.data[0]["id"] if response and response.data else None
        except Exception as exc:
            logger.exception("create_conversation failed: %s", exc)
            return None

    def create_conversation_authed(self, access_token: str, user_id: str, title: Optional[str] = None, ai_model: str = "gpt-4o-mini") -> Optional[str]:
        try:
            response = self._authed_table(access_token, "ai_conversations").insert({
                "user_id": user_id,
                "conversation_title": title or f"Chat - {datetime.now().strftime('%Y-%m-%d %H:%M')}",
                "ai_model": ai_model,
            }).execute()
            return response.data[0]["id"] if response and response.data else None
        except Exception as exc:
            logger.exception("create_conversation_authed failed: %s", exc)
            return None

    def save_message(
        self,
        conversation_id: str,
        user_id: str,
        message_type: str,
        content: str,
        tokens_used: int = 0,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> bool:
        payload = {
            "conversation_id": conversation_id,
            "user_id": user_id,
            "message_type": message_type,
            "content": content,
            "tokens_used": int(tokens_used or 0),
            "prompt_tokens": int(prompt_tokens or 0),
            "completion_tokens": int(completion_tokens or 0),
        }
        try:
            self._table("ai_messages").insert(payload).execute()
            return True
        except Exception as exc:
            logger.exception("save_message failed: %s", exc)
            return False

    def save_message_authed(
        self,
        access_token: str,
        conversation_id: str,
        user_id: str,
        message_type: str,
        content: str,
        tokens_used: int = 0,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> bool:
        payload = {
            "conversation_id": conversation_id,
            "user_id": user_id,
            "message_type": message_type,
            "content": content,
            "tokens_used": int(tokens_used or 0),
            "prompt_tokens": int(prompt_tokens or 0),
            "completion_tokens": int(completion_tokens or 0),
        }
        try:
            self._authed_table(access_token, "ai_messages").insert(payload).execute()
            return True
        except Exception as exc:
            logger.exception("save_message_authed failed: %s", exc)
            return False

    def get_conversation_history(self, conversation_id: str) -> List[Dict[str, Any]]:
        try:
            response = self._table("ai_messages").select("*").eq("conversation_id", conversation_id).order("created_at", desc=False).execute()
            return response.data or []
        except Exception as exc:
            logger.exception("get_conversation_history failed: %s", exc)
            return []

    def get_conversation_history_authed(self, access_token: str, conversation_id: str) -> List[Dict[str, Any]]:
        try:
            response = self._authed_table(access_token, "ai_messages").select("*").eq("conversation_id", conversation_id).order("created_at", desc=False).execute()
            return response.data or []
        except Exception as exc:
            logger.exception("get_conversation_history_authed failed: %s", exc)
            return []

    def insert_data(self, table_name: str, data: Dict[str, Any]) -> bool:
        try:
            self._table(table_name).insert(data).execute()
            return True
        except Exception as exc:
            logger.exception("insert_data failed for %s: %s", table_name, exc)
            return False

    def query_data(self, table_name: str, filters: Optional[Dict[str, Any]] = None, order_by: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        try:
            query = self._table(table_name).select("*")
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            if order_by:
                query = query.order(order_by, desc=True)
            if limit:
                query = query.limit(limit)
            response = query.execute()
            return response.data or []
        except Exception as exc:
            logger.exception("query_data failed for %s: %s", table_name, exc)
            return []

    def update_data(self, table_name: str, record_id: str, data: Dict[str, Any]) -> bool:
        try:
            self._table(table_name).update(data).eq("id", record_id).execute()
            return True
        except Exception as exc:
            logger.exception("update_data failed for %s: %s", table_name, exc)
            return False

    def delete_data(self, table_name: str, record_id: str) -> bool:
        try:
            self._table(table_name).delete().eq("id", record_id).execute()
            return True
        except Exception as exc:
            logger.exception("delete_data failed for %s: %s", table_name, exc)
            return False


def get_db() -> Optional[SupabaseDB]:
    db = SupabaseDB()
    return db if db else None
