
let portfolioAssets = {};
let popularCoinsCache = [];
let weightsChartInstance = null;
const HEALTH_RECORD_KEY_PREFIX = "smartinvest_health_records";
let activeHealthUserId = null;
let activeHealthPremium = false;
let analyzeBusy = false;
let analysisController = null;
let analysisRevision = 0;
let fomoRequestId = 0;
const ALLOCATION_COLORS = ["#ef7d2d", "#368575", "#a5bd86", "#e4b551", "#bb7758", "#7b695d"];

const DEFAULT_COINS = [
  { symbol:"BTC", name:"Bitcoin" },
  { symbol:"ETH", name:"Ethereum" },
  { symbol:"SOL", name:"Solana" },
  { symbol:"XRP", name:"XRP" },
  { symbol:"BNB", name:"BNB" },
  { symbol:"DOGE", name:"Dogecoin" },
  { symbol:"ADA", name:"Cardano" },
  { symbol:"AVAX", name:"Avalanche" },
  { symbol:"LINK", name:"Chainlink" },
  { symbol:"DOT", name:"Polkadot" }
];

function $(id){
  return document.getElementById(id);
}

function isHealthMember(){
  return Boolean(window.authManager?.hasPremiumAccess?.() ?? (window.authManager?.getMembershipTier?.() === "premium"));
}

function requireHealthMember(featureName = "投資健康度"){
  if(isHealthMember()) return true;

  if(window.authManager?.requireMember){
    return window.authManager.requireMember(featureName);
  }

  alert("登入後即可使用此功能。");
  return false;
}

function formatMoney(value){
  const cents = Math.round(Number(value || 0) * 100);
  return "USD " + (cents === 0 ? 0 : cents / 100).toLocaleString("zh-TW", {
    maximumFractionDigits: 2
  });
}

function formatPct(value){
  if(!Number.isFinite(value)) return "--";
  return value.toFixed(1) + "%";
}

function getTotalCapital(){
  const total = Number($("totalCapital")?.value || 0);
  return Number.isFinite(total) ? Math.max(0, Math.round(total*100)/100) : 0;
}

function getAllocatedAmount(){
  return Object.values(portfolioAssets).reduce((sum, item) => sum + Math.round(Number(item.amount || 0) * 100), 0) / 100;
}

function coinIcon(symbol){
  const map = {
    BTC:"₿", ETH:"Ξ", SOL:"S", XRP:"X", BNB:"B",
    DOGE:"Ð", ADA:"A", AVAX:"A", LINK:"L", DOT:"D"
  };
  return map[symbol] || symbol.slice(0, 1);
}

function getHealthUserId(){
  const userId = window.authManager?.getUserId?.() || window.smartInvestMembership?.userId || "";
  return String(userId || "").trim();
}

function getHealthRecordKey(userId = getHealthUserId()){
  const safeUserId = String(userId || "").trim();
  return safeUserId ? `${HEALTH_RECORD_KEY_PREFIX}:${safeUserId}` : `${HEALTH_RECORD_KEY_PREFIX}:guest`;
}

function resetHealthWorkspace(){
  analysisRevision++;
  analysisController?.abort();
  setAnalyzeLoading(false);
  portfolioAssets = {};

  if(weightsChartInstance){
    weightsChartInstance.destroy();
    weightsChartInstance = null;
  }

  if($("assetAmount")) $("assetAmount").value = "";

  if($("assetBubbles")) $("assetBubbles").innerHTML = `<div class="empty">尚未加入配置。</div>`;
  if($("riskBadgeMini")) $("riskBadgeMini").textContent = "尚未計算";
  if($("kTop1")) $("kTop1").textContent = "--";
  if($("kTop3")) $("kTop3").textContent = "--";
  if($("kVol")) $("kVol").textContent = "--";
  if($("kMdd")) $("kMdd").textContent = "--";
  if($("riskMeterText")) $("riskMeterText").textContent = "尚未分析";
  if($("riskBar")) $("riskBar").style.width = "0%";
  renderEmptyHealthReport();

  updateBudgetSummary();
  drawChart();
}

function portfolioReadiness(){
  const total = getTotalCapital(), allocated = getAllocatedAmount();
  if(total <= 0) return {ready:false, message:"先輸入大於 0 的總預算。"};
  if(!Object.keys(portfolioAssets).length) return {ready:false, message:"加入至少一個幣種，或使用一鍵配置。"};
  if(!Number.isFinite(allocated) || Object.values(portfolioAssets).some(a => !Number.isFinite(a.amount) || a.amount <= 0)) return {ready:false, message:"配置金額必須為有效的正數。"};
  if(Math.round(allocated * 100) > Math.round(total * 100)) return {ready:false, message:"配置超過總預算，請調整金額。"};
  const draft = Number($("assetAmount")?.value || 0);
  if(draft !== 0) return {ready:false, message:"有未加入的金額，請先加入配置或清空輸入。"};
  return {ready:true, message:allocated < total ? `尚餘 ${formatMoney(total-allocated)} 未配置；分析以已配置部位為準。` : "預算已完成配置，可以開始檢查。"};
}

function updateAnalyzeReadiness(){
  const state = portfolioReadiness();
  if($("btnAnalyze")) $("btnAnalyze").disabled = analyzeBusy || !state.ready || !isHealthMember();
  if($("allocationReadyTitle")) $("allocationReadyTitle").textContent = analyzeBusy ? "正在檢查配置" : state.ready ? "配置就緒" : "先完成配置";
  if($("allocationReadyText")) $("allocationReadyText").textContent = analyzeBusy ? "讀取歷史行情，整理配置摘要…" : state.message;
  if($("btnAutoAllocate")) $("btnAutoAllocate").disabled = analyzeBusy || getTotalCapital() <= 0;
}

function renderEmptyHealthReport(){
  if($("aiReport")) $("aiReport").innerHTML = `<div class="health-report-empty"><i class="fas fa-chart-simple" aria-hidden="true"></i><strong>你的配置，會在這裡變成一份圖解</strong><div><span>配置比例</span><span>歷史波動</span><span>重點提醒</span></div><small>完成配置後，按「檢查配置」。</small></div>`;
}

function invalidateHealthReport(){
  if(analyzeBusy) return;
  if($("kVol")) $("kVol").textContent = "待檢查";
  if($("kMdd")) $("kMdd").textContent = "待檢查";
  renderEmptyHealthReport();
}

function renderAllocationLegend(){
  const total = getTotalCapital(), allocated = getAllocatedAmount();
  const entries = Object.values(portfolioAssets);
  const base = Math.max(total, allocated);
  const rows = entries.map((asset,index) => ({label:asset.symbol, amount:asset.amount, color:ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]}));
  if(total > allocated) rows.push({label:"未配置", amount:total-allocated, color:"#e9ddcc"});
  if($("allocationLegend")) $("allocationLegend").innerHTML = rows.length ? rows.map(row => `<div class="allocation-legend-row"><div><span class="allocation-dot" style="background:${row.color}" aria-hidden="true"></span><strong>${escapeHTML(row.label)}</strong><b>${formatPct(base > 0 ? row.amount/base*100 : 0)}</b></div><div class="visual-track"><div style="width:${base > 0 ? row.amount/base*100 : 0}%;background:${row.color}"></div></div><small>${formatMoney(row.amount)}</small></div>`).join("") : `<div class="allocation-legend-empty"><i class="fas fa-chart-pie" aria-hidden="true"></i><strong>先加入你的第一個幣種</strong><small>每筆配置都會變成一段比例。</small></div>`;
  const progress = total > 0 ? allocated/total*100 : 0;
  if($("allocationProgressText")) $("allocationProgressText").textContent = allocated > 0 ? `${formatPct(progress)}${allocated > total ? " · 超出預算" : ""}` : "尚未加入配置";
  if($("allocationProgressBar")) $("allocationProgressBar").style.width = Math.min(100,Math.max(0,progress)) + "%";
  if($("allocationProgressBar")) $("allocationProgressBar").classList.toggle("over-budget", allocated > total);
  const ratios = entries.map(a => a.amount/allocated).sort((a,b) => b-a);
  const top1 = ratios[0] || 0, top3 = ratios.slice(0,3).reduce((a,b)=>a+b,0);
  if($("kTop1")) $("kTop1").textContent = allocated > 0 ? formatPct(top1*100) : "--";
  if($("kTop3")) $("kTop3").textContent = allocated > 0 ? formatPct(top3*100) : "--";
  for(const [id,value] of [["top1Bar",top1],["top3Bar",top3],["riskBar",top3]]) if($(id)) $(id).style.width = value*100 + "%";
  const concentration = top1 >= .65 || top3 >= .85 ? "集中偏高" : top1 >= .45 || top3 >= .7 ? "中等集中" : "相對分散";
  if($("riskBadgeMini")) $("riskBadgeMini").textContent = allocated > 0 ? concentration : "尚未配置";
  if($("riskMeterText")) $("riskMeterText").textContent = allocated > 0 ? formatPct(top3*100) + " · 僅配置集中度" : "尚未配置";
}

function updateBudgetSummary(){
  const total = getTotalCapital();
  const allocated = getAllocatedAmount();
  const remaining = total - allocated;

  if($("budgetTotalText")) $("budgetTotalText").textContent = formatMoney(total);
  if($("allocatedAmt")) $("allocatedAmt").textContent = formatMoney(allocated);
  if($("remainingAmt")) $("remainingAmt").textContent = formatMoney(remaining);

  if($("chartAssetCount")) $("chartAssetCount").textContent = Object.keys(portfolioAssets).length + " 種幣";
  if($("chartCenterText")) $("chartCenterText").textContent = allocated > 0 && total > 0 ? formatPct((allocated / total) * 100) : "--";
  if($("chartTotalText")) $("chartTotalText").textContent = allocated > 0 ? "已配置 " + formatMoney(allocated) : "尚未加入";
  renderAllocationLegend();
  updateAnalyzeReadiness();
}

function renderCoinOptions(){
  const select = $("assetSelect");
  if(!select) return;
  const current = select.value || "BTC";
  select.innerHTML = "";
  popularCoinsCache.forEach((coin) => {
    const symbol = String(coin.symbol || "").toUpperCase();
    const name = coin.name || symbol;

    const option = document.createElement("option");
    option.value = symbol;
    option.dataset.name = name;
    option.textContent = `${symbol}｜${name}`;
    select.appendChild(option);
  });
  select.value = popularCoinsCache.some(coin => String(coin.symbol).toUpperCase() === current) ? current : "BTC";
}

async function loadPopularCoins(){
  popularCoinsCache = DEFAULT_COINS;

  try{
    const res = await fetch("/crypto/popular?vs_currency=usd&per_page=24");
    if(res.ok){
      const data = await res.json();

      if(Array.isArray(data) && data.length){
        const liveCoins = data.map((coin) => ({
          symbol: String(coin.symbol || "").toUpperCase(),
          name: coin.name || String(coin.symbol || "").toUpperCase()
        })).filter((coin) => coin.symbol);
        const seen = new Set(liveCoins.map((coin) => coin.symbol));
        popularCoinsCache = liveCoins.concat(DEFAULT_COINS.filter((coin) => !seen.has(coin.symbol)));
      }
    }
  }catch(error){
    console.warn("使用預設幣種清單：", error);
  }

  renderCoinOptions();
  syncFomoSymbolOptions();
}

function addAsset(){
  if(!requireHealthMember("建立投資配置")) return;

  const symbol = ($("assetSelect")?.value || "BTC").toUpperCase();
  const name = $("assetSelect")?.selectedOptions?.[0]?.dataset.name || symbol;
  const amount = Number($("assetAmount")?.value || 0);

  if(analyzeBusy) return;
  if(!Number.isFinite(amount) || Math.round(amount * 100) <= 0){
    alert("請先輸入大於 0 的配置金額。");
    $("assetAmount")?.focus();
    return;
  }

  portfolioAssets[symbol] = {
    symbol,
    name,
    amount: Math.round(amount * 100) / 100
  };

  if($("assetAmount")) $("assetAmount").value = "";
  renderAssets();
}

function removeAsset(symbol){
  if(analyzeBusy) return;
  delete portfolioAssets[symbol];
  renderAssets();
}

function renderAssets(){
  invalidateHealthReport();
  const box = $("assetBubbles");
  const total = getTotalCapital();

  if(!box) return;

  box.innerHTML = "";

  const entries = Object.values(portfolioAssets);

  if(!entries.length){
    box.innerHTML = `<div class="empty">尚未加入配置。</div>`;
    updateBudgetSummary();
    drawChart();
    return;
  }

  entries.forEach((asset) => {
    const ratio = total > 0 ? (asset.amount / total) * 100 : 0;

    const item = document.createElement("div");
    item.className = "asset-chip";
    item.innerHTML = `
      <div class="asset-chip-main">
        <span class="asset-icon">${coinIcon(asset.symbol)}</span>
        <div>
          <b>${escapeHTML(asset.symbol)}</b>
          <small>${escapeHTML(asset.name)}</small>
        </div>
      </div>
      <div class="asset-chip-value">
        <strong>${formatMoney(asset.amount)}</strong>
        <span>${formatPct(ratio)}</span>
      </div>
      <button type="button" class="asset-remove" aria-label="移除 ${asset.symbol}">×</button>
    `;

    item.querySelector(".asset-remove").addEventListener("click", () => {
      removeAsset(asset.symbol);
    });

    box.appendChild(item);
  });

  updateBudgetSummary();
  drawChart();
}

function drawChart(){
  const canvas = $("weightsChart");
  if(!canvas || typeof Chart === "undefined") return;

  const labels = Object.keys(portfolioAssets);
  const data = labels.map((symbol) => portfolioAssets[symbol].amount);
  const hasAssets = labels.length > 0;
  const colors = labels.map((_,i) => ALLOCATION_COLORS[i % ALLOCATION_COLORS.length]);
  const remainder = Math.max(0, getTotalCapital() - getAllocatedAmount());
  if(hasAssets && remainder > 0) { labels.push("未配置"); data.push(remainder); colors.push("#e9ddcc"); }

  if(weightsChartInstance){
    weightsChartInstance.destroy();
  }

  weightsChartInstance = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: hasAssets ? labels : ["尚未配置"],
      datasets: [{
        data: hasAssets ? data : [1],
        borderWidth: hasAssets ? 4 : 0,
        borderColor: "#fff",
        borderRadius: hasAssets ? 5 : 0,
        backgroundColor: hasAssets ? colors : ["#ede4d7"],
        hoverOffset: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "78%",
      plugins: {
        tooltip: { enabled: hasAssets, callbacks: {label:ctx => `${ctx.label}: ${formatMoney(ctx.raw)} (${formatPct(ctx.raw/data.reduce((a,b)=>a+b,0)*100)})`} },
        legend: {
          display: false,
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 8,
            font: {
              size: 16,
              weight: "bold"
            }
          }
        }
      }
    }
  });
}

function clearAllAssets(){
  if(!requireHealthMember("清空投資配置")) return;
  if(analyzeBusy) return;

  portfolioAssets = {};
  renderAssets();

  if($("riskBadgeMini")) $("riskBadgeMini").textContent = "待分析";
  if($("kTop1")) $("kTop1").textContent = "--";
  if($("kTop3")) $("kTop3").textContent = "--";
  if($("kVol")) $("kVol").textContent = "--";
  if($("kMdd")) $("kMdd").textContent = "--";
  if($("riskMeterText")) $("riskMeterText").textContent = "尚未計算";
  if($("riskBar")) $("riskBar").style.width = "0%";
  renderEmptyHealthReport();
}

function setAnalyzeLoading(isLoading){
  analyzeBusy = isLoading;
  document.querySelectorAll?.(".setup-card input,.setup-card select,.setup-card button,.asset-remove").forEach(el => { el.disabled = isLoading; });
  const btn = $("btnAnalyze");
  if(!btn) { updateAnalyzeReadiness(); return; }

  if(!btn.dataset.originalHtml){
    btn.dataset.originalHtml = btn.innerHTML;
  }

  btn.classList.toggle("is-loading", isLoading);
  btn.innerHTML = isLoading
    ? '<i class="fas fa-spinner fa-spin"></i> 檢查中...'
    : btn.dataset.originalHtml;
  updateAnalyzeReadiness();
}

function buildHoldingsPayload(){
  const allocated = getAllocatedAmount();
  return Object.values(portfolioAssets).map((asset) => ({
    ticker: asset.symbol,
    weight: allocated > 0 ? Number(asset.amount || 0) / allocated : 0
  }));
}

function renderAiReport(narrative, highlights, metrics, analysisMode = "rules", aiStatus = ""){
  if(!$("aiReport")) return;
  const allocated = getAllocatedAmount();
  const assets = Object.values(portfolioAssets).sort((a,b)=>b.amount-a.amount);
  const ratios = assets.map(a=>a.amount/allocated);
  const top1 = Number(metrics?.top1_weight ?? ratios[0] ?? 0);
  const top3 = Number(metrics?.top3_weight ?? ratios.slice(0,3).reduce((a,b)=>a+b,0));
  const validMetric = value => metrics?.market_data_available !== false && value != null && Number.isFinite(Number(value));
  const vol = validMetric(metrics?.annual_vol) ? Number(metrics.annual_vol) : null;
  const mdd = validMetric(metrics?.max_drawdown) ? Number(metrics.max_drawdown) : null;
  const riskTone = top1 >= .65 || top3 >= .85 ? "集中偏高" : top1 >= .45 || top3 >= .7 ? "中等集中" : "相對分散";
  const statusNote = analysisMode === "ai" ? "AI 解說已完成" : "依資料產生的規則分析";
  const marketNote = vol === null || mdd === null ? "行情不足；目前僅能核對配置集中度。" : "波動與回撤採歷史行情計算，不是未來損失預測。";
  const list = Array.isArray(highlights) ? highlights.slice(0,5) : [];
  const width = ratio => Math.max(0,Math.min(100,Number.isFinite(ratio)?ratio*100:0));
  $("aiReport").innerHTML = `
    <div class="health-report-overview"><div><span class="report-kicker">${statusNote}</span><h3>配置集中度 · ${riskTone}</h3><small>${assets.length} 種幣 / 已配置 ${formatMoney(allocated)}</small></div><span class="report-complete"><i class="fas fa-check" aria-hidden="true"></i> 檢查完成</span></div>
    <div class="health-report-graphics">
      <section class="report-allocation-graphic"><strong><i class="fas fa-chart-pie" aria-hidden="true"></i> 已配置部位比例</strong><div class="report-stack" role="img" aria-label="各幣種占已配置部位比例，詳細比例列於下方">${assets.map((asset,index)=>`<div style="width:${width(asset.amount/allocated)}%;background:${ALLOCATION_COLORS[index%ALLOCATION_COLORS.length]}"></div>`).join("")}</div><div class="report-asset-legend">${assets.map((asset,index)=>`<span><i style="background:${ALLOCATION_COLORS[index%ALLOCATION_COLORS.length]}" aria-hidden="true"></i>${escapeHTML(asset.symbol)} <b>${formatPct(asset.amount/allocated*100)}</b></span>`).join("")}</div><small>以已配置金額為 100%；未配置預算不計入。</small></section>
      <section class="report-concentration-graphic"><strong><i class="fas fa-bullseye" aria-hidden="true"></i> 集中在哪裡？</strong><div><span>最大單幣</span><b>${formatPct(top1*100)}</b></div><div class="visual-track"><div style="width:${width(top1)}%"></div></div><div><span>前三大幣</span><b>${formatPct(top3*100)}</b></div><div class="visual-track"><div style="width:${width(top3)}%"></div></div><small>占比越高，配置越集中。</small></section>
    </div>
    <div class="health-report-metrics"><div><i class="fas fa-wave-square" aria-hidden="true"></i><span>歷史年化波動</span><strong>${vol !== null ? formatPct(vol*100) : "資料不足"}</strong><small>觀察價格起伏幅度</small></div><div><i class="fas fa-arrow-trend-down" aria-hidden="true"></i><span>歷史最大回撤</span><strong>${mdd !== null ? formatPct(mdd*100) : "資料不足"}</strong><small>觀察區間最大跌幅</small></div><div><i class="fas fa-list-check" aria-hidden="true"></i><span>接下來留意</span><strong>${top1 >= .65 || top3 >= .85 ? "持幣集中" : "配置偏移"}</strong><small>核對比例與可承受範圍</small></div></div>
    <p class="report-data-note"><i class="fas fa-circle-info" aria-hidden="true"></i> ${marketNote}</p>
    <details class="health-report-details"><summary>查看完整解說與重點</summary><div class="report-narrative">${escapeHTML(String(narrative || "暫無解說。")).replace(/\n/g,"<br>")}</div>${list.length ? `<ul>${list.map(item=>`<li>${escapeHTML(item)}</li>`).join("")}</ul>` : ""}<small>${analysisMode === "ai" ? "" : "AI 服務目前不可用，以上為規則分析。"}</small></details>
  `;
}

function escapeHTML(value){
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function scrollToHealthReport(){
  const report = $("healthReportCard");
  if(!report) return;
  const headerHeight = document.querySelector?.(".site-header")?.getBoundingClientRect().height || 0;
  const top = report.getBoundingClientRect().top + window.scrollY - headerHeight - 16;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  $("healthReportTitle")?.focus({preventScroll:true});
  window.scrollTo({top:Math.max(0,top), behavior:reducedMotion ? "instant" : "smooth"});
}

async function analyzePortfolio(){
  if(!requireHealthMember("投資健康度")) return;
  if(analyzeBusy) return;

  const total = getTotalCapital();
  const allocated = getAllocatedAmount();

  const readiness = portfolioReadiness();
  if(!readiness.ready){
    updateAnalyzeReadiness();
    return;
  }
  const revision = ++analysisRevision;
  analysisController = new AbortController();
  const signal = analysisController.signal;
  let reportRendered = false;

  const ratios = Object.values(portfolioAssets)
    .map((asset) => asset.amount / allocated)
    .sort((a, b) => b - a);

  const top1 = ratios[0] || 0;
  const top3 = ratios.slice(0, 3).reduce((sum, value) => sum + value, 0);

  const riskLabel = top1 >= .65 || top3 >= .85 ? "偏高" : top1 >= .45 || top3 >= .7 ? "中等" : "分散";

  if($("riskBadgeMini")) $("riskBadgeMini").textContent = riskLabel;
  if($("kTop1")) $("kTop1").textContent = formatPct(top1 * 100);
  if($("kTop3")) $("kTop3").textContent = formatPct(top3 * 100);
  if($("kVol")) $("kVol").textContent = "尚未取得行情";
  if($("kMdd")) $("kMdd").textContent = "尚未取得行情";
  if($("riskMeterText")) $("riskMeterText").textContent = "僅配置集中度：" + riskLabel;
  if($("riskBar")) $("riskBar").style.width = "0%";

  if($("aiReport")) $("aiReport").textContent = "正在讀取歷史行情並建立配置報告…";

  saveHealthRecord({
    createdAt: new Date().toISOString(),
    total,
    allocated,
    riskLabel,
    top1,
    top3,
    assets: Object.values(portfolioAssets).map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      amount: asset.amount,
      ratio: allocated > 0 ? asset.amount / allocated : 0
    }))
  });

  setAnalyzeLoading(true);

  try{
    const payload = {
      user_id: "demo_user",
      base_currency: "USD",
      days: Number($("days")?.value || 90),
      seed: Number($("seed")?.value || 42),
      holdings: buildHoldingsPayload()
    };

    const token = await window.authManager?.getToken?.();
    const headers = {"Content-Type": "application/json"};
    if(token) headers.Authorization = `Bearer ${token}`;
    let aiPayload = null;
    let riskPayload = null;
    const aiRes = await fetch("/portfolio/analyze-llm", {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(payload)
      });
    if(aiRes.ok) aiPayload = await aiRes.json();
    if(revision !== analysisRevision) return;
    if(!aiPayload?.risk_health){
      const riskRes = await fetch("/portfolio/risk-health", {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(payload)
      });
      if(riskRes.ok) riskPayload = await riskRes.json();
    }
    if(revision !== analysisRevision) return;

    const rh = aiPayload?.risk_health || riskPayload?.risk_health;
    if(rh){

      if($("kTop1")) $("kTop1").textContent = formatPct(Number(rh.top1_weight ?? top1) * 100);
      if($("kTop3")) $("kTop3").textContent = formatPct(Number(rh.top3_weight ?? top3) * 100);
      const hasMarketData = rh.market_data_available !== false && rh.annual_vol != null && rh.max_drawdown != null && Number.isFinite(Number(rh.annual_vol)) && Number.isFinite(Number(rh.max_drawdown));
      if($("kVol")) $("kVol").textContent = hasMarketData ? formatPct(Number(rh.annual_vol) * 100) : "資料不足";
      if($("kMdd")) $("kMdd").textContent = hasMarketData ? formatPct(Number(rh.max_drawdown) * 100) : "資料不足";

      if($("riskBar")) $("riskBar").style.width = Number(rh.top3_weight ?? top3)*100 + "%";
      if($("riskMeterText")) $("riskMeterText").textContent = formatPct(Number(rh.top3_weight ?? top3)*100) + " · 僅配置集中度";
      if(!hasMarketData){
        if($("riskBar")) $("riskBar").style.width = "0%";
        if($("riskMeterText")) $("riskMeterText").textContent = "行情不足，無法評分";
        if($("riskBadgeMini")) $("riskBadgeMini").textContent = "資料不足";
      }
    }

    const fallbackNarrative = `目前配置 ${Object.keys(portfolioAssets).length} 種幣別，最大單一幣種占 ${formatPct(top1 * 100)}，前三大合計 ${formatPct(top3 * 100)}。請核對這兩項集中度是否符合原先設定；即使分成多種幣別，仍應留意整體加密市場波動。`;
    renderAiReport(aiPayload?.narrative || fallbackNarrative, aiPayload?.highlights || [
      `最大持幣占 ${formatPct(top1 * 100)}，請核對單幣上限。`,
      `前三大持幣合計 ${formatPct(top3 * 100)}，請檢查是否需要再平衡。`,
      rh?.market_data_available ? "參考歷史波動與回撤，確認是否符合個人承受範圍。" : "行情不足，暫時無法估算歷史波動與回撤。"
    ], rh || {top1_weight: top1, top3_weight: top3}, aiPayload?.analysis_mode || "rules", aiPayload?.ai_status || (aiRes.ok ? "" : "service_unavailable"));
    reportRendered = true;
  }catch(error){
    if(revision !== analysisRevision || signal.aborted) return;
    console.warn("AI health report fallback:", error);
    renderAiReport(`目前配置 ${Object.keys(portfolioAssets).length} 種幣別，最大單一幣種占 ${formatPct(top1 * 100)}，前三大合計 ${formatPct(top3 * 100)}。完整波動與回撤資料暫時無法取得，請稍後重試。`, ["目前僅能核對配置集中度；缺少行情不代表零風險。"], {top1_weight: top1, top3_weight: top3}, "rules", "service_unavailable");
    reportRendered = true;
  }finally{
    if(revision === analysisRevision){
      setAnalyzeLoading(false);
      if(reportRendered && !signal.aborted) scrollToHealthReport();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadPopularCoins();
  renderAssets();

  $("btnRefreshCoins")?.addEventListener("click", loadPopularCoins);
  $("btnAddAsset")?.addEventListener("click", addAsset);
  $("btnClearAll")?.addEventListener("click", clearAllAssets);
  $("btnAnalyze")?.addEventListener("click", analyzePortfolio);
  $("totalCapital")?.addEventListener("input", renderAssets);
  $("days")?.addEventListener("change", invalidateHealthReport);
  $("assetAmount")?.addEventListener("input", updateAnalyzeReadiness);


  $("fomoSymbol")?.addEventListener("change", updateFomoChange);
  $("btnFomo")?.addEventListener("click", runFomoCheck);
  $("btnAutoAllocate")?.addEventListener("click", runAutoAllocate);
  $("btnClearHealthRecords")?.addEventListener("click", clearHealthRecords);
  $("healthHistoryRange")?.addEventListener("change", renderHealthRecords);
  $("btnToggleHealthRecords")?.addEventListener("click", () => {
    const button = $("btnToggleHealthRecords");
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "收合歷史" : "展開歷史";
    $("healthRecordList").hidden = !expanded;
    $("healthHistoryFilters").hidden = !expanded;
    renderHealthRecords();
  });

  $("assetAmount")?.addEventListener("keydown", (event) => {
    if(event.key === "Enter"){
      event.preventDefault();
      addAsset();
    }
  });

  handleHealthAuthStateChange({ detail: { userId: getHealthUserId() } });
  window.addEventListener("smartinvest:auth-state", handleHealthAuthStateChange);
});



/* restored FOMO + AI one-click allocation */
function syncFomoSymbolOptions(){
  const select = $("fomoSymbol");
  if(!select) return;

  const current = select.value;
  select.innerHTML = "";

  const coins = popularCoinsCache.length ? popularCoinsCache : DEFAULT_COINS;

  coins.slice(0, 24).forEach((coin) => {
    const symbol = String(coin.symbol || "").toUpperCase();
    if(!symbol) return;

    const option = document.createElement("option");
    option.value = symbol;
    option.textContent = `${symbol}｜${coin.name || symbol}`;
    select.appendChild(option);
  });

  if(current){
    select.value = current;
  }

  updateFomoChange();
}

async function updateFomoChange(){
  const symbol = $("fomoSymbol")?.value || "BTC", input = $("fomoChange");
  if(!input) return;
  const requestId = ++fomoRequestId;
  input.value = "--";
  delete input.dataset.change;
  input.dataset.direction = "neutral";
  if($("btnFomo")) $("btnFomo").disabled = true;
  if($("fomoMarker")) $("fomoMarker").hidden = true;
  if($("fomoQuoteStatus")) $("fomoQuoteStatus").textContent = "讀取中";
  if($("fomoResult")) { $("fomoResult").className = "fomo-result"; $("fomoResult").textContent = "讀取 24 小時行情中…"; }
  try{
    const res = await fetch("/crypto/popular?vs_currency=usd&per_page=50");
    if(res.ok){
      const data = await res.json();
      if(requestId !== fomoRequestId) return;
      const item = Array.isArray(data) ? data.find(coin=>String(coin.symbol || "").toUpperCase()===symbol) : null;
      const change = Number(item?.price_change_percentage_24h ?? item?.change_24h ?? item?.change ?? NaN);
      if(Number.isFinite(change)){
        input.value = (change>0?"+":"")+change.toFixed(2)+"%";
        input.dataset.change = String(change);
        input.dataset.direction = change>0?"up":change<0?"down":"neutral";
        if($("fomoDirection")) $("fomoDirection").innerHTML = `<i class="fas fa-${change>0?"arrow-trend-up":change<0?"arrow-trend-down":"minus"}"></i>`;
        if($("fomoMarker")) { $("fomoMarker").hidden = false; $("fomoMarker").style.left = `${Math.max(0,Math.min(100,(change+15)/30*100))}%`; }
        if($("fomoScaleNote")) $("fomoScaleNote").textContent = Math.abs(change)>15 ? "圖尺顯示至 ±15%；上方為實際漲跌幅。" : "依 24H 漲跌幅檢測；不是價格預測。";
        if($("fomoQuoteStatus")) $("fomoQuoteStatus").textContent = symbol+" · 已讀取";
        if($("fomoResult")) $("fomoResult").textContent = "行情已就緒，按下按鈕查看追高風險。";
        if($("btnFomo")) $("btnFomo").disabled = false;
        return;
      }
    }
  }catch(error){ console.warn("FOMO 行情讀取失敗", error); }
  if(requestId !== fomoRequestId) return;
  if($("fomoQuoteStatus")) $("fomoQuoteStatus").textContent = "行情不足";
  if($("fomoDirection")) $("fomoDirection").innerHTML = '<i class="fas fa-circle-question"></i>';
  if($("fomoResult")) $("fomoResult").textContent = "暫無此幣種的 24H 行情，請換幣種或更新清單。";
}

function runFomoCheck(){
  const symbol = $("fomoSymbol")?.value || "BTC", result = $("fomoResult");
  const value = $("fomoChange")?.dataset.change;
  if(!result || value == null) return;
  const raw = Number(value);
  if(!Number.isFinite(raw)) return;
  let level = "low", title = "低度 FOMO", icon = "check", text = "漲幅未達追高門檻；不代表沒有風險。";
  if(raw >= 10){ level="high"; title="高度 FOMO 風險"; icon="fire"; text="短線急漲，先確認資訊，留意追高情緒。"; }
  else if(raw >= 5){ level="medium"; title="中度 FOMO 風險"; icon="triangle-exclamation"; text="短線漲幅偏高，留意情緒是否影響判斷。"; }
  else if(raw <= -8){ level="medium"; title="下跌恐慌風險"; icon="arrow-trend-down"; text="短線跌幅明顯，留意恐慌情緒與價格波動。"; }
  result.className = `fomo-result show ${level}`;
  result.innerHTML = `<span class="fomo-result-icon" aria-hidden="true"><i class="fas fa-${icon}"></i></span><div><strong>${title}</strong><small>${escapeHTML(symbol)} · ${text}</small></div>`;
}

async function runAutoAllocate(){
  if(!requireHealthMember("一鍵配置")) return;
  if(analyzeBusy || $("btnAutoAllocate")?.disabled) return;

  const risk = $("autoRiskLevel")?.value || "balanced";
  const total = getTotalCapital();

  if(!total || total <= 0){
    alert("請先輸入總投資預算。");
    $("totalCapital")?.focus();
    return;
  }

  const plans = {
    conservative: [
      ["BTC", "Bitcoin", 0.50],
      ["ETH", "Ethereum", 0.30],
      ["BNB", "BNB", 0.10],
      ["USDT", "Stablecoin", 0.10]
    ],
    balanced: [
      ["BTC", "Bitcoin", 0.35],
      ["ETH", "Ethereum", 0.30],
      ["SOL", "Solana", 0.15],
      ["LINK", "Chainlink", 0.10],
      ["BNB", "BNB", 0.10]
    ],
    aggressive: [
      ["BTC", "Bitcoin", 0.25],
      ["ETH", "Ethereum", 0.25],
      ["SOL", "Solana", 0.22],
      ["AVAX", "Avalanche", 0.13],
      ["DOGE", "Dogecoin", 0.08],
      ["LINK", "Chainlink", 0.07]
    ]
  };

  portfolioAssets = {};

  const totalCents = Math.round(total * 100);
  const amounts = plans[risk].map(([, , ratio]) => Math.floor(totalCents * ratio));
  const remainders = plans[risk].map(([, , ratio], index) => ({index, fraction:totalCents * ratio - amounts[index]})).sort((a,b) => b.fraction - a.fraction);
  const extraCents = totalCents - amounts.reduce((sum, value) => sum + value, 0);
  for(let i = 0; i < extraCents; i++) amounts[remainders[i % remainders.length].index]++;
  plans[risk].forEach(([symbol, name, ratio], index, plan) => {
    const cents = amounts[index];
    if(cents <= 0) return;
    portfolioAssets[symbol] = {
      symbol,
      name,
      amount: cents / 100
    };
  });

  renderAssets();
  if($("assetAmount")) $("assetAmount").value = "";
  updateAnalyzeReadiness();
  if($("allocationReadyText")) $("allocationReadyText").textContent = "示範比例已套用；可調整金額，再按「檢查配置」。";
  $("weightsChart")?.scrollIntoView({behavior:"smooth",block:"center"});
}

function readHealthRecords(){
  if(!isHealthMember()) return [];

  try{
    const parsed = JSON.parse(localStorage.getItem(getHealthRecordKey()) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  }catch(error){
    return [];
  }
}

function writeHealthRecords(records){
  localStorage.setItem(getHealthRecordKey(), JSON.stringify(records.slice(0, 100)));
}

function saveHealthRecord(record){
  if(!isHealthMember()) return;
  const records = readHealthRecords();
  records.unshift(record);
  writeHealthRecords(records);
  renderHealthRecords();
}

function renderHealthRecords(){
  const list = $("healthRecordList");
  if(!list) return;

  if(!isHealthMember()){
    list.innerHTML = `<div class="member-record-empty">登入後即可查看個人化投資健康度紀錄。</div>`;
    return;
  }

  const days = Number($("healthHistoryRange")?.value || 0);
  const allRecords = readHealthRecords();
  const records = allRecords.filter(record => !days || (window.SIFormat.date(record.createdAt)?.getTime() >= Date.now() - days * 86400000))
    .sort((a,b) => (window.SIFormat.date(b.createdAt)?.getTime() || 0) - (window.SIFormat.date(a.createdAt)?.getTime() || 0));
  if($("healthHistoryCount")) $("healthHistoryCount").textContent = `${records.length} 筆紀錄（最多保留 100 筆）`;
  if(!records.length){
    list.innerHTML = `<div class="member-record-empty">${allRecords.length ? "此時間範圍沒有紀錄。" : "尚無紀錄。完成健康度檢查後，自動保存配置摘要。"}</div>`;
    return;
  }

  const groups = new Map();
  records.forEach(record => {
    const day = window.SIFormat.dateKey(record.createdAt);
    if(!groups.has(day)) groups.set(day, []);
    groups.get(day).push(record);
  });
  list.innerHTML = Array.from(groups, ([day, items], index) => `<details class="history-day-group" ${index === 0 ? "open" : ""}><summary>${day === "unknown" ? "日期不明" : day.replaceAll("-", "/")} <span>${items.length} 筆</span></summary>${items.map((record) => {
    const date = window.SIFormat.dateText(record.createdAt);
    const assets = Array.isArray(record.assets) ? record.assets : [];
    const assetText = assets.slice(0, 4)
      .map((asset) => `${escapeHTML(asset.symbol)} ${formatPct(Number(asset.ratio || 0) * 100)}`)
      .join(" · ");

    return `
      <article class="health-record-item">
        <div>
          <span>${date}</span>
          <strong>${escapeHTML(record.riskLabel || "待分析")}</strong>
          <p>${assetText || "未保存配置明細"}</p><details class="health-record-assets"><summary>查看配置明細</summary><table><thead><tr><th>幣種</th><th>配置金額（USD）</th><th>比例</th></tr></thead><tbody>${assets.map(asset => `<tr><td>${escapeHTML(asset.symbol)}</td><td>${formatMoney(asset.amount)}</td><td>${formatPct(Number(asset.ratio || 0)*100)}</td></tr>`).join("")}</tbody></table></details>
        </div>
        <div class="record-metrics">
          <div><span>最大占比</span><strong class="numeric">${formatPct(Number(record.top1 || 0) * 100)}</strong></div>
          <div><span>前三占比</span><strong class="numeric">${formatPct(Number(record.top3 || 0) * 100)}</strong></div>
        </div>
      </article>
    `;
  }).join("")}</details>`).join("");
}

function clearHealthRecords(){
  if(!requireHealthMember("投資健康度紀錄")) return;
  if(!confirm("確定清除這個帳號在此瀏覽器的健康度紀錄？")) return;
  localStorage.removeItem(getHealthRecordKey());
  renderHealthRecords();
}

function handleHealthAuthStateChange(event){
  const nextUserId = String(event?.detail?.userId || getHealthUserId() || "").trim();
  const nextPremium = isHealthMember();
  if (nextUserId !== activeHealthUserId || nextPremium !== activeHealthPremium) {
    activeHealthUserId = nextUserId;
    activeHealthPremium = nextPremium;
    resetHealthWorkspace();
  }
  renderHealthRecords();
  updateAnalyzeReadiness();
}
