"""
Query Rewrite / Expansion Service — low-risk query enhancement for better retrieval.
Strategy: alias expansion, topic synonym expansion, domain lexicon, endpoint-specific.
LLM-based rewrite is optional and off by default.
All rewrites are guarded by embedding similarity check against original query.
"""

import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ── domain lexicon ────────────────────────────────────────────

_ALIAS_MAP: Dict[str, List[str]] = {
    "btc": ["bitcoin", "比特幣", "BTC"],
    "eth": ["ethereum", "以太幣", "以太坊", "ETH"],
    "sol": ["solana", "索拉納", "SOL"],
    "doge": ["dogecoin", "狗狗幣", "DOGE"],
    "ai": ["人工智慧", "AI", "人工智慧幣", "FET", "RNDR"],
    "rwa": ["真實資產", "real world assets", "RWA", "ONDO"],
    "defi": ["去中心化金融", "DeFi", "UNI", "AAVE"],
    "l2": ["layer2", "二層網路", "L2", "ARB", "OP"],
    "meme": ["迷因幣", "meme coin", "DOGE", "PEPE"],
    "sfi": ["風險分數", "SFI", "Smart Invest Fear Index"],
    "fomo": ["錯失恐懼", "FOMO", "追高"],
    "dca": ["定期定額", "分批進場", "DCA"],
    "defi": ["去中心化金融", "DeFi"],
    "nft": ["非同質化代幣", "NFT"],
}

_TOPIC_SYNONYMS: Dict[str, List[str]] = {
    "投資原則": ["投資策略", "配置原則", "投資方法", "進場策略", "資金管理"],
    "詐騙": ["騙局", "scam", "詐欺", "honeypot", "rug pull", "釣魚"],
    "風險": ["風控", "risk", "波動", "回撤", "虧損"],
    "健康度": ["配置健康", "組合分析", "portfolio health", "集中度"],
    "市場": ["行情", "market", "趨勢", "走勢", "大盤"],
    "停損": ["止損", "stop loss", "出場", "停利"],
    "牛市": ["bull market", "多頭", "上漲"],
    "熊市": ["bear market", "空頭", "下跌"],
    "穩定幣": ["stablecoin", "USDT", "USDC", "現金部位"],
}

# ── endpoint-specific expansion patterns ──────────────────────

_ENDPOINT_PATTERNS: Dict[str, List[Tuple[str, str]]] = {
    "chat": [
        (r"(怎麼看|如何看|分析一下)\s*(\w+)", r"\1 \2 風險 前景 基本面"),
        (r"(買|賣|進場|出場)", r"\1 時機 策略 風險"),
    ],
    "scam": [
        (r"(安全|不安全|可疑)", r"\1 詐騙 合約 風險"),
        (r"(這個|這)(項目|幣|連結|網站)", r"\1\2 詐騙 檢測 安全性"),
    ],
    "podcast": [
        (r"(今天|最近|目前)\s*(市場|行情)", r"\1\2 敘事 熱點 事件"),
    ],
    "health": [
        (r"(組合|配置|持倉)", r"\1 集中度 波動 健康度"),
        (r"(風險|安全)", r"\1 回撤 波動率"),
    ],
    "agent": [
        (r"(規劃|策略|建議)", r"\1 配置 風險 分散"),
        (r"(投資|資產)\s*(配置|分配)", r"\1\2 比例 分散 風控"),
    ],
}


class QueryRewriteResult:
    """Result of query rewrite/expansion."""

    def __init__(
        self,
        original: str,
        rewritten: str,
        used: bool = False,
        rejected: bool = False,
        similarity: float = 1.0,
        method: str = "none",
    ):
        self.original = original
        self.rewritten = rewritten
        self.used = used
        self.rejected = rejected
        self.similarity = similarity
        self.method = method

    def to_dict(self) -> Dict[str, Any]:
        return {
            "original": self.original,
            "rewritten": self.rewritten,
            "used": self.used,
            "rejected": self.rejected,
            "similarity": self.similarity,
            "method": self.method,
        }


class QueryRewriteService:
    """
    Query rewrite/expansion with guardrails.
    Default: rule-based expansion only (alias + synonym + domain).
    Optional LLM rewrite behind config flag.
    """

    def __init__(
        self,
        sim_threshold: Optional[float] = None,
        enable_llm_rewrite: Optional[bool] = None,
    ):
        self._sim_threshold = sim_threshold or float(
            os.getenv("RAG_REWRITE_SIM_THRESHOLD", "0.6")
        )
        self._enable_llm = enable_llm_rewrite or (
            os.getenv("RAG_ENABLE_LLM_REWRITE", "0") == "1"
        )
        self._embedding = None  # Lazy import to avoid circular

    # ── public API ────────────────────────────────────────────────

    def rewrite(
        self, query: str, endpoint: str = "chat"
    ) -> QueryRewriteResult:
        """
        Rewrite/expand a query for the given endpoint.
        Returns QueryRewriteResult.
        """
        if not query or not query.strip():
            return QueryRewriteResult(
                original=query, rewritten=query, method="none"
            )

        query = query.strip()

        # Step 1: Rule-based expansion (always safe)
        expanded = self._rule_expand(query, endpoint)

        # Step 2: If expanded is different, verify similarity
        if expanded != query:
            sim = self._check_similarity(query, expanded)
            if sim < self._sim_threshold:
                logger.info(
                    "Rewrite rejected: similarity=%.3f < threshold=%.3f",
                    sim, self._sim_threshold
                )
                return QueryRewriteResult(
                    original=query,
                    rewritten=expanded,
                    used=False,
                    rejected=True,
                    similarity=sim,
                    method="rule_rejected",
                )
            return QueryRewriteResult(
                original=query,
                rewritten=expanded,
                used=True,
                similarity=sim,
                method="rule",
            )

        # Step 3: Optional LLM rewrite
        if self._enable_llm:
            llm_result = self._llm_rewrite(query, endpoint)
            if llm_result:
                return llm_result

        return QueryRewriteResult(
            original=query, rewritten=query, method="none"
        )

    # ── internal ──────────────────────────────────────────────────

    def _rule_expand(self, query: str, endpoint: str) -> str:
        """Rule-based query expansion."""
        tokens = [query]
        q_lower = query.lower()

        # Alias expansion
        for alias, expansions in _ALIAS_MAP.items():
            if alias in q_lower:
                for exp in expansions:
                    if exp.lower() not in q_lower:
                        tokens.append(exp)

        # Topic synonym expansion
        for topic, synonyms in _TOPIC_SYNONYMS.items():
            for syn in synonyms:
                if syn in query or (syn.lower() in q_lower):
                    if topic not in " ".join(tokens):
                        tokens.append(topic)
                    break

        # Endpoint-specific expansion
        if endpoint in _ENDPOINT_PATTERNS:
            for pattern, replacement in _ENDPOINT_PATTERNS[endpoint]:
                if re.search(pattern, query):
                    expanded = re.sub(pattern, replacement, query)
                    if expanded != query:
                        tokens.append(expanded)

        # Deduplicate while preserving order
        seen = set()
        result = []
        for t in tokens:
            if t not in seen:
                seen.add(t)
                result.append(t)

        return " ".join(result)

    def _check_similarity(self, original: str, rewritten: str) -> float:
        """Check embedding similarity between original and rewritten query."""
        try:
            from services.embedding_service import get_embedding_service
            if self._embedding is None:
                self._embedding = get_embedding_service()

            if not self._embedding.available:
                # No embeddings → use Jaccard as fallback
                return self._jaccard_similarity(original, rewritten)

            emb1 = self._embedding.embed_query(original)
            emb2 = self._embedding.embed_query(rewritten)
            if emb1 and emb2:
                return self._embedding.similarity(emb1, emb2)
        except Exception as exc:
            logger.warning("Similarity check failed, using Jaccard: %s", exc)

        return self._jaccard_similarity(original, rewritten)

    @staticmethod
    def _jaccard_similarity(a: str, b: str) -> float:
        """Fallback Jaccard similarity on word-level tokens."""
        a_tokens = set(a.lower().split())
        b_tokens = set(b.lower().split())
        if not a_tokens or not b_tokens:
            return 0.0
        # Blend word-level and char-bigram Jaccard for robustness
        word_jaccard = len(a_tokens & b_tokens) / len(a_tokens | b_tokens)

        def bigrams(s):
            return set(s[i:i+2] for i in range(len(s) - 1))
        ba = bigrams(a.lower())
        bb = bigrams(b.lower())
        char_jaccard = len(ba & bb) / len(ba | bb) if (ba and bb) else 0.0

        return 0.6 * word_jaccard + 0.4 * char_jaccard

    def _llm_rewrite(self, query: str, endpoint: str) -> Optional[QueryRewriteResult]:
        """Optional LLM-based query rewrite."""
        try:
            api_key = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
            if not api_key or "sk-" not in api_key:
                return None

            from openai import OpenAI
            client = OpenAI(api_key=api_key)
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[{
                    "role": "system",
                    "content": (
                        "Rewrite the user query to improve retrieval. "
                        "Expand abbreviations, add relevant synonyms, "
                        "but keep the core meaning identical. "
                        "Output ONLY the rewritten query, nothing else."
                    ),
                }, {
                    "role": "user",
                    "content": f"Query: {query}\nEndpoint: {endpoint}",
                }],
                max_tokens=150,
                temperature=0.3,
            )
            rewritten = resp.choices[0].message.content.strip()
            if not rewritten or rewritten == query:
                return None

            sim = self._check_similarity(query, rewritten)
            if sim < self._sim_threshold:
                return QueryRewriteResult(
                    original=query, rewritten=rewritten,
                    used=False, rejected=True, similarity=sim,
                    method="llm_rejected",
                )
            return QueryRewriteResult(
                original=query, rewritten=rewritten,
                used=True, similarity=sim, method="llm",
            )
        except Exception as exc:
            logger.warning("LLM rewrite failed: %s", exc)
            return None


# ── singleton ────────────────────────────────────────────────────

_rewriter: Optional[QueryRewriteService] = None


def get_rewriter() -> QueryRewriteService:
    global _rewriter
    if _rewriter is None:
        _rewriter = QueryRewriteService()
    return _rewriter
