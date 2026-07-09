let sfiChart = null;
let copulaChart = null;
let mcChart = null;

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function setStatus(text) {
  setText("analysisStatus", text);
}

function setEmpty(id, message, show) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("is-hidden", !show);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percentLabel(value) {
  const number = finiteNumber(value);
  return `${(number * 100).toFixed(2)}%`;
}

function moneyLabel(value) {
  const number = finiteNumber(value);
  return `$${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function destroyChart(chart) {
  if (chart) chart.destroy();
}

function chartUnavailable() {
  return typeof Chart === "undefined";
}

function drawSfiChart(riskData) {
  const canvas = $("sfiRiskChart");
  if (!canvas) return;

  const score = finiteNumber(riskData.score);
  const beta = finiteNumber(riskData.beta);
  const lambda = finiteNumber(riskData.lambda);
  const corr = finiteNumber(riskData.corr);

  setText("sfiScoreLabel", `${Math.round(score)}/100`);
  if (chartUnavailable()) {
    setEmpty("sfiChartEmpty", "Chart.js 尚未載入，請重新整理頁面。", true);
    return;
  }

  destroyChart(sfiChart);
  setEmpty("sfiChartEmpty", "", false);
  sfiChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["SFI 分數", "BTC 相關性", "Beta", "尾端連動"],
      datasets: [{
        label: "風險指標",
        data: [score, corr * 100, beta * 50, lambda * 100],
        backgroundColor: ["#E76F51", "#2A9D8F", "#457B9D", "#F4A261"],
        borderRadius: 8,
        maxBarThickness: 32
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.label;
              if (label === "SFI 分數") return `${score.toFixed(0)} / 100`;
              if (label === "BTC 相關性") return corr.toFixed(2);
              if (label === "Beta") return beta.toFixed(2);
              return lambda.toFixed(2);
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, max: 100, grid: { color: "rgba(80,64,44,.12)" } },
        y: { grid: { display: false } }
      }
    }
  });
}

function drawCopulaChart(payload, symbol) {
  const canvas = $("copulaChart");
  if (!canvas) return;

  const btcReturns = Array.isArray(payload.btc_returns) ? payload.btc_returns : [];
  const coinReturns = Array.isArray(payload.coin_returns) ? payload.coin_returns : [];
  const points = btcReturns
    .map((btc, index) => ({ x: finiteNumber(btc), y: finiteNumber(coinReturns[index]) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  const corr = finiteNumber(payload.risk_data && payload.risk_data.corr);
  setText("corrLabel", `corr ${corr.toFixed(2)}`);

  if (points.length < 3) {
    setEmpty("copulaChartEmpty", "目前沒有足夠報酬資料可畫相關性散點。", true);
    return;
  }

  if (chartUnavailable()) {
    setEmpty("copulaChartEmpty", "Chart.js 尚未載入，請重新整理頁面。", true);
    return;
  }

  destroyChart(copulaChart);
  setEmpty("copulaChartEmpty", "", false);
  copulaChart = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [{
        label: `${symbol} vs BTC`,
        data: points,
        pointRadius: 3,
        pointHoverRadius: 5,
        borderColor: "#457B9D",
        backgroundColor: "rgba(69,123,157,.55)"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return `BTC ${percentLabel(context.parsed.x)}, ${symbol} ${percentLabel(context.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: "BTC 日報酬" },
          ticks: { callback: (value) => `${(value * 100).toFixed(1)}%` },
          grid: { color: "rgba(80,64,44,.12)" }
        },
        y: {
          title: { display: true, text: `${symbol} 日報酬` },
          ticks: { callback: (value) => `${(value * 100).toFixed(1)}%` },
          grid: { color: "rgba(80,64,44,.12)" }
        }
      }
    }
  });
}

function drawMcChart(payload) {
  const canvas = $("mcChart");
  if (!canvas) return;

  const simulation = payload.simulation || {};
  const paths = Array.isArray(simulation.paths) ? simulation.paths : [];
  const meanPath = Array.isArray(simulation.mean_path) ? simulation.mean_path.map(finiteNumber) : [];
  const currentPrice = finiteNumber(simulation.current_price || meanPath[0]);
  const var95 = finiteNumber(simulation.var_95);

  setText("mcLabel", var95 ? `VaR ${moneyLabel(var95)}` : "--");

  if (meanPath.length < 2) {
    setEmpty("mcChartEmpty", "目前沒有足夠價格資料可做情境模擬。", true);
    return;
  }

  if (chartUnavailable()) {
    setEmpty("mcChartEmpty", "Chart.js 尚未載入，請重新整理頁面。", true);
    return;
  }

  const labels = meanPath.map((_, index) => index === 0 ? "今天" : `第 ${index} 天`);
  const sampledPaths = paths.slice(0, 12).map((path, index) => ({
    label: `情境 ${index + 1}`,
    data: path.map(finiteNumber),
    borderColor: "rgba(69,123,157,.18)",
    borderWidth: 1,
    pointRadius: 0,
    tension: .32
  }));

  destroyChart(mcChart);
  setEmpty("mcChartEmpty", "", false);
  mcChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        ...sampledPaths,
        {
          label: "平均路徑",
          data: meanPath,
          borderColor: "#E76F51",
          backgroundColor: "rgba(231,111,81,.12)",
          borderWidth: 3,
          pointRadius: 3,
          tension: .32
        },
        {
          label: "目前價格",
          data: meanPath.map(() => currentPrice),
          borderColor: "#2A9D8F",
          borderDash: [6, 6],
          borderWidth: 2,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            filter(item) {
              return item.text === "平均路徑" || item.text === "目前價格";
            }
          }
        },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${moneyLabel(context.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          ticks: { callback: (value) => moneyLabel(value) },
          grid: { color: "rgba(80,64,44,.12)" }
        }
      }
    }
  });
}

function setInsights(insights) {
  setHtml("ai-sfi-insight", insights.sfi || "目前沒有 AI SFI 分析資料。");
  setHtml("ai-copula-insight", insights.copula || "目前沒有相關性分析資料。");
  setHtml("ai-mc-insight", insights.mc || "目前沒有情境模擬分析資料。");
}

function setInsightErrors() {
  setHtml("ai-sfi-insight", '<i class="fas fa-circle-exclamation"></i> AI SFI 分析載入失敗，請稍後再試。');
  setHtml("ai-copula-insight", '<i class="fas fa-circle-exclamation"></i> 相關性分析載入失敗，請稍後再試。');
  setHtml("ai-mc-insight", '<i class="fas fa-circle-exclamation"></i> 情境模擬載入失敗，請稍後再試。');
}

async function loadAnalysis() {
  const symbol = String(window.__ANALYSIS_SYMBOL__ || "BTC").trim().toUpperCase() || "BTC";
  const endpoint = `/api/details/${encodeURIComponent(symbol)}`;

  setStatus("載入中");
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });

    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);

    const riskData = payload.risk_data || {};
    setInsights(payload.ai_insights || {});
    drawSfiChart(riskData);
    drawCopulaChart(payload, symbol);
    drawMcChart(payload);
    setStatus("已載入");
  } catch (error) {
    console.error("Failed to load analysis:", error);
    setStatus("載入失敗");
    setInsightErrors();
    setEmpty("sfiChartEmpty", "風險資料載入失敗，請稍後再試。", true);
    setEmpty("copulaChartEmpty", "相關性資料載入失敗，請稍後再試。", true);
    setEmpty("mcChartEmpty", "情境模擬資料載入失敗，請稍後再試。", true);
  }
}

window.addEventListener("DOMContentLoaded", loadAnalysis);
