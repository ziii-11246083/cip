"""
Prompt Builder — assembles system prompts with retrieved knowledge,
user context, citations, and token budget control.
"""

import logging
from typing import Any, Dict, List, Optional

from services.retrieval_service import RetrievalResult, get_retrieval

logger = logging.getLogger(__name__)

# Approximate char-to-token ratio for mixed Chinese/English text
CHARS_PER_TOKEN = 2.5
MAX_CONTEXT_TOKENS = 600
MAX_TOTAL_TOKENS_HINT = 2500


class PromptContext:
    """Structured prompt assembly context."""
    def __init__(self):
        self.system_parts: List[str] = []
        self.context_parts: List[str] = []
        self.user_parts: List[str] = []
        self.citations: List[str] = []

    def estimated_tokens(self) -> int:
        full = " ".join(self.system_parts + self.context_parts + self.user_parts)
        return int(len(full) / CHARS_PER_TOKEN)


class PromptBuilder:
    """
    Builds structured prompts for AI endpoints.
    Handles: system prompt, RAG context injection, user context,
    citation formatting, and token budget control.
    """

    def __init__(self):
        self._retrieval = get_retrieval()

    # ── public builders ─────────────────────────────────────────

    def build_chat_prompt(
        self,
        user_message: str,
        risk_profile: str = "穩健型",
        retrieval_results: Optional[List[RetrievalResult]] = None,
        user_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /api/ai-chat."""
        ctx = PromptContext()

        # system
        ctx.system_parts.append(
            f"你是 Smart Invest 的 AI 投資教練。使用者風險偏好為【{risk_profile}】。"
            "請用專業但易懂的中文回答，先分析風險再討論機會。"
            "不要推薦買賣時機、不要報明牌、不要建議槓桿。"
        )

        # RAG context
        if retrieval_results:
            ctx.context_parts.append("參考以下知識庫內容輔助回答：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:300]}")
                ctx.citations.append(f"知識庫: {r.source} ({r.topic})")

        # user context
        if user_context:
            ctx.user_parts.append("使用者資訊：")
            if user_context.get("holdings_summary"):
                ctx.user_parts.append(f"持倉摘要: {user_context['holdings_summary']}")
            if user_context.get("scenario"):
                ctx.user_parts.append(f"目前市場情境: {user_context['scenario']}")

        if ctx.estimated_tokens() > MAX_TOTAL_TOKENS_HINT:
            logger.warning("Prompt exceeds token budget, truncating context")
            ctx.context_parts = ctx.context_parts[:3]

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "user_message": user_message,
        }

    def build_agent_prompt(
        self,
        goal: str,
        risk_profile: str,
        budget: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /api/agent-plan."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是 Smart Invest 的 AI Agent，負責將使用者任務拆成可執行的行動計畫。"
            f"使用者風格為【{risk_profile}】，預算範圍約【{budget}】。"
        )

        if retrieval_results:
            ctx.context_parts.append("參考知識庫：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:250]}")
                ctx.citations.append(f"{r.source}")

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "goal": goal,
        }

    def build_podcast_prompt(
        self,
        topic: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
        market_context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /podcast/generate."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是 Smart Invest 的 Podcast 編劇。請生成一段 Nova（主持人）與 Onyx（分析師）"
            "的雙人對話稿，每段對話不超過 3-4 句，節奏明快、口語自然。"
            "開場加入日期與市場概覽，結尾加入投資提醒免責聲明。"
            "不要做價格預測、不推薦買賣、不使用 FOMO 語言。"
        )

        if market_context:
            ctx.context_parts.append(f"目前市場資訊：{market_context[:400]}")

        if retrieval_results:
            ctx.context_parts.append("風格與知識參考：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:250]}")

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "topic": topic,
        }

    def build_health_prompt(
        self,
        risk_health: Dict[str, Any],
        holdings_text: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /portfolio/analyze-llm."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是專業的加密貨幣財富管理顧問。請用白話中文分析以下投資配置。"
            "先總結風險，再給調整建議。數字部分已由系統計算，你只需要解釋含義。"
        )

        ctx.user_parts.append(
            f"持幣: {holdings_text}\n"
            f"Top1佔比: {risk_health.get('top1_weight', 0):.2f}\n"
            f"年化波動: {risk_health.get('annual_vol', 0):.2f}\n"
            f"最大回撤: {risk_health.get('max_drawdown', 0):.2f}"
        )

        if retrieval_results:
            ctx.context_parts.append("參考知識：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:200]}")

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "metrics": risk_health,
        }

    @staticmethod
    def format_citation_hint(citations: List[str]) -> str:
        """Build a compact citation/footer line."""
        if not citations:
            return ""
        unique = list(dict.fromkeys(citations))[:3]
        return "（參考資料：" + "、".join(unique) + "）"
