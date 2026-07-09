
let portfolioAssets = {};
let popularCoinsCache = [];
let weightsChartInstance = null;
const HEALTH_RECORD_KEY_PREFIX = "smartinvest_health_records";
let activeHealthUserId = null;

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
  return Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
}

function requireHealthMember(featureName = "投資配置健康度檢查"){
  if(isHealthMember()) return true;

  if(window.authManager?.requireMember){
    return window.authManager.requireMember(featureName);
  }

  alert("登入後即可使用此功能。");
  return false;
}

function formatMoney(value){
  return Number(value || 0).toLocaleString("zh-TW", {
    maximumFractionDigits: 2
  });
}

function formatPct(value){
  if(!Number.isFinite(value)) return "--";
  return value.toFixed(1) + "%";
}

function getTotalCapital(){
  const total = Number($("totalCapital")?.value || 0);
  return Math.max(0, total);
}

function getAllocatedAmount(){
  return Object.values(portfolioAssets).reduce((sum, item) => {
    return sum + Number(item.amount || 0);
  }, 0);
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
  portfolioAssets = {};

  if(weightsChartInstance){
    weightsChartInstance.destroy();
    weightsChartInstance = null;
  }

  if($("assetAmount")) $("assetAmount").value = "";
  if($("coinSearchInput")) $("coinSearchInput").value = "";
  if($("fomoChange")) {
    $("fomoChange").value = "";
    delete $("fomoChange").dataset.change;
  }

  if($("assetBubbles")) $("assetBubbles").innerHTML = `<div class="empty">尚未加入配置。</div>`;
  if($("riskBadgeMini")) $("riskBadgeMini").textContent = "尚未計算";
  if($("kTop1")) $("kTop1").textContent = "--";
  if($("kTop3")) $("kTop3").textContent = "--";
  if($("kVol")) $("kVol").textContent = "--";
  if($("kMdd")) $("kMdd").textContent = "--";
  if($("riskMeterText")) $("riskMeterText").textContent = "尚未分析";
  if($("riskBar")) $("riskBar").style.width = "0%";
  if($("aiReport")) $("aiReport").textContent = "完成健康度檢查後，這裡會顯示配置摘要。";

  updateBudgetSummary();
  drawChart();
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
}

function selectCoin(symbol, name){
  const upper = String(symbol || "BTC").toUpperCase();
  if($("assetSelect")) $("assetSelect").value = upper;
  if($("coinPickerAvatar")) $("coinPickerAvatar").textContent = coinIcon(upper);
  if($("coinPickerSymbol")) $("coinPickerSymbol").textContent = upper;
  if($("coinPickerName")) $("coinPickerName").textContent = name || upper;
  if($("coinDropdown")) $("coinDropdown").classList.remove("show");
}

function renderCoinOptions(){
  const wrap = $("coinBubbleOptions");
  const query = ($("coinSearchInput")?.value || "").trim().toUpperCase();

  if(!wrap) return;

  wrap.innerHTML = "";

  const filtered = popularCoinsCache.filter((coin) => {
    const text = `${coin.symbol || ""} ${coin.name || ""}`.toUpperCase();
    return text.includes(query);
  }).slice(0, 24);

  filtered.forEach((coin) => {
    const symbol = String(coin.symbol || "").toUpperCase();
    const name = coin.name || symbol;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "coin-bubble";
    btn.innerHTML = `<b>${symbol}</b><span>${name}</span>`;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      selectCoin(symbol, name);
    });

    wrap.appendChild(btn);
  });
}

async function loadPopularCoins(){
  popularCoinsCache = DEFAULT_COINS;

  try{
    const res = await fetch("/crypto/popular?vs_currency=usd&per_page=24");
    if(res.ok){
      const data = await res.json();

      if(Array.isArray(data) && data.length){
        popularCoinsCache = data.map((coin) => ({
          symbol: String(coin.symbol || "").toUpperCase(),
          name: coin.name || String(coin.symbol || "").toUpperCase()
        })).filter((coin) => coin.symbol);
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
  const name = $("coinPickerName")?.textContent || symbol;
  const amount = Number($("assetAmount")?.value || 0);

  if(!amount || amount <= 0){
    alert("請先輸入大於 0 的配置金額。");
    $("assetAmount")?.focus();
    return;
  }

  portfolioAssets[symbol] = {
    symbol,
    name,
    amount
  };

  if($("assetAmount")) $("assetAmount").value = "";
  renderAssets();
}

function removeAsset(symbol){
  delete portfolioAssets[symbol];
  renderAssets();
}

function renderAssets(){
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
          <b>${asset.symbol}</b>
          <small>${asset.name}</small>
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

  if(weightsChartInstance){
    weightsChartInstance.destroy();
  }

  weightsChartInstance = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 8,
            font: {
              size: 12,
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

  portfolioAssets = {};
  renderAssets();

  if($("riskBadgeMini")) $("riskBadgeMini").textContent = "待分析";
  if($("kTop1")) $("kTop1").textContent = "--";
  if($("kTop3")) $("kTop3").textContent = "--";
  if($("kVol")) $("kVol").textContent = "--";
  if($("kMdd")) $("kMdd").textContent = "--";
  if($("riskMeterText")) $("riskMeterText").textContent = "尚未計算";
  if($("riskBar")) $("riskBar").style.width = "0%";
  if($("aiReport")) $("aiReport").textContent = "完成健康度檢查後，這裡會顯示配置摘要。";
}

function setAnalyzeLoading(isLoading){
  const btn = $("btnAnalyze");
  if(!btn) return;

  if(!btn.dataset.originalHtml){
    btn.dataset.originalHtml = btn.innerHTML;
  }

  btn.disabled = isLoading;
  btn.classList.toggle("is-loading", isLoading);
  btn.innerHTML = isLoading
    ? '<i class="fas fa-spinner fa-spin"></i> 檢查中...'
    : btn.dataset.originalHtml;
}

function buildHoldingsPayload(){
  const allocated = getAllocatedAmount();
  return Object.values(portfolioAssets).map((asset) => ({
    ticker: asset.symbol,
    weight: allocated > 0 ? Number(asset.amount || 0) / allocated : 0
  }));
}

function renderAiReport(narrative, highlights, metrics){
  const safeNarrative = String(narrative || "目前無法取得 AI 報告，請稍後再試。");
  const list = Array.isArray(highlights) && highlights.length ? highlights : [
    "檢查最大單一資產是否過度集中。",
    "觀察前三大資產是否占比過高。",
    "依照個人風險承受度定期再平衡。"
  ];
  const top1 = Number(metrics?.top1_weight || 0);
  const top3 = Number(metrics?.top3_weight || 0);
  const vol = Number(metrics?.annual_vol || 0);
  const riskTone = top3 >= 0.8 || top1 >= 0.5 ? "集中偏高" : top3 >= 0.65 ? "中等集中" : "相對分散";

  if(!$("aiReport")) return;

  $("aiReport").innerHTML = `
    <div class="ai-report-grid">
      <div class="ai-summary-panel">
        <div>
          <span class="report-kicker">AI Portfolio Brief</span>
          <h3>配置健康摘要</h3>
          <p>${escapeHTML(safeNarrative).replace(/\n/g, "<br>")}</p>
        </div>
        <div class="report-status">
          <small>目前狀態</small>
          <strong>${riskTone}</strong>
        </div>
      </div>
      <div class="report-stat-strip">
        <div><span>最大占比</span><strong>${top1 ? formatPct(top1 * 100) : "--"}</strong></div>
        <div><span>前三占比</span><strong>${top3 ? formatPct(top3 * 100) : "--"}</strong></div>
        <div><span>年化波動</span><strong>${vol ? formatPct(vol * 100) : "--"}</strong></div>
      </div>
      <div class="report-detail-grid">
        <section class="ai-report-section">
          <strong><i class="fas fa-circle-exclamation"></i> 重點提醒</strong>
          <ul>${list.slice(0, 5).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
        </section>
        <section class="ai-report-section">
          <strong><i class="fas fa-list-check"></i> 下一步建議</strong>
          <ul>
            <li>先確認最大持倉是否超過你能承受的波動範圍。</li>
            <li>若前三大資產過度集中，補足不同類型資產或保留現金部位。</li>
            <li>大漲大跌後重新檢查一次，避免配置偏離原本風險屬性。</li>
          </ul>
        </section>
      </div>
    </div>
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

async function analyzePortfolio(){
  if(!requireHealthMember("投資配置健康度檢查")) return;

  const total = getTotalCapital();
  const allocated = getAllocatedAmount();

  if(!allocated){
    alert("請先加入至少一個幣種配置。");
    return;
  }

  const ratios = Object.values(portfolioAssets)
    .map((asset) => asset.amount / allocated)
    .sort((a, b) => b - a);

  const top1 = ratios[0] || 0;
  const top3 = ratios.slice(0, 3).reduce((sum, value) => sum + value, 0);

  let riskLabel = "分散";
  let riskScore = 35;
  let report = "目前配置相對分散，仍建議定期檢查市場波動與再平衡。";

  if(top1 >= 0.65){
    riskLabel = "偏高";
    riskScore = 78;
    report = "目前單一幣種占比偏高，配置容易受到單一資產波動影響。建議降低最大持倉比例，或分散至其他主流資產。";
  }else if(top1 >= 0.45){
    riskLabel = "中等";
    riskScore = 58;
    report = "目前配置有一定集中度，但仍在可觀察範圍。建議留意最大持倉幣種的波動與消息風險。";
  }

  if($("riskBadgeMini")) $("riskBadgeMini").textContent = riskLabel;
  if($("kTop1")) $("kTop1").textContent = formatPct(top1 * 100);
  if($("kTop3")) $("kTop3").textContent = formatPct(top3 * 100);
  if($("kVol")) $("kVol").textContent = riskLabel === "偏高" ? "較高" : "中等";
  if($("kMdd")) $("kMdd").textContent = riskLabel === "偏高" ? "需留意" : "可控";
  if($("riskMeterText")) $("riskMeterText").textContent = riskLabel;
  if($("riskBar")) $("riskBar").style.width = riskScore + "%";

  const assetLines = Object.values(portfolioAssets)
    .map((asset) => `・${asset.symbol}：${formatMoney(asset.amount)}（${formatPct((asset.amount / allocated) * 100)}）`)
    .join("\n");

  if($("aiReport")){
    $("aiReport").textContent =
`配置摘要
目前已配置：${formatMoney(allocated)}
最大單一幣種占比：${formatPct(top1 * 100)}
前三大幣種占比：${formatPct(top3 * 100)}

目前配置：
${assetLines}

分析建議：
${report}`;
  }

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
      base_currency: $("capitalCcy")?.value || "TWD",
      days: Number($("days")?.value || 90),
      seed: Number($("seed")?.value || 42),
      holdings: buildHoldingsPayload()
    };

    const [riskRes, aiRes] = await Promise.allSettled([
      fetch("/portfolio/risk-health", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      }),
      fetch("/portfolio/analyze-llm", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      })
    ]);

    let riskPayload = null;
    if(riskRes.status === "fulfilled" && riskRes.value.ok){
      riskPayload = await riskRes.value.json();
      const rh = riskPayload.risk_health || {};

      if($("kTop1")) $("kTop1").textContent = formatPct(Number(rh.top1_weight || top1) * 100);
      if($("kTop3")) $("kTop3").textContent = formatPct(Number(rh.top3_weight || top3) * 100);
      if($("kVol")) $("kVol").textContent = formatPct(Number(rh.annual_vol || 0) * 100);
      if($("kMdd")) $("kMdd").textContent = formatPct(Number(rh.max_drawdown || 0) * 100);

      const apiScore = Math.min(95, Math.round((Number(rh.top1_weight || 0) * 55) + (Number(rh.annual_vol || 0) * 55) + (Number(rh.herfindahl || 0) * 45)));
      if($("riskBar")) $("riskBar").style.width = apiScore + "%";
      if($("riskMeterText")) $("riskMeterText").textContent = apiScore >= 70 ? "偏高" : apiScore >= 45 ? "中等" : "分散";
      if($("riskBadgeMini")) $("riskBadgeMini").textContent = apiScore >= 70 ? "偏高" : apiScore >= 45 ? "中等" : "分散";
    }

    if(aiRes.status === "fulfilled" && aiRes.value.ok){
      const aiPayload = await aiRes.value.json();
      renderAiReport(aiPayload.narrative, aiPayload.highlights, riskPayload?.risk_health);
    }
  }catch(error){
    console.warn("AI health report fallback:", error);
  }finally{
    setAnalyzeLoading(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadPopularCoins();
  renderAssets();

  $("coinPickerBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    $("coinDropdown")?.classList.toggle("show");
  });

  $("coinDropdown")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener("click", () => {
    $("coinDropdown")?.classList.remove("show");
  });

  $("coinSearchInput")?.addEventListener("input", renderCoinOptions);
  $("btnRefreshCoins")?.addEventListener("click", loadPopularCoins);
  $("btnAddAsset")?.addEventListener("click", addAsset);
  $("btnClearAll")?.addEventListener("click", clearAllAssets);
  $("btnAnalyze")?.addEventListener("click", analyzePortfolio);
  $("totalCapital")?.addEventListener("input", renderAssets);


  $("fomoSymbol")?.addEventListener("change", updateFomoChange);
  $("btnFomo")?.addEventListener("click", runFomoCheck);
  $("btnAutoAllocate")?.addEventListener("click", runAutoAllocate);
  $("btnClearHealthRecords")?.addEventListener("click", clearHealthRecords);

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
  const symbol = $("fomoSymbol")?.value || "BTC";
  const input = $("fomoChange");

  if(!input) return;

  input.value = "讀取中...";

  try{
    const res = await fetch("/crypto/popular?vs_currency=usd&per_page=50");

    if(res.ok){
      const data = await res.json();
      const item = Array.isArray(data)
        ? data.find((coin) => String(coin.symbol || "").toUpperCase() === symbol)
        : null;

      const change = Number(
        item?.price_change_percentage_24h ??
        item?.change_24h ??
        item?.change ??
        NaN
      );

      if(Number.isFinite(change)){
        input.value = change.toFixed(2) + "%";
        input.dataset.change = String(change);
        return;
      }
    }
  }catch(error){
    console.warn("FOMO change fallback:", error);
  }

  const fallbackMap = {
    BTC: 2.4,
    ETH: 1.1,
    SOL: 8.6,
    XRP: -0.8,
    BNB: 0.9,
    DOGE: 12.4,
    ADA: 3.2,
    AVAX: 6.8,
    LINK: 4.5,
    DOT: 2.6
  };

  const fallback = fallbackMap[symbol] ?? 2.0;
  input.value = fallback.toFixed(2) + "%";
  input.dataset.change = String(fallback);
}

function runFomoCheck(){
  const symbol = $("fomoSymbol")?.value || "BTC";
  const result = $("fomoResult");
  const raw = Number($("fomoChange")?.dataset.change || 0);

  if(!result) return;

  let level = "low";
  let title = "低度 FOMO";
  let text = `目前 ${symbol} 的短線漲幅不算極端，但仍建議分批進場，避免一次投入造成壓力。`;

  if(raw >= 10){
    level = "high";
    title = "高度 FOMO 風險";
    text = `${symbol} 24H 漲幅已偏高，可能存在追高風險。建議先降低投入比例，等待回落或確認支撐後再評估。`;
  }else if(raw >= 5){
    level = "medium";
    title = "中度 FOMO 風險";
    text = `${symbol} 短線已出現明顯漲幅，若想進場建議分批，並設定可承受的停損或觀察點。`;
  }else if(raw <= -8){
    level = "medium";
    title = "下跌恐慌風險";
    text = `${symbol} 短線跌幅較明顯，請避免因恐慌殺低。可以先觀察是否有止跌訊號。`;
  }

  result.className = `fomo-result show ${level}`;
  result.innerHTML = `<strong>${title}</strong><br>${text}`;
}

function runAutoAllocate(){
  if(!requireHealthMember("AI 自動配置")) return;

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

  plans[risk].forEach(([symbol, name, ratio]) => {
    portfolioAssets[symbol] = {
      symbol,
      name,
      amount: Math.round(total * ratio)
    };
  });

  renderAssets();
  analyzePortfolio();

  const riskNameMap = {
    conservative: "保守型",
    balanced: "穩健型",
    aggressive: "激進型"
  };

  if($("aiReport")){
    $("aiReport").textContent += `\n\nAI 智能一鍵配置已套用：${riskNameMap[risk]}。\n此配置為示範比例，實際投資前仍需依照個人可承受風險調整。`;
  }
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
  localStorage.setItem(getHealthRecordKey(), JSON.stringify(records.slice(0, 8)));
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

  const records = readHealthRecords();
  if(!records.length){
    list.innerHTML = `<div class="member-record-empty">尚未產生紀錄。完成一次健康度檢查後，這裡會自動保存摘要。</div>`;
    return;
  }

  list.innerHTML = records.map((record) => {
    const date = new Date(record.createdAt || Date.now()).toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    const assets = Array.isArray(record.assets) ? record.assets : [];
    const assetText = assets.slice(0, 4)
      .map((asset) => `${escapeHTML(asset.symbol)} ${formatPct(Number(asset.ratio || 0) * 100)}`)
      .join(" · ");

    return `
      <article class="health-record-item">
        <div>
          <span>${date}</span>
          <strong>${escapeHTML(record.riskLabel || "待分析")}</strong>
          <p>${assetText || "未保存配置明細"}</p>
        </div>
        <div class="record-metrics">
          <em>最大占比 ${formatPct(Number(record.top1 || 0) * 100)}</em>
          <em>前三占比 ${formatPct(Number(record.top3 || 0) * 100)}</em>
        </div>
      </article>
    `;
  }).join("");
}

function clearHealthRecords(){
  if(!requireHealthMember("投資健康度紀錄")) return;
  localStorage.removeItem(getHealthRecordKey());
  renderHealthRecords();
}

function handleHealthAuthStateChange(event){
  const nextUserId = String(event?.detail?.userId || getHealthUserId() || "").trim();
  if (nextUserId !== activeHealthUserId) {
    activeHealthUserId = nextUserId;
    resetHealthWorkspace();
  }
  renderHealthRecords();
}
