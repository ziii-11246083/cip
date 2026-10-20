(function () {
  const $ = (id) => document.getElementById(id);
  let equityChart = null;
  let allocChart = null;
  let coinOptions = [];
  let currentPortfolio = null;
  let lastStressResult = null;
  let stressRequestVersion = 0;
  let isLocked = false;
  let initialAuthState = null;
  let authReloadPending = false;
  let orderPending = false;
  let tradeHistory = [];
  let tradeSideFilter = "all";
  let marketChart = null;
  let stressChart = null;
  let equityDays = "all";
  let marketDays = 7;
  let marketRequestVersion = 0;
  let quoteRequestVersion = 0;
  let activeScenario = "normal";
  let scenarioData = {};
  let stressPending = false;
  const ASSET_COLORS = ["#ef8a3b", "#5e9685", "#debb7e", "#aa927e", "#8b9cbd", "#bb8ca4", "#8da878", "#c7a27a"];
  const SCENARIO_COLORS = { normal: "#827367", bull: "#167f68", bear: "#c48218", black_swan: "#c23e49" };
  const SCENARIO_LABELS = { normal: "一般市場", bull: "牛市", bear: "熊市", black_swan: "黑天鵝" };

  function finiteNumber(value) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function allocationData(snapshot) {
    if (!snapshot || snapshot.price_unavailable_symbols?.length) return null;
    const cash = finiteNumber(snapshot.cash);
    const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
    if (cash === null || cash < 0 || positions.some(pos => finiteNumber(pos.market_value) === null || Number(pos.market_value) < 0)) return null;
    const entries = positions.filter(pos => Number(pos.market_value) > 0).map((pos, index) => ({
      symbol: String(pos.symbol || "--"), value: Number(pos.market_value), color: ASSET_COLORS[index % ASSET_COLORS.length]
    }));
    if (cash > 0) entries.push({ symbol: "現金", value: cash, color: "#e8dbc9" });
    const total = entries.reduce((sum, item) => sum + item.value, 0);
    return { entries: entries.map(item => ({ ...item, pct: total > 0 ? item.value / total * 100 : 0 })), total, investedPct: total > 0 ? (total - cash) / total * 100 : null };
  }

  function equityData(snapshot, days = "all", now = Date.now()) {
    return (Array.isArray(snapshot?.equity_curve) ? snapshot.equity_curve : []).map((point, index) => ({
      value: finiteNumber(point.total_value_usd), date: window.SIFormat?.date(point.timestamp) || null, timestamp: point.timestamp, index
    })).filter(point => point.value !== null && point.value >= 0 && (days === "all" || (point.date && point.date.getTime() >= now - Number(days) * 86400000)))
      .sort((a, b) => a.date && b.date ? a.date - b.date : a.index - b.index);
  }

  function orderDraft() {
    const coin = getSelectedCoin(), symbol = String(coin.symbol || "BTC").toUpperCase();
    const price = finiteNumber(coin.current_price), cash = finiteNumber(currentPortfolio?.cash);
    const holdingQty = finiteNumber(getSelectedPosition(symbol)?.quantity) ?? 0;
    const quantityRaw = $("orderQty")?.value.trim() || "", amountRaw = $("orderAmt")?.value.trim() || "";
    const quantity = quantityRaw ? finiteNumber(quantityRaw) : amountRaw && price > 0 ? Number(amountRaw) / price : null;
    const amount = amountRaw ? finiteNumber(amountRaw) : quantity !== null && price > 0 ? quantity * price : null;
    const side = $("orderSide")?.value === "sell" ? "sell" : "buy";
    const available = side === "buy" ? cash : holdingQty;
    const used = side === "buy" ? amount : quantity;
    const valid = !isLocked && currentPortfolio !== null && price > 0 && amount > 0 && quantity > 0
      && !(quantityRaw && amountRaw) && available !== null && used <= available + 1e-8;
    return { symbol, price, cash, holdingQty, quantity, amount, side, valid, usedPct: available > 0 && used !== null ? used / available * 100 : 0 };
  }

  function scrollToSection(id) {
    const target = $(id);
    if (!target) return;
    const headerHeight = document.querySelector("header")?.getBoundingClientRect().height || 80;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - headerHeight - 18,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function chartOptions(label) {
    return { responsive: true, maintainAspectRatio: false, animation: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#594333", padding: 12, cornerRadius: 9,
        callbacks: { label: context => `${context.dataset.label || label} ${fmtUSD(context.parsed.y)}` } } },
      scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: "#ae967e", maxTicksLimit: 5, maxRotation: 0, font: { size: 11 } } },
        y: { grid: { color: "#f0e7dc" }, border: { display: false }, ticks: { color: "#a68d75", maxTicksLimit: 5, font: { size: 11 }, callback: value => fmtCompactUSD(value) } } }
    };
  }
  const DEFAULT_COINS = [
    { symbol: "BTC", name: "Bitcoin" },
    { symbol: "ETH", name: "Ethereum" },
    { symbol: "SOL", name: "Solana" },
    { symbol: "XRP", name: "XRP" },
    { symbol: "BNB", name: "BNB" },
    { symbol: "DOGE", name: "Dogecoin" },
    { symbol: "USDT", name: "Tether" },
    { symbol: "USDC", name: "USD Coin" }
  ];
  const DEMO_PORTFOLIO_ORDERS = [
    { symbol: "BTC", amount_usd: 50000 },
    { symbol: "ETH", amount_usd: 15000 },
    { symbol: "USDC", amount_usd: 10000 }
  ];

  function fmtUSD(value) {
    const n = finiteNumber(value);
    if (n === null) return "--";
    return "USD " + n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtQty(value) {
    const quantity = finiteNumber(value);
    if (quantity === null) return "--";
    if (quantity !== 0 && Math.abs(quantity) < 1e-8) return quantity > 0 ? "<0.00000001" : ">-0.00000001";
    return quantity.toLocaleString("zh-TW", { maximumFractionDigits: 8 });
  }

  function fmtCompactUSD(value) {
    const n = finiteNumber(value);
    if (n === null) return "--";
    if (n >= 1_000_000_000_000) return "USD " + (n / 1_000_000_000_000).toFixed(2) + "T";
    if (n >= 1_000_000_000) return "USD " + (n / 1_000_000_000).toFixed(2) + "B";
    if (n >= 1_000_000) return "USD " + (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return "USD " + (n / 1_000).toFixed(n >= 10000 ? 0 : 1) + "K";
    return fmtUSD(n);
  }

  function setStatus(message, type) {
    const el = $("orderStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "status " + (type || "");
  }

  function setStressStatus(message, type) {
    const el = $("stressStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "status " + (type || "");
  }

  function appendStressText(parent, tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function fmtPct(value) {
    const number = finiteNumber(value);
    return number !== null ? (number * 100).toFixed(2) + "%" : "--";
  }

  function stressSnapshot() {
    const portfolio = currentPortfolio || {};
    return {
      cash: Number(portfolio.cash || 0),
      positions: (Array.isArray(portfolio.positions) ? portfolio.positions : []).map((item) => ({
        symbol: item.symbol,
        market_value: item.market_value,
        quantity: item.quantity,
        current_price: item.current_price
      }))
    };
  }

  function hasStressablePositions(snapshot) {
    return (Array.isArray(snapshot?.positions) ? snapshot.positions : []).some((item) => (
      Number.isFinite(Number(item?.market_value)) && Number(item.market_value) > 0
    ));
  }

  function stressInterpretation(result, strategy) {
    const rows = result?.results?.[strategy || "balanced"] || {};
    const black = rows.black_swan?.metrics || null;
    const initial = Number(result?.snapshot?.initial_value || 0);
    if (!black || initial <= 0) return null;

    const totalReturn = finiteNumber(black.total_return);
    const maxDrawdown = finiteNumber(black.max_drawdown);
    const finalValue = finiteNumber(black.final_value);
    if (totalReturn === null || maxDrawdown === null || finalValue === null) return null;
    const drawdownAbs = Math.abs(maxDrawdown);
    let level = "low";
    let label = "風險低";
    if (drawdownAbs >= 0.35 || totalReturn <= -0.3) {
      level = "high";
      label = "風險高";
    } else if (drawdownAbs >= 0.18 || totalReturn <= -0.15) {
      level = "medium";
      label = "風險中";
    }

    const reason = `所選策略重新配置後，在黑天鵝假設下總報酬約 ${fmtPct(totalReturn)}，最大回撤約 ${fmtPct(maxDrawdown)}，期末值約 ${fmtUSD(finalValue)}。這不是原持倉的直接測試結果。`;
    const actionMap = {
      high: "比較較低風險資產比例的策略，觀察此模型下的差異。",
      medium: "使用同一份快照比較其他策略與情境。",
      low: "所選策略在此假設下跌幅較小；可比較不同期間與 seed，不能據此推論實際投資風險低。"
    };
    return {
      level,
      label,
      headline: `${label}：極端情境下的下跌幅度${level === "low" ? "相對可控" : "需要留意"}`,
      reason,
      action: actionMap[level]
    };
  }

  function renderStressInterpretation(root, result, strategy) {
    const summary = stressInterpretation(result, strategy);
    if (!summary) return;
    const box = document.createElement("section");
    box.className = `stress-interpretation risk-${summary.level}`;
    appendStressText(box, "span", summary.label, "stress-risk-label");
    appendStressText(box, "h3", "黑天鵝情境觀察");
    appendStressText(box, "p", summary.headline);
    appendStressText(box, "p", `${summary.action} 此結果以所選策略重新配置，不是直接測試原持倉比例。`, "stress-next-action");
    root.appendChild(box);
  }

  function stressLineStyle(key) {
    const selected = key === activeScenario;
    return {
      borderColor: SCENARIO_COLORS[key],
      borderWidth: selected ? 5 : 3,
      borderDash: key === "normal" ? [7, 5] : key === "bear" ? [8, 3] : [],
      order: selected ? 0 : 2,
      fill: selected ? "origin" : false,
      pointRadius: context => context.dataIndex === context.dataset.data.length - 1 ? selected ? 6 : 4 : 0,
      pointHoverRadius: selected ? 8 : 5, pointHitRadius: 18,
      pointBorderWidth: selected ? 3 : 2, pointBorderColor: "#fff",
      pointBackgroundColor: SCENARIO_COLORS[key],
      backgroundColor: context => {
        const chart = context.chart;
        if (!chart.chartArea) return SCENARIO_COLORS[key] + "10";
        const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
        gradient.addColorStop(0, SCENARIO_COLORS[key] + "14");
        gradient.addColorStop(1, SCENARIO_COLORS[key] + "02");
        return gradient;
      },
    };
  }

  function syncStressFocus() {
    if (!stressChart) return;
    const chart = stressChart, nodes = chart.$stressNodes;
    const row = chart.$stressRows[activeScenario], metrics = row?.metrics || {};
    chart.data.datasets.forEach(dataset => Object.assign(dataset, stressLineStyle(dataset.scenarioKey)));
    nodes.shell.dataset.scenario = activeScenario;
    nodes.name.textContent = `${SCENARIO_LABELS[activeScenario]}：這筆錢會變多少？`;
    nodes.value.textContent = fmtUSD(metrics.final_value);
    nodes.totalReturn.textContent = fmtPct(metrics.total_return);
    const finalValue = finiteNumber(metrics.final_value), initial = chart.$stressInitial;
    const difference = finalValue !== null && initial !== null ? finalValue - initial : null;
    nodes.changeLabel.textContent = difference === null ? "金額差異" : difference > 0 ? "比起始多了" : difference < 0 ? "比起始少了" : "與起始相同";
    nodes.change.textContent = difference === null ? "--" : fmtUSD(Math.abs(difference));
    nodes.change.className = difference === null || difference === 0 ? "" : difference > 0 ? "ok" : "bad";
    const totalReturn = finiteNumber(metrics.total_return);
    nodes.totalReturn.className = totalReturn === null || totalReturn === 0 ? "" : totalReturn > 0 ? "ok" : "bad";
    nodes.announcement.textContent = `目前強調${SCENARIO_LABELS[activeScenario]}，試算後剩 ${nodes.value.textContent}，${nodes.changeLabel.textContent} ${nodes.change.textContent}。四種情境仍同時顯示。`;
    nodes.shell.querySelectorAll(".sim-outcome-row").forEach(item => item.classList.toggle("is-highlighted", item.dataset.outcome === activeScenario));
    chart.update(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "none" : undefined);
  }

  function applyScenario(scenarioKey) {
    if (!Object.prototype.hasOwnProperty.call(SCENARIO_COLORS, scenarioKey)) return;
    activeScenario = scenarioKey;
    document.querySelectorAll(".scenario-btn").forEach(button => {
      const selected = button.dataset.scenario === scenarioKey;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      const key = button.dataset.scenario, defaults = {normal:1,bull:1.3,bear:.7,black_swan:.4};
      const multiplier = finiteNumber(lastStressResult?.scenarios?.[key]?.terminal_multiplier) ?? finiteNumber(scenarioData[key]?.price_multiplier) ?? defaults[key];
      const assumption = button.querySelector(".scenario-assumption"), percent = (multiplier - 1) * 100;
      if (assumption) assumption.textContent = `風險資產 ${percent > 0 ? "+" : percent < 0 ? "−" : ""}${Math.abs(percent).toFixed(0)}%`;
    });
    syncStressFocus();
  }

  function drawStressChart(root, rows, initialValue) {
    const datasets = ["normal", "bull", "bear", "black_swan"].filter(key => Array.isArray(rows[key]?.path)
      && rows[key].path.filter(value => finiteNumber(value) !== null && Number(value) >= 0).length >= 2).map(key => ({
      scenarioKey: key, label: SCENARIO_LABELS[key],
      data: rows[key].path.map(value => finiteNumber(value) !== null && Number(value) >= 0 ? Number(value) : null),
      tension: .15, spanGaps: false, ...stressLineStyle(key),
    }));
    if (!datasets.length || !ensureCharts()) {
      appendStressText(root, "p", "路徑圖暫不可用，仍可比較下方的試算金額。", "sim-inline-note");
      drawStressOutcomes(root, rows, initialValue);
      return;
    }
    const shell = appendStressText(root, "section", "", "sim-stress-chart-panel");
    shell.id = "stressChartPanel"; shell.dataset.scenario = activeScenario;
    const head = appendStressText(shell, "div", "", "sim-stress-chart-head");
    const title = appendStressText(head, "div", "");
    appendStressText(title, "span", "同一筆資金 · 四種漲跌假設", "sim-stress-eyebrow");
    const name = appendStressText(title, "h3", ""); name.id = "stressFocusName";
    appendStressText(head, "span", "四種結果同時比較", "sim-stress-compare-badge");
    const focus = appendStressText(shell, "div", "", "sim-stress-focus");
    const start = appendStressText(focus, "div", "", "sim-stress-start");
    appendStressText(start, "span", "起始資金");
    appendStressText(start, "strong", fmtUSD(initialValue));
    const arrow = appendStressText(focus, "span", "→", "sim-stress-flow-arrow"); arrow.setAttribute("aria-hidden", "true");
    const endValue = appendStressText(focus, "div", "", "sim-stress-focus-value");
    appendStressText(endValue, "span", "試算後剩多少");
    const value = appendStressText(endValue, "strong", "--"); value.id = "stressFocusValue";
    const returnBlock = appendStressText(focus, "div", "", "sim-stress-difference");
    const changeLabel = appendStressText(returnBlock, "span", "金額差異");
    const change = appendStressText(returnBlock, "strong", "--"); change.id = "stressFocusChange";
    const totalReturn = appendStressText(returnBlock, "strong", "--"); totalReturn.id = "stressFocusReturn";
    const announcement = appendStressText(shell, "span", "", "sim-stress-sr-only");
    announcement.setAttribute("role", "status"); announcement.setAttribute("aria-live", "polite");
    const visualGrid = appendStressText(shell, "div", "", "sim-stress-visual-grid");
    const pathPane = appendStressText(visualGrid, "div", "", "sim-stress-path-pane");
    const pathHead = appendStressText(pathPane, "div", "", "sim-stress-visual-heading");
    appendStressText(pathHead, "h4", "途中怎麼變？");
    appendStressText(pathHead, "span", "橫軸：天數 · 縱軸：帳戶 USD");
    const stage = appendStressText(pathPane, "div", "", "sim-stress-chart");
    const canvas = document.createElement("canvas");
    canvas.id = "stressPathChart"; canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "四種漲跌假設的帳戶金額變化；四條線同時顯示，所選情境加粗，結果可閱讀旁邊的金額比較"); stage.appendChild(canvas);
    appendStressText(pathPane, "small", "粗線＝上方選取情境；其他三條線保留比較。", "sim-stress-focus-hint");
    drawStressOutcomes(visualGrid, rows, initialValue);
    appendStressText(shell, "small", "情境假設 · 非歷史回測、價格預測或實際投資報酬", "sim-stress-chart-note");
    const reference = finiteNumber(initialValue) ?? finiteNumber(datasets[0].data[0]);
    const values = datasets.flatMap(dataset => dataset.data).filter(value => value !== null);
    const low = Math.min(...values), high = Math.max(...values), span = high - low || Math.max(Math.abs(high) * .05, 1);
    const options = chartOptions("情境資產");
    options.animation = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? false : {duration:280};
    options.layout = {padding:{top:22,right:stage.clientWidth >= 600 ? 115 : 16,bottom:4}};
    options.onResize = (chart, size) => {chart.options.layout.padding.right = size.width >= 600 ? 115 : 16;};
    options.scales.y.suggestedMin = Math.max(0, low - span * .12);
    options.scales.y.suggestedMax = high + span * .15;
    options.scales.y.ticks.color = "#8b7c6e";
    options.scales.y.grid.color = "#eee8df";
    options.plugins.tooltip.usePointStyle = true;
    options.plugins.tooltip.backgroundColor = "#332a23";
    options.plugins.tooltip.itemSort = (a, b) => Number(b.dataset.scenarioKey === activeScenario) - Number(a.dataset.scenarioKey === activeScenario);
    options.plugins.tooltip.callbacks.label = context => `${context.dataset.label}  ${fmtUSD(context.parsed.y)}${reference > 0 ? `  (${fmtPct(context.parsed.y / reference - 1)})` : ""}`;
    const annotation = {
      id:"stressScenarioFocus",
      beforeDatasetsDraw(chart) {
        const {ctx,chartArea,scales} = chart;
        if (reference === null || !chartArea) return;
        const y = scales.y.getPixelForValue(reference);
        if (y < chartArea.top || y > chartArea.bottom) return;
        ctx.save(); ctx.strokeStyle = "#b6a593"; ctx.lineWidth = 1.3; ctx.setLineDash([4,5]);
        ctx.beginPath(); ctx.moveTo(chartArea.left,y); ctx.lineTo(chartArea.right,y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = "#8e7e6c"; ctx.font = "11px Arial, sans-serif";
        ctx.fillText("起始資產",chartArea.left + 5, y > chartArea.top + 20 ? y - 8 : y + 15); ctx.restore();
      },
      beforeDatasetDraw(chart, args) {
        chart.ctx.save();
        if (chart.data.datasets[args.index].scenarioKey === activeScenario) {
          chart.ctx.shadowColor = SCENARIO_COLORS[activeScenario] + "55";
          chart.ctx.shadowBlur = 9;
        }
      },
      afterDatasetDraw(chart) {chart.ctx.restore();},
      afterDatasetsDraw(chart) {
        const index = chart.data.datasets.findIndex(dataset => dataset.scenarioKey === activeScenario);
        if (index < 0 || chart.width < 600) return;
        const dataset = chart.data.datasets[index], last = dataset.data.length - 1;
        if (last < 0 || dataset.data[last] === null) return;
        const point = chart.getDatasetMeta(index).data[last];
        if (!point) return;
        const {ctx,chartArea} = chart, color = SCENARIO_COLORS[activeScenario];
        const x = chartArea.right + 12, y = Math.max(chartArea.top + 16, Math.min(chartArea.bottom - 16, point.y));
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(point.x + 7,point.y); ctx.lineTo(x - 3,y); ctx.stroke();
        ctx.fillStyle = color; ctx.font = "bold 12px Arial, sans-serif";
        ctx.fillText(dataset.label, x, y - 5); ctx.font = "bold 13px Arial, sans-serif";
        ctx.fillText(fmtCompactUSD(dataset.data[last]), x, y + 14); ctx.restore();
      },
    };
    stressChart = new Chart(canvas, { type: "line", data: { labels: Array.from({ length: Math.max(...datasets.map(item => item.data.length)) }, (_, index) => `第 ${index} 天`), datasets }, options, plugins:[annotation] });
    stressChart.$stressRows = rows;
    stressChart.$stressInitial = finiteNumber(initialValue);
    stressChart.$stressNodes = {shell,name,value,totalReturn,changeLabel,change,announcement};
    syncStressFocus();
  }

  function drawStressOutcomes(root, rows, initialValue) {
    const box = appendStressText(root, "section", "", "sim-stress-outcomes");
    box.setAttribute("aria-label", "四種情境的帳戶金額比較");
    appendStressText(box, "h4", "最後剩多少？");
    appendStressText(box, "small", "同一刻度 · 細刻線是起始資金");
    const initial = finiteNumber(initialValue);
    const maximum = Math.max(0, initial ?? 0, ...Object.values(rows).map(row => finiteNumber(row?.metrics?.final_value) ?? 0));
    ["normal", "bull", "bear", "black_swan"].forEach(key => {
      if (!rows[key]) return;
      const metrics = rows[key].metrics || {}, finalValue = finiteNumber(metrics.final_value), change = finiteNumber(metrics.total_return);
      const row = appendStressText(box, "article", "", "sim-outcome-row");
      row.dataset.outcome = key; row.style.setProperty("--outcome-color", SCENARIO_COLORS[key]);
      const head = appendStressText(row, "div", "", "sim-outcome-head");
      const label = appendStressText(head, "span", "", "sim-outcome-label");
      const mark = appendStressText(label, "i", ""); mark.style.background = SCENARIO_COLORS[key]; mark.setAttribute("aria-hidden", "true");
      appendStressText(label, "strong", SCENARIO_LABELS[key]);
      appendStressText(head, "b", `${change !== null && change > 0 ? "+" : ""}${fmtPct(change)}`, change === null || change === 0 ? "" : change > 0 ? "ok" : "bad");
      appendStressText(row, "strong", fmtUSD(finalValue), "sim-outcome-amount");
      const track = appendStressText(row, "div", "", "sim-outcome-track"); track.setAttribute("aria-hidden", "true");
      if (finalValue !== null && finalValue >= 0 && maximum > 0) {
        const fill = appendStressText(track, "span", ""); fill.style.width = `${finalValue / maximum * 100}%`;
      }
      if (initial !== null && initial >= 0 && maximum > 0) {
        const tick = appendStressText(track, "i", ""); tick.style.left = `${initial / maximum * 100}%`;
      }
    });
  }

  function renderStressResults(result) {
    const root = $("stressResults");
    if (!root) return;
    stressChart?.destroy(); stressChart = null;
    root.replaceChildren();
    if (!result) return;
    const strategy = $("stressStrategy")?.value || "balanced";
    const rows = result.results?.[strategy] || {};

    const meta = document.createElement("div");
    meta.className = "stress-result-meta";
    appendStressText(meta, "strong", result.strategies?.[strategy]?.label || strategy);
    appendStressText(meta, "span", `${result.period?.days ?? "--"} 天假設試算 · 依策略重新配置`);
    root.appendChild(meta);
    drawStressChart(root, rows, result.snapshot?.initial_value);

    const details = appendStressText(root, "details", "", "compact-explain");
    appendStressText(details, "summary", "查看配置、風險指標與完整數據");
    appendStressText(details, "p", `起始基準 ${fmtUSD(result.snapshot?.initial_value)} · ${result.period?.days ?? "--"} 個合成日 · seed ${result.seed}`, "sim-stress-allocation-note");
    const allocation = rows.black_swan?.initial_allocation;
    if (allocation) {
      appendStressText(details, "small", `按策略重新配置 · 實際風險資產 ${fmtPct(rows.black_swan.actual_risk_weight)}`, "sim-stress-allocation-note");
      const mix = Object.entries(allocation).filter(([, value]) => finiteNumber(value) > 0), total = mix.reduce((sum, [, value]) => sum + Number(value), 0);
      const bar = appendStressText(details, "div", "", "sim-stress-allocation");
      mix.forEach(([symbol, value], index) => {
        const segment = appendStressText(bar, "span", "");
        segment.style.width = `${Number(value) / total * 100}%`; segment.style.background = symbol === "CASH" ? "#e8dbc9" : ASSET_COLORS[index % ASSET_COLORS.length];
        segment.title = `${symbol === "CASH" ? "現金" : symbol} ${fmtUSD(value)}`;
      });
      appendStressText(details, "small", `測試起始配置：${mix.map(([symbol, value]) => `${symbol === "CASH" ? "現金" : symbol} ${fmtUSD(value)}`).join("、")}`, "sim-stress-allocation-note");
    }
    renderStressInterpretation(details, result, strategy);
    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    ["情境", "總報酬", "合成年化波動", "最大回撤", "Sharpe-like", "期末值"].forEach((label) => {
      appendStressText(header, "th", label);
    });
    thead.appendChild(header);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    ["normal", "bull", "bear", "black_swan"].forEach((scenario) => {
      const rowData = rows[scenario];
      if (!rowData) return;
      const metrics = rowData.metrics || {};
      const row = document.createElement("tr");
      appendStressText(row, "td", rowData.scenario_label || scenario);
      appendStressText(row, "td", fmtPct(metrics.total_return));
      appendStressText(row, "td", fmtPct(metrics.volatility));
      appendStressText(row, "td", fmtPct(metrics.max_drawdown));
      appendStressText(row, "td", finiteNumber(metrics.sharpe_like) === null ? "--" : Number(metrics.sharpe_like).toFixed(2));
      appendStressText(row, "td", fmtUSD(metrics.final_value));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    details.appendChild(tableWrap);
    applyScenario(activeScenario);

    if (Array.isArray(result.warnings) && result.warnings.length) {
      appendStressText(root, "p", `未納入資料：${result.warnings.join("、")}`, "stress-warning");
    }
  }

  async function runStressTest() {
    if (isLocked || !currentPortfolio || stressPending) return;
    if (currentPortfolio.price_unavailable_symbols?.length) {
      setStressStatus("部分持倉行情暫不可用，無法進行情境比較。請稍後重新整理。", "warn");
      return;
    }
    const requestVersion = ++stressRequestVersion;
    lastStressResult = null;
    stressChart?.destroy(); stressChart = null;
    $("stressResults")?.replaceChildren();
    const horizonDays = Number($("stressHorizon")?.value || 90);
    const seed = Number($("stressSeed")?.value || 20260820);
    const snapshot = stressSnapshot();
    if (!Number.isInteger(horizonDays) || horizonDays < 7 || horizonDays > 365 || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
      setStressStatus("期間需為 7–365 天的整數；情境編號需為 0–2147483647 的整數。", "bad");
      return;
    }
    if (!hasStressablePositions(snapshot)) {
      lastStressResult = null;
      $("stressResults")?.replaceChildren();
      setStressStatus(
        "目前組合只有現金，沒有可進行情境測試的持倉。請先建立一筆模擬買入訂單。",
        "bad"
      );
      scrollToSection("orderPanel");
      return;
    }
    setStressStatus("正在建立獨立假設快照…", "");
    stressPending = true;
    if ($("runStressTest")) $("runStressTest").disabled = true;
    try {
      const data = await request("/api/paper-stress-test", {
        method: "POST",
        body: JSON.stringify({
          snapshot, horizon_days: horizonDays, seed
        })
      });
      if (requestVersion !== stressRequestVersion) return;
      lastStressResult = data.stress_test || null;
      renderStressResults(lastStressResult);
      setStressStatus("已完成四種情境比較；結果沒有寫回模擬帳本。", "ok");
    } catch (error) {
      if (requestVersion !== stressRequestVersion) return;
      setStressStatus(error.message || "壓力測試失敗。", "bad");
    } finally {
      stressPending = false;
      if ($("runStressTest")) $("runStressTest").disabled = false;
    }
  }

  function setLockedState(locked) {
    isLocked = locked;
    $("memberGate")?.classList.toggle("show", locked);
    $("memberGate")?.classList.toggle("locked", locked);
    const app = $("simApp");
    if (app) app.classList.toggle("sim-locked", locked);
  }

  async function request(url, options) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setLockedState(true);
      throw new Error(data.error || "請先登入會員。");
    }
    if (!res.ok) throw new Error(data.error || data.detail || "請求失敗");
    return data;
  }

  async function getAuthToken() {
    try {
      if (window.authManager?.whenReady) {
        await window.authManager.whenReady();
      }
      if (window.authManager?.getMembershipTier?.() !== "premium") return null;
      return window.authManager ? await window.authManager.getToken().catch(() => null) : null;
    } catch {
      return null;
    }
  }

  async function waitForAuthToken(timeoutMs = 1800) {
    const token = await getAuthToken();
    if (token) return token;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, timeoutMs);
      window.addEventListener("smartinvest:auth-state", finish, { once: true });
      window.addEventListener("smartinvest:auth-ready", finish, { once: true });
    });

    return await getAuthToken();
  }

  async function loadCoins() {
    const bySymbol = new Map(DEFAULT_COINS.map((coin) => [coin.symbol, coin]));
    try {
      const res = await fetch("/crypto/popular?vs_currency=usd&per_page=20");
      const data = await res.json();
      const apiCoins = Array.isArray(data) ? data : [];
      apiCoins.forEach((coin) => {
        const symbol = String(coin.symbol || "").toUpperCase();
        if (!symbol) return;
        bySymbol.set(symbol, Object.assign({}, coin, { symbol }));
      });
    } catch {
      // Keep default coins when market API is unavailable.
    }
    coinOptions = Array.from(bySymbol.values());
    await refreshBtcQuote();

    const select = $("orderSymbol");
    if (!select) return;
    select.innerHTML = "";
    coinOptions.forEach((coin) => {
      const symbol = String(coin.symbol || "").toUpperCase();
      if (!symbol) return;
      select.add(new Option(`${symbol} | ${coin.name || symbol}`, symbol));
    });
    ensureHeldCoinOptions();
    updateQuotePanel();
  }

  function ensureHeldCoinOptions() {
    const select = $("orderSymbol");
    for (const position of currentPortfolio?.positions || []) {
      const symbol = String(position.symbol || "").toUpperCase();
      if (!/^[A-Z0-9]{2,12}$/.test(symbol) || coinOptions.some(coin => coin.symbol === symbol)) continue;
      coinOptions.push({ symbol, name: symbol, current_price: finiteNumber(position.current_price) });
      select?.add(new Option(symbol, symbol));
    }
    syncMarketSelector();
  }

  function syncMarketSelector() {
    const marketSelect = $("marketSymbol"), orderSelect = $("orderSymbol");
    if (!marketSelect || !orderSelect) return;
    const options = Array.from(orderSelect.options);
    if (marketSelect.options.length !== options.length || options.some((option, index) => (
      marketSelect.options[index]?.value !== option.value || marketSelect.options[index]?.text !== option.text
    ))) {
      marketSelect.replaceChildren();
      options.forEach(option => marketSelect.add(new Option(option.text, option.value)));
    }
    marketSelect.value = orderSelect.value;
  }

  function selectTradingSymbol(symbol) {
    if (orderPending || isLocked || !$("orderSymbol")) return;
    $("orderSymbol").value = symbol;
    syncMarketSelector();
    updateQuotePanel();
    refreshSelectedQuote();
    loadMarketSeries();
  }

  async function refreshSelectedQuote() {
    const coin = getSelectedCoin(), version = ++quoteRequestVersion;
    coin.current_price = null;
    updateQuotePanel();
    try {
      const response = await fetch(`/crypto/quote?ticker=${encodeURIComponent(coin.symbol)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("quote unavailable");
      const quote = await response.json();
      if (version !== quoteRequestVersion) return;
      const price = finiteNumber(quote.current_price);
      coin.current_price = price > 0 ? price : null;
    } catch { if (version !== quoteRequestVersion) return; }
    updateQuotePanel();
  }

  async function loadMarketSeries() {
    const canvas = $("marketChart");
    if (!canvas) return;
    const version = ++marketRequestVersion, symbol = getSelectedCoin().symbol;
    marketChart?.destroy(); marketChart = null;
    canvas.hidden = true;
    $("marketChartEmpty").hidden = false;
    $("marketChartEmpty").textContent = "價格走勢載入中…";
    $("marketChartSource").textContent = "歷史價格走勢；目前市價另行取得";
    canvas.setAttribute("aria-label", `${symbol} 近 ${marketDays} 天歷史價格走勢`);
    try {
      const response = await fetch(`/crypto/series?ticker=${encodeURIComponent(symbol)}&days=${marketDays}&vs_currency=usd`);
      if (!response.ok) throw new Error("series unavailable");
      const data = await response.json();
      if (version !== marketRequestVersion) return;
      const points = (Array.isArray(data.prices) ? data.prices : []).filter(point => Array.isArray(point)
        && finiteNumber(point[0]) !== null && finiteNumber(point[1]) > 0).sort((a, b) => a[0] - b[0]);
      if (points.length < 2 || !ensureCharts()) throw new Error("series unavailable");
      const tone = Number(points.at(-1)[1]) >= Number(points[0][1]) ? "#3a8a72" : "#c85851";
      const options = chartOptions("歷史價格");
      options.plugins.tooltip.callbacks.title = items => window.SIFormat.dateText(points[items[0].dataIndex][0]);
      marketChart = new Chart(canvas, { type: "line", data: {
        labels: points.map(point => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit" }).format(window.SIFormat.date(point[0]))),
        datasets: [{ label: symbol, data: points.map(point => Number(point[1])), borderColor: tone, backgroundColor: tone + "12", fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .15 }]
      }, options });
      canvas.hidden = false; $("marketChartEmpty").hidden = true;
      const sources = { coingecko: "CoinGecko", yfinance: "Yahoo Finance" };
      $("marketChartSource").textContent = `${sources[data.source] || "歷史價格資料"} · ${points.length} 個價格點 · 不作為即時成交價`;
    } catch {
      if (version !== marketRequestVersion) return;
      $("marketChartEmpty").textContent = "歷史走勢暫不可用，可稍後更新資料。";
    }
  }

  async function refreshBtcQuote() {
    const coin = coinOptions.find(item => item.symbol === "BTC");
    if (!coin) return;
    coin.current_price = null;
    try {
      const res = await fetch("/crypto/quote?ticker=BTC", { cache: "no-store" });
      if (!res.ok) return;
      const quote = await res.json();
      const price = Number(quote.current_price);
      if (Number.isFinite(price) && price > 0) coin.current_price = price;
    } catch {
      // Never retain a popular-list price when the executable quote is unavailable.
    }
  }

  function getSelectedCoin() {
    const symbol = String($("orderSymbol")?.value || "BTC").toUpperCase();
    return coinOptions.find((coin) => String(coin.symbol || "").toUpperCase() === symbol)
      || DEFAULT_COINS.find((coin) => coin.symbol === symbol)
      || { symbol, name: symbol };
  }

  function getSelectedPosition(symbol) {
    const positions = Array.isArray(currentPortfolio?.positions) ? currentPortfolio.positions : [];
    return positions.find((pos) => String(pos.symbol || "").toUpperCase() === symbol) || null;
  }

  function setAdvice(message, type) {
    const el = $("quoteAdvice");
    if (!el) return;
    el.textContent = message;
    el.className = "coin-order-advice " + (type || "");
  }

  function updateQuotePanel() {
    const coin = getSelectedCoin();
    const symbol = String(coin.symbol || "BTC").toUpperCase();
    const price = Number(coin.current_price || 0);
    const marketCap = Number(coin.market_cap || 0);
    const change24h = finiteNumber(coin.price_change_percentage_24h);
    const side = $("orderSide")?.value || "buy";
    const qtyRaw = $("orderQty")?.value.trim();
    const amountRaw = $("orderAmt")?.value.trim();
    const qty = Number(qtyRaw || 0);
    const amount = Number(amountRaw || 0);

    if ($("quoteSymbol")) $("quoteSymbol").textContent = symbol;
    if ($("quoteCoinIcon")) $("quoteCoinIcon").textContent = symbol === "BTC" ? "₿" : symbol === "ETH" ? "Ξ" : symbol.slice(0, 1);
    if ($("quoteName")) $("quoteName").textContent = coin.name || symbol;
    if ($("quotePrice")) $("quotePrice").textContent = price ? fmtUSD(price) : "--";
    if ($("quoteChange")) {
      $("quoteChange").textContent = change24h !== null
        ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`
        : "--";
      $("quoteChange").className = change24h === null || change24h === 0 ? "" : change24h > 0 ? "ok" : "bad";
      $("quoteChange").setAttribute("aria-label", `24 小時漲跌 ${$("quoteChange").textContent}`);
    }
    if ($("quoteMarketCap")) $("quoteMarketCap").textContent = marketCap ? fmtCompactUSD(marketCap) : "--";
    if ($("quoteOne")) $("quoteOne").textContent = price ? fmtUSD(price) : "--";
    if ($("quotePointOne")) $("quotePointOne").textContent = price ? fmtUSD(price * 0.1) : "--";

    let estimateText = "請輸入數量或金額";
    let orderAmount = 0;
    let orderQty = 0;
    if (price && qty > 0) {
      orderQty = qty;
      orderAmount = qty * price;
      estimateText = `${fmtQty(orderQty)} ${symbol} ≈ ${fmtUSD(orderAmount)}`;
    } else if (price && amount > 0) {
      orderAmount = amount;
      orderQty = amount / price;
      estimateText = `${fmtUSD(orderAmount)} ≈ ${fmtQty(orderQty)} ${symbol}`;
    }
    if ($("quoteEstimate")) $("quoteEstimate").textContent = estimateText;

    const cash = Number(currentPortfolio?.cash || 0);
    const position = getSelectedPosition(symbol);
    const holdingQty = Number(position?.quantity || 0);
    const draft = orderDraft();
    syncMarketSelector();
    if ($("orderPreviewSymbol")) $("orderPreviewSymbol").textContent = `${side === "sell" ? "賣出" : "買入"} ${symbol}`;
    if ($("orderPreviewPrice")) $("orderPreviewPrice").textContent = fmtUSD(draft.price);
    if ($("orderPreviewQty")) $("orderPreviewQty").textContent = draft.quantity > 0 ? `${fmtQty(draft.quantity)} ${symbol}` : "--";
    $("orderPanel")?.setAttribute("data-side", side);
    document.querySelectorAll("[data-order-side]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.orderSide === side)));
    if ($("orderAvailable")) $("orderAvailable").textContent = side === "buy" ? `可用現金 ${fmtUSD(draft.cash)}` : `可賣出 ${fmtQty(draft.holdingQty)} ${symbol}`;
    if ($("orderAfterLabel")) $("orderAfterLabel").textContent = side === "buy" ? "買入後可用現金" : "賣出後剩餘持倉";
    if ($("orderAfter")) $("orderAfter").textContent = draft.amount > 0 && draft.quantity > 0 ? side === "buy"
      ? fmtUSD(draft.cash === null ? null : draft.cash - draft.amount) : `${fmtQty(draft.holdingQty - draft.quantity)} ${symbol}` : "--";
    const usedPct = Number.isFinite(draft.usedPct) ? draft.usedPct : 0;
    if ($("orderCapacityFill")) $("orderCapacityFill").style.width = `${Math.max(0, Math.min(100, usedPct))}%`;
    if ($("orderCapacityLabel")) $("orderCapacityLabel").textContent = draft.amount > 0 ? `${side === "buy" ? "使用可用現金" : "賣出目前持倉"} ${usedPct.toFixed(1)}%` : "輸入金額或數量即可試算";
    document.querySelectorAll("[data-order-fraction]").forEach(button => { button.disabled = orderPending || isLocked || !price || (side === "buy" ? cash <= 0 : holdingQty <= 0); });
    if ($("btnPlaceOrder")) {
      $("btnPlaceOrder").disabled = orderPending || !draft.valid;
      $("btnPlaceOrder").innerHTML = `<i class="fas fa-${side === "buy" ? "plus" : "minus"}" aria-hidden="true"></i> ${orderPending ? "處理中…" : side === "buy" ? "模擬買入" : "模擬賣出"}`;
    }
    ["marketSymbol", "orderSymbol", "orderAmt", "orderQty", "btnLoadDemoPortfolio", "btnReset"].forEach(id => { if ($(id)) $(id).disabled = orderPending; });
    document.querySelectorAll("[data-order-side]").forEach(button => { button.disabled = orderPending; });

    if (!price) {
      setAdvice("目前沒有可用市價，建議先重新整理行情後再下單。", "warn");
    } else if (!currentPortfolio || draft.cash === null) {
      setAdvice("帳戶資料尚未完整載入，請更新資料後再送出模擬單。", "warn");
    } else if (side === "buy" && orderAmount > cash) {
      setAdvice(`現金不足，帳戶目前可用現金 ${fmtUSD(cash)}。`, "bad");
    } else if (side === "sell" && orderQty > holdingQty) {
      setAdvice(`持倉不足，目前持有 ${fmtQty(holdingQty)} ${symbol}。`, "bad");
    } else if (side === "sell" && holdingQty <= 0) {
      setAdvice(`目前沒有 ${symbol} 持倉，暫不適合送出賣單。`, "bad");
    } else if ((qtyRaw && qty <= 0) || (amountRaw && amount <= 0) || (qtyRaw && amountRaw)) {
      setAdvice("請輸入大於 0 的金額或數量，擇一填寫。", "bad");
    } else if (side === "buy" && change24h !== null && change24h >= 8) {
      setAdvice(`24 小時漲幅約 +${change24h.toFixed(2)}%，價格偏熱，較適合小額分批。`, "warn");
    } else if (side === "buy" && change24h !== null && change24h <= -8) {
      setAdvice(`24 小時跌幅約 ${change24h.toFixed(2)}%，波動偏大，建議降低單筆金額。`, "warn");
    } else if (orderAmount > 0 || orderQty > 0) {
      setAdvice("試算可送出。按下按鈕會記錄這筆虛擬買賣，成交以服務取得的市價為準。", "ok");
    } else {
      setAdvice("輸入金額或數量，先看試算再送出模擬單。", "");
    }
  }

  function updateKpis(snapshot) {
    if (!snapshot) return;
    const valuationUnavailable = Boolean(snapshot.price_unavailable_symbols?.length);
    $("kpiTotal").textContent = valuationUnavailable ? "--" : fmtUSD(snapshot.total_value_usd);
    $("kpiCash").textContent = fmtUSD(snapshot.cash);
    $("kpiPnl").textContent = valuationUnavailable ? "--" : fmtUSD(snapshot.unrealized_pnl);
    const mix = allocationData(snapshot);
    if ($("kpiHoldings")) $("kpiHoldings").textContent = mix ? fmtUSD(mix.total - Number(snapshot.cash)) : "--";
    if ($("kpiPositionCount")) $("kpiPositionCount").textContent = `${snapshot.positions?.length || 0} 種持倉`;
    const pnl = finiteNumber(snapshot.unrealized_pnl);
    $("kpiPnl").className = valuationUnavailable || pnl === null || pnl === 0 ? "" : pnl > 0 ? "ok" : "bad";
    if ($("holdingsValuationState")) $("holdingsValuationState").textContent = valuationUnavailable ? "部分行情暫不可用" : "依最新取得市價估值";

    const pnlPct = finiteNumber(snapshot.pnl_pct);
    const pnlPctEl = $("kpiPnlPct");
    pnlPctEl.textContent = valuationUnavailable || pnlPct === null ? "--" : (pnlPct > 0 ? "+" : "") + pnlPct.toFixed(2) + "%";
    pnlPctEl.className = "sub " + (valuationUnavailable || pnlPct === null || pnlPct === 0 ? "" : pnlPct > 0 ? "ok" : "bad");
  }

  function renderPositions(snapshot) {
    const body = $("positionsBody");
    const performanceGrid = $("positionPerformanceGrid");
    if (!body) return;
    const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
    ensureHeldCoinOptions();
    updateTradeFilters();

    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="6">目前沒有持倉</td></tr>';
      if (performanceGrid) {
        performanceGrid.innerHTML = '<div class="position-performance-empty"><i class="fas fa-wallet"></i><strong>目前沒有持倉</strong><span>建立第一筆模擬買單後，幣種漲跌會顯示在這裡。</span></div>';
      }
      return;
    }

    if (performanceGrid) {
      performanceGrid.innerHTML = positions.map((pos) => {
        const rawSymbol = String(pos.symbol || "--").toUpperCase(), symbol = escapeHTML(rawSymbol);
        const avgPrice = finiteNumber(pos.avg_price);
        const currentPrice = finiteNumber(pos.current_price);
        const pnl = finiteNumber(pos.unrealized_pnl);
        const changePct = avgPrice > 0 && currentPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : null;
        const unavailable = snapshot.price_unavailable_symbols?.includes(rawSymbol) || currentPrice === null || currentPrice <= 0 || changePct === null;
        const tone = unavailable ? "unavailable" : (changePct >= 0 ? "gain" : "loss");
        const priceMax = Math.max(avgPrice, currentPrice, 1);
        const costWidth = (avgPrice || 0) / priceMax * 100;
        const currentWidth = (currentPrice || 0) / priceMax * 100;
        return `
          <article class="position-performance-card ${tone}">
            <div class="position-card-top">
              <span class="position-symbol-icon">${escapeHTML(rawSymbol.slice(0, 1))}</span>
              <span><strong>${symbol}</strong><small>${fmtQty(pos.quantity)} 顆</small></span>
              <em class="position-change"><i class="fas fa-arrow-${changePct >= 0 ? "trend-up" : "trend-down"}"></i> ${unavailable ? "--" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}</em>
            </div>
            <div class="position-price-compare">
              <span><small>買入均價</small><strong>${fmtUSD(avgPrice)}</strong></span>
              <i class="fas fa-arrow-right"></i>
              <span><small>目前價格</small><strong>${unavailable ? "--" : fmtUSD(currentPrice)}</strong></span>
            </div>
            <div class="position-price-bars" aria-hidden="true"><span class="cost-bar" style="width:${costWidth}%"></span>${unavailable ? "" : `<span class="current-bar" style="width:${currentWidth}%"></span>`}</div>
            <div class="position-price-bar-legend"><span>上：成本</span><span>下：現價</span></div>
            <div class="position-card-bottom">
              <span>未實現損益 <strong>${unavailable || pnl === null ? "--" : `${pnl > 0 ? "+" : ""}${fmtUSD(pnl)}`}</strong></span>
              <button type="button" class="position-sell-shortcut" data-position-sell="${symbol}" data-position-qty="${Number(pos.quantity || 0)}" ${!/^[A-Z0-9]{2,12}$/.test(rawSymbol) || unavailable || !(Number(pos.quantity) > 0) ? "disabled" : ""}><i class="fas fa-arrow-up-from-bracket" aria-hidden="true"></i> 賣出</button>
            </div>
          </article>`;
      }).join("");
      performanceGrid.querySelectorAll("[data-position-sell]").forEach((button) => {
        button.addEventListener("click", () => {
          if (isLocked || orderPending) return;
          if ($("orderSymbol")) $("orderSymbol").value = button.dataset.positionSell;
          if ($("orderSide")) $("orderSide").value = "sell";
          if ($("orderQty")) $("orderQty").value = button.dataset.positionQty || "";
          if ($("orderAmt")) $("orderAmt").value = "";
          updateQuotePanel();
          refreshSelectedQuote();
          loadMarketSeries();
          scrollToSection("orderPanel");
          setStatus(`已帶入 ${button.dataset.positionSell} 全部持倉；確認數量後再送出賣單。`, "ok");
        });
      });
    }

    body.innerHTML = positions.map((pos) => {
      const pnl = finiteNumber(pos.unrealized_pnl);
      const unavailable = snapshot.price_unavailable_symbols?.includes(pos.symbol) || !(finiteNumber(pos.current_price) > 0);
      return `
        <tr>
          <td>${escapeHTML(pos.symbol)}</td>
          <td>${fmtQty(pos.quantity)}</td>
          <td>${fmtUSD(pos.avg_price)}</td>
          <td>${unavailable ? "--" : fmtUSD(pos.current_price)}</td>
          <td>${unavailable ? "--" : fmtUSD(pos.market_value)}</td>
          <td class="${pnl === null || pnl === 0 ? "" : pnl > 0 ? "ok" : "bad"}">${unavailable ? "--" : fmtUSD(pnl)}</td>
        </tr>
      `;
    }).join("");
  }

  function updateTradeFilters() {
    const select = $("tradeSymbolFilter");
    if (!select) return;
    const selected = select.value;
    const symbols = new Set([
      ...(currentPortfolio?.positions || []).map(item => item.symbol),
      ...tradeHistory.map(item => item.symbol),
    ].filter(Boolean).map(symbol => String(symbol).toUpperCase()));
    select.replaceChildren(new Option("全部幣種", "all"));
    Array.from(symbols).sort().forEach(symbol => select.add(new Option(symbol, symbol)));
    if (symbols.has(selected)) select.value = selected;
  }

  function renderTrades(trades) {
    if (Array.isArray(trades)) {
      tradeHistory = trades;
      updateTradeFilters();
    }
    const body = $("tradesBody");
    if (!body) return;
    const symbol = $("tradeSymbolFilter")?.value || "all";
    const days = Number($("tradeTimeFilter")?.value || 0);
    const filtered = tradeHistory.filter(trade => {
      const date = window.SIFormat.date(trade.timestamp);
      return (symbol === "all" || String(trade.symbol).toUpperCase() === symbol)
        && (tradeSideFilter === "all" || trade.side === tradeSideFilter)
        && (!days || (date && date.getTime() >= Date.now() - days * 86400000));
    }).sort((a,b) => (window.SIFormat.date(b.timestamp)?.getTime() || 0) - (window.SIFormat.date(a.timestamp)?.getTime() || 0));
    if ($("tradeFilterCount")) $("tradeFilterCount").textContent = `${filtered.length} / ${tradeHistory.length} 筆`;
    for (const side of ["buy", "sell"]) {
      const items = filtered.filter(trade => trade.side === side);
      const total = items.some(trade => finiteNumber(trade.amount_usd) === null) ? null : items.reduce((sum, trade) => sum + Number(trade.amount_usd), 0);
      if ($(side === "buy" ? "tradeBuyTotal" : "tradeSellTotal")) $(side === "buy" ? "tradeBuyTotal" : "tradeSellTotal").textContent = fmtUSD(total);
    }
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="6">${tradeHistory.length ? "沒有符合篩選條件的交易。" : "目前沒有交易紀錄"}</td></tr>`;
      return;
    }
    let lastDay = "";
    body.innerHTML = filtered.map((trade) => {
      const day = window.SIFormat.dateKey(trade.timestamp);
      const group = day !== lastDay ? `<tr class="trade-date-group"><td colspan="6">${day === "unknown" ? "日期不明" : day.replaceAll("-", "/")}</td></tr>` : "";
      lastDay = day;
      const safeSymbol = String(trade.symbol || "--").replace(/[^A-Z0-9_-]/gi, "");
      return `${group}
      <tr>
        <td><time>${window.SIFormat.dateText(trade.timestamp)}</time></td>
        <td class="${trade.side === "buy" ? "ok" : "bad"}">${trade.side === "buy" ? "買入" : trade.side === "sell" ? "賣出" : "--"}</td>
        <td>${safeSymbol}</td>
        <td>${fmtUSD(trade.price)}</td>
        <td>${fmtQty(trade.quantity)}</td>
        <td>${fmtUSD(trade.amount_usd)}</td>
      </tr>
    `; }).join("");
  }

  function ensureCharts() {
    if (typeof Chart === "undefined") return false;
    return true;
  }

  function drawEquity(snapshot) {
    const canvas = $("equityChart");
    if (!canvas) return;
    const points = equityData(snapshot, equityDays);
    equityChart?.destroy(); equityChart = null;
    canvas.hidden = !points.length || !ensureCharts();
    if ($("equityEmpty")) {
      $("equityEmpty").hidden = !canvas.hidden;
      $("equityEmpty").textContent = !ensureCharts() ? "圖表服務暫不可用" : "這段期間沒有帳戶快照，完成操作後可再查看。";
    }
    if ($("equityCaption")) $("equityCaption").textContent = `${points.length} 筆實際帳戶快照${snapshot?.price_unavailable_symbols?.length ? " · 目前部分估值暫缺" : ""}`;
    if (canvas.hidden) return;
    const options = chartOptions("總資產");
    options.plugins.tooltip.callbacks.title = items => points[items[0].dataIndex].date
      ? window.SIFormat.dateText(points[items[0].dataIndex].timestamp) : `快照 ${points[items[0].dataIndex].index + 1}`;
    const labels = points.map(point => point.date ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(point.date) : `快照 ${point.index + 1}`);
    canvas.setAttribute("aria-label", `總資產走勢，${points.length} 筆帳戶快照；最近總值 ${fmtUSD(points.at(-1).value)}`);
    equityChart = new Chart(canvas, { type: "line", data: { labels, datasets: [{ label: "總資產", data: points.map(point => point.value),
      borderColor: "#e58a3e", backgroundColor: "rgba(239,138,59,.08)", fill: true, tension: .15, borderWidth: 2.5,
      pointRadius: points.length <= 2 ? 4 : 0, pointHoverRadius: 5 }] }, options });
  }

  function drawAlloc(snapshot) {
    const canvas = $("allocChart");
    if (!canvas) return;
    const mix = allocationData(snapshot);
    allocChart?.destroy(); allocChart = null;
    canvas.hidden = !mix?.total || !ensureCharts();
    if ($("investedPct")) $("investedPct").textContent = mix && mix.investedPct !== null ? `${mix.investedPct.toFixed(1)}%` : "--";
    if ($("allocationCount")) $("allocationCount").textContent = mix ? `${mix.entries.filter(item => item.symbol !== "現金").length} 種持倉` : "估值暫缺";
    if ($("allocationLegend")) $("allocationLegend").innerHTML = mix ? mix.entries.map(item => `<div class="sim-allocation-row"><i class="sim-allocation-dot" style="background:${item.color}" aria-hidden="true"></i><span>${escapeHTML(item.symbol)}</span><b>${item.pct.toFixed(1)}%</b><small>${fmtUSD(item.value)}</small></div>`).join("") : "";
    if ($("allocationEmpty")) {
      $("allocationEmpty").hidden = !canvas.hidden;
      $("allocationEmpty").textContent = !mix ? "部分估值資料缺少，配置比例暫不計算。" : !mix.total ? "目前沒有可計算的資產。" : "圖表服務暫不可用，配置數值仍可查看。";
    }
    if (canvas.hidden) return;
    canvas.setAttribute("aria-label", `現金與持倉配置：${mix.entries.map(item => `${item.symbol} ${item.pct.toFixed(1)}%`).join("、")}`);
    allocChart = new Chart(canvas, { type: "doughnut", data: { labels: mix.entries.map(item => item.symbol), datasets: [{
      data: mix.entries.map(item => item.value), backgroundColor: mix.entries.map(item => item.color), borderWidth: 3, borderColor: "#fff", borderRadius: 3, hoverOffset: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "78%", animation: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.label} ${fmtUSD(context.raw)} · ${mix.entries[context.dataIndex].pct.toFixed(1)}%` } } } } });
  }

  async function refreshPortfolio() {
    await refreshBtcQuote();
    const data = await request("/api/sim-trade/portfolio");
    currentPortfolio = data.portfolio || null;
    stressRequestVersion++;
    lastStressResult = null;
    stressChart?.destroy(); stressChart = null;
    $("stressResults")?.replaceChildren();
    const unavailable = currentPortfolio?.price_unavailable_symbols || [];
    setStressStatus(unavailable.length
      ? `${unavailable.join("、")} 行情暫不可用，總資產與損益暫不顯示；請稍後重新整理。`
      : hasStressablePositions(currentPortfolio)
        ? "帳戶已更新，可比較這份快照在四種假設下的變化。"
        : "尚未持倉：先閱讀情境假設，再到下方練習買入；有持倉後即可比較策略。", unavailable.length ? "warn" : "");
    ensureHeldCoinOptions();
    updateKpis(data.portfolio);
    renderPositions(data.portfolio);
    drawEquity(data.portfolio);
    drawAlloc(data.portfolio);
    updateQuotePanel();
    if ($("simUpdatedAt")) $("simUpdatedAt").textContent = `資料更新 ${new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date())}`;
  }

  async function refreshTrades() {
    const data = await request("/api/sim-trade/history?limit=100", { headers: {} });
    renderTrades(data.trades);
  }

  async function placeOrder() {
    if (orderPending || isLocked) return;
    const symbol = $("orderSymbol")?.value || "BTC";
    const side = $("orderSide")?.value || "buy";
    const quantityRaw = $("orderQty")?.value.trim();
    const amountRaw = $("orderAmt")?.value.trim();

    if (!quantityRaw && !amountRaw) {
      setStatus("請至少填入數量或金額。", "bad");
      return;
    }

    try {
      orderPending = true;
      if ($("btnPlaceOrder")) $("btnPlaceOrder").disabled = true;
      if ($("quoteEstimate")) updateQuotePanel();
      setStatus("委託送出中...", "");
      await request("/api/sim-trade/order", {
        method: "POST",
        body: JSON.stringify({
          symbol,
          side,
          quantity: quantityRaw ? Number(quantityRaw) : null,
          amount_usd: amountRaw ? Number(amountRaw) : null
        })
      });
      $("orderQty").value = "";
      $("orderAmt").value = "";
      setStatus("委託成功，已更新持倉。", "ok");
      await Promise.all([refreshPortfolio(), refreshTrades()]);
      if ($("simReviewLink")) $("simReviewLink").hidden = false;
    } catch (error) {
      setStatus(error.message || "下單失敗", "bad");
    } finally {
      orderPending = false;
      if ($("btnPlaceOrder")) $("btnPlaceOrder").disabled = false;
      if ($("quoteEstimate")) updateQuotePanel();
    }
  }

  async function resetPortfolio() {
    if (orderPending || isLocked) return;
    try {
      orderPending = true; updateQuotePanel();
      setStatus("帳戶重置中...", "");
      await request("/api/sim-trade/reset", {
        method: "POST",
        body: JSON.stringify({})
      });
      setStatus("模擬帳戶已重置。", "ok");
      await Promise.all([refreshPortfolio(), refreshTrades()]);
    } catch (error) {
      setStatus(error.message || "重置失敗", "bad");
    } finally {
      orderPending = false; updateQuotePanel();
    }
  }

  async function loadDemoPortfolio() {
    if (isLocked || orderPending) return;
    if (hasStressablePositions(stressSnapshot())) {
      setStatus("目前已有模擬持倉，可直接進行情境壓力測試；如需重新練習，請先重置帳戶。", "ok");
      scrollToSection("simStress");
      return;
    }
    const requiredCash = DEMO_PORTFOLIO_ORDERS.reduce((sum, order) => sum + order.amount_usd, 0);
    const cash = Number(currentPortfolio?.cash || 0);
    if (cash < requiredCash) {
      setStatus(`練習配置需要至少 ${fmtUSD(requiredCash)} 模擬現金；目前可用 ${fmtUSD(cash)}。`, "bad");
      return;
    }
    try {
      orderPending = true; updateQuotePanel();
      setStatus("正在載入練習配置（僅用於模擬交易，不涉及真實資產）...", "");
      for (const order of DEMO_PORTFOLIO_ORDERS) {
        await request("/api/sim-trade/order", {
          method: "POST",
          body: JSON.stringify({
            symbol: order.symbol,
            side: "buy",
            quantity: null,
            amount_usd: order.amount_usd
          })
        });
      }
      setStatus("已載入練習配置：BTC / ETH / USDC。這只影響模擬交易帳本。", "ok");
      await Promise.all([refreshPortfolio(), refreshTrades()]);
      scrollToSection("simStress");
    } catch (error) {
      setStatus(error.message || "練習配置載入失敗。", "bad");
      await Promise.allSettled([refreshPortfolio(), refreshTrades()]);
    } finally {
      orderPending = false; updateQuotePanel();
    }
  }

  window.addEventListener("smartinvest:auth-state", (event) => {
    if (initialAuthState === null || authReloadPending) return;
    if (Boolean(event.detail?.isPremium) !== initialAuthState) {
      authReloadPending = true;
      window.location.reload();
    }
  });

  document.addEventListener("DOMContentLoaded", async function () {
    ["tradeSymbolFilter", "tradeTimeFilter"].forEach(id => $(id)?.addEventListener("change", () => renderTrades()));
    const setSideFilter = side => {
      tradeSideFilter = side;
      document.querySelectorAll("[data-trade-side]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tradeSide === side)));
      renderTrades();
    };
    document.querySelectorAll("[data-trade-side]").forEach(button => button.addEventListener("click", () => setSideFilter(button.dataset.tradeSide)));
    $("tradeFilterReset")?.addEventListener("click", () => {
      $("tradeSymbolFilter").value = "all";
      $("tradeTimeFilter").value = "all";
      setSideFilter("all");
    });
    const token = await waitForAuthToken();
    initialAuthState = Boolean(token);
    if (!token) {
      setLockedState(true);
      setStatus("模擬交易為進階會員功能，請完成付款開通。", "bad");
      return;
    }

    try {
      setLockedState(false);
      await Promise.all([refreshPortfolio(), refreshTrades(), loadCoins()]);
      loadMarketSeries();
    } catch (error) {
      setStatus(error.message || "請先登入會員。", "bad");
    }

    $("btnPlaceOrder")?.addEventListener("click", function () {
      if (isLocked) return;
      if (!orderDraft().valid) { setStatus("請先確認金額、數量與可用額度。", "bad"); return; }
      placeOrder();
    });

    $("btnReload")?.addEventListener("click", async function () {
      if (isLocked || orderPending) return;
      $("btnReload").disabled = true;
      setStatus("正在重新整理...", "");
      try {
        await Promise.all([refreshPortfolio(), refreshTrades(), refreshSelectedQuote(), loadMarketSeries()]);
        setStatus("資料已更新。", "ok");
      } catch (error) { setStatus(error.message || "更新失敗，請稍後再試。", "bad"); }
      finally { $("btnReload").disabled = false; }
    });

    $("btnReset")?.addEventListener("click", function () {
      if (isLocked || orderPending) return;
      if (!window.confirm("重置會清空這個虛擬帳戶的持倉與交易紀錄。確定重置？")) return;
      resetPortfolio();
    });
    $("btnLoadDemoPortfolio")?.addEventListener("click", function () {
      if (isLocked) return;
      loadDemoPortfolio();
    });

    ["orderQty", "orderAmt"].forEach(id => $(id)?.addEventListener("input", () => {
      if ($(id).value) $(id === "orderQty" ? "orderAmt" : "orderQty").value = "";
      updateQuotePanel();
    }));
    $("orderSide")?.addEventListener("change", updateQuotePanel);
    $("orderSymbol")?.addEventListener("change", () => {
      selectTradingSymbol($("orderSymbol").value);
    });
    $("marketSymbol")?.addEventListener("change", () => selectTradingSymbol($("marketSymbol").value));
    document.querySelectorAll("[data-order-side]").forEach(button => button.addEventListener("click", () => {
      if (orderPending) return;
      $("orderSide").value = button.dataset.orderSide; updateQuotePanel();
    }));
    document.querySelectorAll("[data-order-fraction]").forEach(button => button.addEventListener("click", () => {
      if (orderPending || isLocked) return;
      const draft = orderDraft(), fraction = Number(button.dataset.orderFraction);
      $("orderQty").value = draft.side === "sell" ? String(Math.floor(draft.holdingQty * fraction * 1e8) / 1e8) : "";
      $("orderAmt").value = draft.side === "buy" ? (Math.floor(draft.cash * fraction * 100) / 100).toFixed(2) : "";
      updateQuotePanel();
    }));
    document.querySelectorAll("[data-equity-days]").forEach(button => button.addEventListener("click", () => {
      equityDays = button.dataset.equityDays;
      document.querySelectorAll("[data-equity-days]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      drawEquity(currentPortfolio);
    }));
    document.querySelectorAll("[data-market-days]").forEach(button => button.addEventListener("click", () => {
      marketDays = Number(button.dataset.marketDays);
      document.querySelectorAll("[data-market-days]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      loadMarketSeries();
    }));
    document.querySelectorAll(".sim-section-nav a").forEach(link => link.addEventListener("click", event => {
      event.preventDefault(); scrollToSection(link.getAttribute("href").slice(1));
    }));

    // —— Market Scenario Switcher ——
    async function loadScenarios() {
      try {
        const res = await fetch("/api/market-scenarios");
        if (!res.ok) return;
        const data = await res.json();
        scenarioData = data.scenarios || {};
      } catch (e) {
        console.warn("Failed to load market scenarios", e);
        scenarioData = {};
      }
    }

    document.querySelectorAll(".scenario-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyScenario(btn.dataset.scenario));
    });

    loadScenarios().then(() => applyScenario(activeScenario));
    $("runStressTest")?.addEventListener("click", runStressTest);
    $("stressStrategy")?.addEventListener("change", () => {
      renderStressResults(lastStressResult);
    });
    // —— End Scenario Switcher ——
  });
})();
