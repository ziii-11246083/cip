"""
Prompt Builder — assembles system prompts with retrieved knowledge,
user context, citations, confidence notes, and token budget control.
Upgraded for hybrid RAG: handles original+rewritten queries, metadata-rich chunks,
retrieval confidence hints, and disciplined fallback wording.
"""

import logging
from typing import Any, Dict, List, Optional

from services.retrieval_service import RetrievalResult, get_retrieval

logger = logging.getLogger(__name__)

# Approximate char-to-token ratio for mixed Chinese/English text
CHARS_PER_TOKEN = 2.5
MAX_CONTEXT_TOKENS = 600
MAX_CONTEXT_CHARS = int(MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN)
MAX_TOTAL_TOKENS_HINT = 2500

# Confidence thresholds
LOW_CONFIDENCE_THRESHOLD = 0.3
HIGH_CONFIDENCE_THRESHOLD = 0.7


class PromptContext:
    """Structured prompt assembly context."""

    def __init__(self):
        self.system_parts: List[str] = []
        self.context_parts: List[str] = []
        self.user_parts: List[str] = []
        self.citations: List[str] = []
        self.confidence_note: str = ""
        self.fallback_note: str = ""

    def estimated_tokens(self) -> int:
        full = " ".join(self.system_parts + self.context_parts + self.user_parts)
        return int(len(full) / CHARS_PER_TOKEN)


class PromptBuilder:
    """
    Builds structured prompts for AI endpoints.
    Handles: system prompt, RAG context injection, user context,
    citation formatting, token budget control, and retrieval confidence.
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
        retrieval_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /api/ai-chat."""
        ctx = PromptContext()

        ctx.system_parts.append(
            f"你是 Smart Invest 的 AI 投資教練。使用者風險偏好為【{risk_profile}】。"
            "請用專業但易懂的中文回答，先分析風險再討論機會。"
            "不要推薦買賣時機、不要報明牌、不要建議槓桿。"
        )

        # Confidence note
        confidence = _estimate_confidence(retrieval_results, retrieval_meta)
        if confidence == "low":
            ctx.confidence_note = (
                "目前知識庫中與此問題直接相關的資訊有限，以下回答僅供參考。"
                "如有具體投資決策，建議額外查證。"
            )
        elif confidence == "medium":
            ctx.confidence_note = ""

        # RAG context
        injected_count = 0
        if retrieval_results:
            ctx.context_parts.append("參考以下知識庫內容輔助回答（請優先依據這些內容）：")
            chars_used = 0
            for r in retrieval_results:
                snippet = r.snippet[:300]
                if chars_used + len(snippet) > MAX_CONTEXT_CHARS:
                    break
                ctx.context_parts.append(f"- [{r.topic}] {snippet}")
                ctx.citations.append(f"知識庫: {r.source} ({r.topic})")
                chars_used += len(snippet)
                injected_count += 1
        else:
            ctx.fallback_note = "（目前無相關知識庫內容，請基於一般投資知識回答，並提醒使用者資訊可能不完整。）"

        # User context
        if user_context:
            ctx.user_parts.append("使用者資訊：")
            if user_context.get("holdings_summary"):
                ctx.user_parts.append(f"持倉摘要: {user_context['holdings_summary']}")
            if user_context.get("scenario"):
                ctx.user_parts.append(f"目前市場情境: {user_context['scenario']}")

        if ctx.confidence_note:
            ctx.context_parts.append(f"\n{ctx.confidence_note}")
        if ctx.fallback_note:
            ctx.context_parts.append(f"\n{ctx.fallback_note}")

        if ctx.estimated_tokens() > MAX_TOTAL_TOKENS_HINT:
            logger.warning("Prompt exceeds token budget, truncating context")
            ctx.context_parts = ctx.context_parts[:3]

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "user_message": user_message,
            "confidence": confidence,
            "injected_count": injected_count,
        }

    def build_agent_prompt(
        self,
        goal: str,
        risk_profile: str,
        budget: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
        retrieval_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /api/agent-plan."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是 Smart Invest 的 AI Agent，負責將使用者任務拆成可執行的行動計畫。"
            f"使用者風格為【{risk_profile}】，預算範圍約【{budget}】。"
        )

        injected_count = 0
        if retrieval_results:
            ctx.context_parts.append("參考知識庫（請優先依據這些內容規劃）：")
            chars_used = 0
            for r in retrieval_results:
                snippet = r.snippet[:250]
                if chars_used + len(snippet) > MAX_CONTEXT_CHARS:
                    break
                ctx.context_parts.append(f"- [{r.topic}] {snippet}")
                ctx.citations.append(f"{r.source}")
                chars_used += len(snippet)
                injected_count += 1

        confidence = _estimate_confidence(retrieval_results, retrieval_meta)
        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "goal": goal,
            "confidence": confidence,
            "injected_count": injected_count,
        }

    def build_podcast_prompt(
        self,
        topic: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
        market_context: Optional[str] = None,
        retrieval_meta: Optional[Dict[str, Any]] = None,
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
            ctx.context_parts.append("風格與知識參考（請遵循此風格）：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:250]}")

        # podcast 風格段落無字數預算截斷 → 全部 retrieved 均為 injected
        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "topic": topic,
            "injected_count": len(retrieval_results) if retrieval_results else 0,
        }

    def build_health_prompt(
        self,
        risk_health: Dict[str, Any],
        holdings_text: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
        retrieval_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /portfolio/analyze-llm."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是專業的加密貨幣財富管理顧問。請用白話中文分析以下投資配置。"
            "先總結風險，再給調整建議。數字部分已由系統計算，你只需要解釋含義。"
            "若知識庫資訊不足以支撐具體建議，請明確告知使用者。"
        )

        ctx.user_parts.append(
            f"持幣: {holdings_text}\n"
            f"Top1佔比: {risk_health.get('top1_weight', 0):.2f}\n"
            f"年化波動: {risk_health.get('annual_vol', 0):.2f}\n"
            f"最大回撤: {risk_health.get('max_drawdown', 0):.2f}"
        )

        if retrieval_results:
            ctx.context_parts.append("參考知識（請依據這些指標解讀原則分析）：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:200]}")

        # health 段落無字數預算截斷 → 全部 retrieved 均為 injected
        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "metrics": risk_health,
            "injected_count": len(retrieval_results) if retrieval_results else 0,
        }

    def build_scam_prompt(
        self,
        content: str,
        retrieval_results: Optional[List[RetrievalResult]] = None,
        retrieval_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build prompt for /api/scam-scan."""
        ctx = PromptContext()

        ctx.system_parts.append(
            "你是加密貨幣安全分析師。請根據使用者提供的內容判斷潛在詐騙風險。"
            "若無法確定，請保守評估為中度風險，並建議使用者進一步查證。"
        )

        if retrieval_results:
            ctx.context_parts.append("參考詐騙模式知識（輔助判斷）：")
            for r in retrieval_results:
                ctx.context_parts.append(f"- [{r.topic}] {r.snippet[:250]}")

        return {
            "system": ctx.system_parts,
            "context": ctx.context_parts,
            "citations": ctx.citations,
            "content": content,
        }

    @staticmethod
    def format_citation_hint(citations: List[str]) -> str:
        """Build a compact citation/footer line."""
        if not citations:
            return ""
        unique = list(dict.fromkeys(citations))[:3]
        return "（參考資料：" + "、".join(unique) + "）"

    @staticmethod
    def format_fallback_context(reason: str = "retrieval_unavailable") -> str:
        """Return a minimal fallback context string."""
        fallbacks = {
            "retrieval_unavailable": "（知識庫暫時無法使用，以下回答基於一般投資知識。）",
            "no_results": "（知識庫中無相關內容，以下回答基於一般知識，請自行查證。）",
            "low_confidence": "（知識庫資訊有限，以下分析僅供參考，不構成投資建議。）",
        }
        return fallbacks.get(reason, fallbacks["retrieval_unavailable"])


def _estimate_confidence(
    results: Optional[List[RetrievalResult]],
    meta: Optional[Dict[str, Any]],
) -> str:
    """Estimate retrieval confidence: high/medium/low."""
    if not results:
        return "low"

    avg_score = sum(r.score for r in results) / len(results) if results else 0

    if meta:
        method = meta.get("method", "keyword")
        if method == "keyword" and avg_score < 4:
            return "low"
        if method in ("hybrid", "hybrid_rrf") and avg_score > 0.5:
            return "high"
        if avg_score > 0.4:
            return "medium"

    if avg_score < LOW_CONFIDENCE_THRESHOLD:
        return "low"
    elif avg_score > HIGH_CONFIDENCE_THRESHOLD:
        return "high"
    return "medium"
