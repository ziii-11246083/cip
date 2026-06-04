function setInsightText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
}

function setInsightError(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<i class="fas fa-circle-exclamation"></i> ${text}`;
}

async function loadAnalysisInsights() {
  const symbol = String(window.__ANALYSIS_SYMBOL__ || "BTC").trim() || "BTC";
  const endpoint = `/api/details/${encodeURIComponent(symbol)}`;

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache"
      }
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    const insights = payload && payload.ai_insights ? payload.ai_insights : {};

    setInsightText("ai-sfi-insight", insights.sfi || "目前沒有 AI SFI 分析資料。");
    setInsightText("ai-copula-insight", insights.copula || "目前沒有相關性分析資料。");
    setInsightText("ai-mc-insight", insights.mc || "目前沒有情境分析資料。");
  } catch (error) {
    console.error("Failed to load analysis insights:", error);
    setInsightError("ai-sfi-insight", "AI SFI 分析載入失敗，請稍後再試。");
    setInsightError("ai-copula-insight", "相關性分析載入失敗，請稍後再試。");
    setInsightError("ai-mc-insight", "情境分析載入失敗，請稍後再試。");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  loadAnalysisInsights();
});
