"""
在 Flask 應用中使用 Supabase 的完整範例
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime
import logging

# 匯入 Supabase 客戶端
from supabase_client import get_db

# 設定日誌
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# 初始化 Supabase 連接
db = get_db()

# ==========================================
# 🔑 用戶相關 API
# ==========================================

@app.route("/api/auth/signup", methods=["POST"])
def signup():
    """用戶註冊"""
    try:
        data = request.json
        email = data.get("email")
        password = data.get("password")
        username = data.get("username")
        
        result = db.create_user(email, password, username)
        
        if result["success"]:
            return jsonify({"success": True, "user_id": result["user_id"]}), 201
        else:
            return jsonify({"success": False, "error": result["error"]}), 400
    
    except Exception as e:
        logger.error(f"❌ 註冊失敗: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/users/<user_id>/profile", methods=["GET"])
def get_profile(user_id):
    """取得用戶檔案"""
    try:
        profile = db.get_user_profile(user_id)
        if profile:
            return jsonify(profile), 200
        else:
            return jsonify({"error": "用戶不存在"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/users/<user_id>/preferences", methods=["PUT"])
def update_preferences(user_id):
    """更新用戶偏好"""
    try:
        preferences = request.json
        success = db.update_user_preferences(user_id, preferences)
        
        if success:
            return jsonify({"message": "✅ 偏好已更新"}), 200
        else:
            return jsonify({"error": "更新失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 💰 加密貨幣相關 API
# ==========================================

@app.route("/api/crypto/<symbol>", methods=["GET"])
def get_crypto_info(symbol):
    """取得加密幣信息和最新價格"""
    try:
        latest_price = db.get_latest_price(symbol)
        
        if latest_price:
            return jsonify(latest_price), 200
        else:
            return jsonify({"error": f"找不到 {symbol} 的價格"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/crypto/price/add", methods=["POST"])
def add_price_data():
    """新增加密幣價格數據 (通常由後台任務調用)"""
    try:
        data = request.json
        symbol = data.get("symbol")
        
        price_data = {
            "price": data.get("price"),
            "market_cap": data.get("market_cap"),
            "volume_24h": data.get("volume_24h"),
            "price_change_24h": data.get("price_change_24h"),
            "price_change_7d": data.get("price_change_7d"),
            "timestamp": datetime.utcnow().isoformat()
        }
        
        success = db.insert_price_data(symbol, price_data)
        
        if success:
            return jsonify({"message": "✅ 價格已保存"}), 201
        else:
            return jsonify({"error": "保存失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 📊 AI 報告相關 API
# ==========================================

@app.route("/api/reports/<symbol>", methods=["GET"])
def get_latest_report(symbol):
    """取得最新的 AI 報告"""
    try:
        report = db.get_latest_report(symbol)
        
        if report:
            return jsonify(report), 200
        else:
            return jsonify({"error": f"找不到 {symbol} 的報告"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/save", methods=["POST"])
def save_report():
    """保存 AI 生成的報告"""
    try:
        data = request.json
        symbol = data.get("symbol")
        
        report_data = {
            "report_title": data.get("report_title"),
            "report_content": data.get("report_content"),
            "summary": data.get("summary"),
            "sentiment_score": data.get("sentiment_score"),
            "sentiment_label": data.get("sentiment_label"),
            "key_insights": data.get("key_insights"),
            "risks": data.get("risks"),
            "opportunities": data.get("opportunities"),
            "generated_by": data.get("generated_by", "openai_gpt4"),
            "confidence_score": data.get("confidence_score")
        }
        
        success = db.save_crypto_report(symbol, report_data)
        
        if success:
            return jsonify({"message": "✅ 報告已保存"}), 201
        else:
            return jsonify({"error": "保存失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 💬 情緒分析相關 API
# ==========================================

@app.route("/api/sentiment/<symbol>", methods=["GET"])
def get_sentiment(symbol):
    """取得加密幣的情緒分析趨勢"""
    try:
        time_period = request.args.get("period", "24h")
        trends = db.get_sentiment_trends(symbol, time_period)
        
        if trends:
            return jsonify({"symbol": symbol, "trends": trends}), 200
        else:
            return jsonify({"error": f"找不到 {symbol} 的情緒數據"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/sentiment/save", methods=["POST"])
def save_sentiment():
    """保存情緒分析結果"""
    try:
        data = request.json
        symbol = data.get("symbol")
        
        sentiment_data = {
            "source": data.get("source", "general"),
            "sentiment_score": data.get("sentiment_score"),
            "mention_count": data.get("mention_count", 0),
            "positive_mentions": data.get("positive_mentions", 0),
            "negative_mentions": data.get("negative_mentions", 0),
            "neutral_mentions": data.get("neutral_mentions", 0),
            "top_keywords": data.get("top_keywords"),
            "top_hashtags": data.get("top_hashtags"),
            "time_period": data.get("time_period", "24h")
        }
        
        success = db.save_sentiment_analysis(symbol, sentiment_data)
        
        if success:
            return jsonify({"message": "✅ 情緒分析已保存"}), 201
        else:
            return jsonify({"error": "保存失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 🎯 用戶互動相關 API
# ==========================================

@app.route("/api/activity/log", methods=["POST"])
def log_activity():
    """記錄用戶活動"""
    try:
        data = request.json
        user_id = data.get("user_id")
        
        activity_data = {
            "symbol": data.get("symbol"),
            "activity_type": data.get("activity_type"),
            "activity_data": data.get("activity_data"),
            "ip_address": request.remote_addr,
            "user_agent": request.headers.get("User-Agent")
        }
        
        success = db.log_user_activity(user_id, activity_data)
        
        if success:
            return jsonify({"message": "✅ 活動已記錄"}), 201
        else:
            return jsonify({"error": "記錄失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/watchlist/<user_id>", methods=["GET"])
def get_watchlist(user_id):
    """取得用戶的觀察列表"""
    try:
        watchlist = db.get_user_watchlist(user_id)
        return jsonify({"user_id": user_id, "watchlist": watchlist}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/watchlist/add", methods=["POST"])
def add_watchlist():
    """新增到觀察列表"""
    try:
        data = request.json
        user_id = data.get("user_id")
        symbol = data.get("symbol")
        watchlist_name = data.get("watchlist_name", "My Watchlist")
        
        success = db.add_to_watchlist(user_id, symbol, watchlist_name)
        
        if success:
            return jsonify({"message": f"✅ {symbol} 已新增到觀察列表"}), 201
        else:
            return jsonify({"error": "新增失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 🤖 AI 對話相關 API
# ==========================================

@app.route("/api/chat/start", methods=["POST"])
def start_conversation():
    """開始新對話"""
    try:
        data = request.json
        user_id = data.get("user_id")
        title = data.get("title")
        ai_model = data.get("ai_model", "gpt-4")
        
        conv_id = db.create_conversation(user_id, title, ai_model)
        
        if conv_id:
            return jsonify({"conversation_id": conv_id}), 201
        else:
            return jsonify({"error": "建立對話失敗"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/chat/<conversation_id>/send", methods=["POST"])
def send_message(conversation_id):
    """發送聊天消息"""
    try:
        data = request.json
        user_id = data.get("user_id")
        content = data.get("content")
        message_type = data.get("message_type", "user")
        tokens_used = data.get("tokens_used", 0)
        
        # 保存用戶消息
        db.save_message(conversation_id, user_id, "user", content)
        
        # TODO: 呼叫 OpenAI API 取得回應
        # ai_response = call_openai(content)
        
        # 保存 AI 回應
        ai_response = "這是 AI 的回應"  # 替換為實際的 AI 回應
        db.save_message(conversation_id, user_id, "assistant", ai_response, tokens_used)
        
        return jsonify({
            "user_message": content,
            "ai_response": ai_response
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/chat/<conversation_id>/history", methods=["GET"])
def get_history(conversation_id):
    """取得對話歷史"""
    try:
        history = db.get_conversation_history(conversation_id)
        return jsonify({"conversation_id": conversation_id, "messages": history}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# 🔧 通用 API (用於測試和調試)
# ==========================================

@app.route("/api/query/<table_name>", methods=["GET"])
def query_table(table_name):
    """通用查詢端點 (需要授權驗證)"""
    try:
        filters = request.args.to_dict() or None
        limit = request.args.get("limit", type=int)
        
        data = db.query_data(table_name, filters, limit=limit)
        return jsonify({"table": table_name, "count": len(data), "data": data}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health_check():
    """健康檢查端點"""
    return jsonify({
        "status": "✅ 健康",
        "database": "Supabase",
        "timestamp": datetime.utcnow().isoformat()
    }), 200


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
