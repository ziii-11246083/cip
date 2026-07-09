"""
AI Guardrails — safety checks applied before/after LLM calls.
Ensures AI outputs comply with platform safety rules.
"""

import logging
import re
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# ── forbidden patterns ──────────────────────────────────────

FORBIDDEN_INPUT_PATTERNS = [
    (r"(ignore|forget|disregard).*(instruction|rule|prompt|system)", "prompt injection"),
    (r"you are now DAN", "jailbreak attempt"),
    (r"pretend you are", "role impersonation"),
]

FORBIDDEN_OUTPUT_PATTERNS = [
    (r"(保證|一定|肯定).{0,10}(獲利|賺錢|獲益|盈利|收益)", "guaranteed profit claim"),
    (r"(推薦|建議)(你|大家)(買入|買進|all.?in|全倉)", "buy recommendation"),
    (r"目標價.*\d{2,}.*(美元|usd|美金)", "price target prediction"),
    (r"(開|使用).*(槓桿|倍|倍數).*(合約|交易)", "leverage recommendation"),
    (r"(內幕|內部).*(消息|資訊)", "insider info claim"),
    (r"我(保證|承諾|擔保)", "personal guarantee"),
    (r"daily.*\d+%.*return|每天.*\d+%.*報酬", "fixed return claim"),
]

# ── scam-related: must not downplay ──────────────────────────

SCAM_RISK_WORDS = {
    "詐騙", "scam", "風險", "risk", "honeypot", "rug", "釣魚",
    "phishing", "助記詞", "seed phrase", "私鑰", "private key",
}


class GuardrailResult:
    def __init__(self, passed: bool, reason: str = "", flagged: str = ""):
        self.passed = passed
        self.reason = reason
        self.flagged = flagged


def check_input(user_message: str) -> GuardrailResult:
    """Check user input for prompt injection / jailbreak attempts."""
    if not user_message:
        return GuardrailResult(True)
    msg_lower = user_message.lower()
    for pattern, label in FORBIDDEN_INPUT_PATTERNS:
        if re.search(pattern, msg_lower, re.IGNORECASE):
            logger.warning("Guardrail blocked input: %s", label)
            return GuardrailResult(False, f"輸入內容觸發安全過濾（{label}），請重新輸入。", label)
    return GuardrailResult(True)


def check_output(ai_response: str, context: str = "") -> GuardrailResult:
    """
    Check AI output for safety violations.
    context='scam' → extra strict on downplaying risks.
    """
    if not ai_response:
        return GuardrailResult(True)

    for pattern, label in FORBIDDEN_OUTPUT_PATTERNS:
        if re.search(pattern, ai_response, re.IGNORECASE):
            logger.warning("Guardrail flagged output: %s", label)
            return GuardrailResult(False, f"AI 輸出觸發安全過濾（{label}），已攔截。", label)

    # scam context: verify risk words aren't replaced with vague language
    if context == "scam":
        has_risk_words = any(w.lower() in ai_response.lower() for w in SCAM_RISK_WORDS)
        vague_phrases = ["可能安全", "應該沒問題", "不用擔心", "可以放心", "絕對安全"]
        has_vague = any(p in ai_response for p in vague_phrases)
        if has_vague and not has_risk_words:
            return GuardrailResult(False, "詐騙檢測回覆過於模糊，請明確標示風險。", "scam_downplay")

    return GuardrailResult(True)


def sanitize_response(ai_response: str) -> str:
    """Strip common problematic patterns without blocking the whole response."""
    sanitized = ai_response
    # remove disclaimer-avoidance patterns
    sanitized = re.sub(r"(?i)(as an AI|作為一個AI).*?(i can|我可以)", "", sanitized)
    return sanitized.strip()


def safe_fallback_response(context: str = "chat") -> str:
    """Return a safe fallback message when guardrails block output."""
    fallbacks = {
        "chat": "抱歉，我無法產生符合安全規範的回覆。請換個方式提問，或諮詢專業財務顧問。",
        "scam": "⚠️ 檢測到潛在風險。建議你不要與此對象進一步互動，並自行查證相關資訊。",
        "podcast": "本集內容因安全過濾未通過，請重新生成或更換主題。",
        "health": "健康度分析因安全限制無法完成，請檢查配置內容後重試。",
    }
    return fallbacks.get(context, fallbacks["chat"])
