let sfiChart = null, copulaChart = null, mcChart = null, analysisPending = false;
function $(id) { return document.getElementById(id); }
function setText(id,text) { const element = $(id); if (element) element.textContent = text; }
function setStatus(text) { setText("toolsStatus",text); }
function setEmpty(id,message,show) { const element = $(id); if (element) {element.textContent = message || ""; element.classList.toggle("is-hidden",!show);} }
function finiteNumber(value) {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function percentLabel(value) { const number = finiteNumber(value); return number === null ? "--" : `${(number*100).toFixed(2)}%`; }
function moneyLabel(value) { const number = finiteNumber(value); return number === null ? "--" : `USD ${number.toLocaleString("zh-TW",{maximumFractionDigits:2})}`; }
function chartUnavailable() { return typeof Chart === "undefined"; }
function validSfi(item) { const score = finiteNumber(item?.score); return item?.symbol && score !== null && score >= 0 && score <= 100; }
function displayRisk(risk,payload) {
  const peers = (Array.isArray(payload.benchmark_sfi) ? payload.benchmark_sfi : []).filter(validSfi);
  return risk.msg === "市場基準" ? peers.find(item => item.symbol === payload.comparison_symbol) || peers[0] || null : risk;
}
function researchChartOptions() {
  return {responsive:true,maintainAspectRatio:false,animation:!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    plugins:{legend:{display:false},tooltip:{backgroundColor:"#594333",padding:11,cornerRadius:9}},
    scales:{x:{grid:{color:"#f1e7db"},border:{display:false},ticks:{color:"#a2876c",font:{size:11},maxRotation:0,maxTicksLimit:6}},
      y:{grid:{color:"#f1e7db"},border:{display:false},ticks:{color:"#a2876c",font:{size:11},maxTicksLimit:5}}}};
}

function drawSfiChart(riskData,payload = {}) {
  const canvas = $("sfiRiskChart"); if (!canvas) return;
  sfiChart?.destroy(); sfiChart = null; canvas.hidden = true;
  const benchmark = riskData.msg === "市場基準", risk = displayRisk(riskData,payload), score = finiteNumber(risk?.score);
  const subject = benchmark ? risk?.symbol : String(window.__ANALYSIS_SYMBOL__ || "BTC");
  setText("sfiDescription",benchmark ? "BTC 是比較基準；下方比較其他幣種相對 BTC 的 SFI。" : `${subject} 相對 BTC 的 SFI 分數。`);
  setText("sfiCorrValue",finiteNumber(risk?.corr)?.toFixed(2) ?? "--");
  setText("sfiBetaValue",finiteNumber(risk?.beta) === null ? "--" : `${Number(risk.beta).toFixed(2)}×`);
  setText("sfiTailValue",finiteNumber(risk?.lambda)?.toFixed(2) ?? "--");
  if (score === null || score < 0 || score > 100 || (!benchmark && riskData.level === "base")) {
    setText("sfiScoreLabel","資料不足"); setEmpty("sfiChartEmpty","目前沒有足夠歷史資料可計算 SFI。",true); return;
  }
  setText("sfiScoreLabel",`${benchmark ? `${subject} ` : ""}${score}/100`);
  if (chartUnavailable()) {setEmpty("sfiChartEmpty","圖表服務暫不可用；上方數值仍可閱讀。",true); return;}
  const peers = benchmark ? payload.benchmark_sfi.filter(validSfi).slice(0,6) : [{symbol:subject,score}];
  const options = researchChartOptions(); options.indexAxis = "y";
  options.scales.x.min = 0; options.scales.x.max = 100; options.scales.y.grid.display = false;
  options.plugins.tooltip.callbacks = {label: context => `SFI ${context.raw}/100`};
  setEmpty("sfiChartEmpty","",false); canvas.hidden = false;
  canvas.setAttribute?.("aria-label",`SFI 分數比較：${peers.map(item => `${item.symbol} ${item.score}/100`).join("、")}`);
  sfiChart = new Chart(canvas,{type:"bar",data:{labels:peers.map(item => item.symbol),datasets:[{label:"SFI 分數",
    data:peers.map(item => Number(item.score)),backgroundColor:peers.map(item => item.score >= 65 ? "#c45b4c" : item.score >= 40 ? "#e1ab62" : "#5c9681"),borderRadius:7,maxBarThickness:26}]},options});
}

function drawCopulaChart(payload,symbol) {
  const canvas = $("copulaChart"); if (!canvas) return;
  copulaChart?.destroy(); copulaChart = null; canvas.hidden = true;
  const comparison = symbol === "BTC" ? payload.comparison_symbol : symbol;
  setText("corrDescription",comparison && comparison !== "BTC" ? `${comparison} 與 BTC 的同期報酬；每個點是一組配對資料。` : "等待其他幣種的同期報酬資料。");
  const btcReturns = Array.isArray(payload.btc_returns) ? payload.btc_returns : [], coinReturns = Array.isArray(payload.coin_returns) ? payload.coin_returns : [];
  const points = btcReturns.map((value,index) => ({x:finiteNumber(value),y:finiteNumber(coinReturns[index])})).filter(point => point.x !== null && point.y !== null);
  const corr = finiteNumber(symbol === "BTC" ? payload.comparison_corr : payload.risk_data?.corr);
  setText("corrLabel",corr === null ? "資料不足" : `corr ${corr.toFixed(2)}`); setText("analysisCorr",corr === null ? "--" : corr.toFixed(2));
  if (points.length < 3 || !comparison || (symbol === "BTC" && comparison === "BTC")) {setEmpty("copulaChartEmpty","目前沒有足夠的同期報酬可比較。",true); return;}
  if (chartUnavailable()) {setEmpty("copulaChartEmpty","圖表服務暫不可用。",true); return;}
  const options = researchChartOptions();
  options.scales.x.title = {display:true,text:"BTC 同期報酬",color:"#947a62"}; options.scales.y.title = {display:true,text:`${comparison} 同期報酬`,color:"#947a62"};
  for (const axis of [options.scales.x,options.scales.y]) axis.ticks.callback = value => `${(value*100).toFixed(1)}%`;
  options.plugins.tooltip.callbacks = {label: context => `BTC ${percentLabel(context.parsed.x)} · ${comparison} ${percentLabel(context.parsed.y)}`};
  setEmpty("copulaChartEmpty","",false); canvas.hidden = false;
  copulaChart = new Chart(canvas,{type:"scatter",data:{datasets:[{label:`${comparison} vs BTC`,data:points,pointRadius:3,pointHoverRadius:5,borderColor:"#c98249",backgroundColor:"#e4a46d8c"}]},options});
}

function drawMcChart(payload) {
  const canvas = $("mcChart"); if (!canvas) return;
  mcChart?.destroy(); mcChart = null; canvas.hidden = true;
  const simulation = payload.simulation || {};
  const pricePoint = value => {const number = finiteNumber(value); return number !== null && number >= 0 ? number : null;};
  const mean = (Array.isArray(simulation.mean_path) ? simulation.mean_path : []).map(pricePoint);
  const start = finiteNumber(simulation.current_price) ?? mean[0] ?? null, lower = finiteNumber(simulation.var_95);
  setText("mcLabel",moneyLabel(lower)); setText("mcStart",moneyLabel(start)); setText("mcEnd",moneyLabel(mean.at(-1)));
  setText("analysisDays",mean.length > 1 ? `${mean.length-1} 天` : "--");
  if (mean.filter(value => value !== null).length < 2) {setEmpty("mcChartEmpty","目前沒有足夠價格資料可產生模型情境。",true); return;}
  if (chartUnavailable()) {setEmpty("mcChartEmpty","圖表服務暫不可用；模型數值仍可閱讀。",true); return;}
  const paths = (Array.isArray(simulation.paths) ? simulation.paths : []).filter(Array.isArray).slice(0,12);
  const datasets = paths.map((path,index) => ({label:`樣本路徑 ${index+1}`,data:path.slice(0,mean.length).map(pricePoint),borderColor:"#d6bda373",borderWidth:1,pointRadius:0,tension:.1,spanGaps:false}));
  datasets.push({label:"平均路徑",data:mean,borderColor:"#ed873f",borderWidth:3,pointRadius:0,tension:.1,spanGaps:false});
  if (start !== null) datasets.push({label:"起點價格",data:mean.map(() => start),borderColor:"#778d82",borderDash:[5,5],borderWidth:1.5,pointRadius:0});
  const options = researchChartOptions(); options.scales.x.grid.display = false;
  options.scales.y.ticks.callback = moneyLabel;
  options.plugins.legend = {display:true,position:"bottom",labels:{boxWidth:15,boxHeight:2,color:"#9b8066",filter:item => ["平均路徑","起點價格"].includes(item.text)}};
  options.plugins.tooltip.callbacks = {label:context => `${context.dataset.label} · ${moneyLabel(context.parsed.y)}`};
  setEmpty("mcChartEmpty","",false); canvas.hidden = false;
  mcChart = new Chart(canvas,{type:"line",data:{labels:mean.map((_,index) => index ? `第 ${index} 天` : "起點"),datasets},options});
}

function setInsights(payload,symbol) {
  const risk = displayRisk(payload.risk_data || {},payload), score = finiteNumber(risk?.score);
  setText("analysisComparison",symbol === "BTC" ? payload.comparison_symbol || "資料不足" : `${symbol} / BTC`);
  setText("ai-sfi-insight",score === null ? "資料不足不等於零風險。" : `${symbol === "BTC" ? `BTC 不列自身分數，本次以 ${risk.symbol} 為比較對象。` : ""}SFI 衡量歷史下跌連動；低分不代表安全。Beta 與連動係數保留原始單位。`);
  const corr = finiteNumber(symbol === "BTC" ? payload.comparison_corr : payload.risk_data?.corr);
  setText("ai-copula-insight",corr === null ? "目前無法判斷歷史連動。" : `相關係數 ${corr.toFixed(2)}，範圍為 −1 到 +1。相關性不代表兩者漲跌幅相同，也不保證未來仍會維持。`);
  const days = Array.isArray(payload.simulation?.mean_path) ? payload.simulation.mean_path.length-1 : 0;
  setText("ai-mc-insight",days > 0 ? `這是 ${days} 天的模型假設路徑；平均線與期末分位數都不是價格預測。模型結果未包含交易成本與滑價。` : "歷史資料不足時，不產生價格路徑或補上虛構結果。");
}

function clearAnalysis() {
  [sfiChart,copulaChart,mcChart].forEach(chart => chart?.destroy()); sfiChart = copulaChart = mcChart = null;
  ["sfiRiskChart","copulaChart","mcChart"].forEach(id => {if ($(id)) $(id).hidden = true;});
  ["sfiScoreLabel","sfiCorrValue","sfiBetaValue","sfiTailValue","corrLabel","mcLabel","mcStart","mcEnd","analysisComparison","analysisCorr","analysisDays"].forEach(id => setText(id,"--"));
}
async function loadAnalysis() {
  if (analysisPending) return;
  analysisPending = true; const button = $("toolsReload"); if (button) button.disabled = true;
  const symbol = String(window.__ANALYSIS_SYMBOL__ || "BTC").trim().toUpperCase() || "BTC";
  clearAnalysis(); setStatus("載入中");
  [["sfiChartEmpty","正在取得 SFI 資料…"],["copulaChartEmpty","正在取得報酬資料…"],["mcChartEmpty","正在取得模型資料…"]].forEach(([id,message]) => setEmpty(id,message,true));
  try {
    const response = await fetch(`/api/details/${encodeURIComponent(symbol)}`,{cache:"no-store"});
    if (!response.ok) throw new Error("Data unavailable"); const payload = await response.json(); if (payload.error) throw new Error("Data unavailable");
    drawSfiChart(payload.risk_data || {},payload); drawCopulaChart(payload,symbol); drawMcChart(payload); setInsights(payload,symbol);
    window.ResearchTools?.updated("已取得資料");
  } catch {
    clearAnalysis(); setStatus("資料暫不可用"); setText("toolsUpdatedAt","請稍後重新取得");
    ["sfiChartEmpty","copulaChartEmpty","mcChartEmpty"].forEach(id => setEmpty(id,"資料暫缺，請稍後按更新資料重試。",true));
    ["ai-sfi-insight","ai-copula-insight","ai-mc-insight"].forEach(id => setText(id,"本次未取得完整資料。"));
  } finally {analysisPending = false; if (button) button.disabled = false;}
}
window.addEventListener("DOMContentLoaded", () => {
  $("toolsReload")?.addEventListener("click",loadAnalysis);
  const symbol = String(window.__ANALYSIS_SYMBOL__ || "BTC").toUpperCase(), select = $("analysisSymbol");
  if (select) {
    if (/^[A-Z0-9]{1,16}$/.test(symbol) && !Array.from(select.options).some(option => option.value === symbol)) select.add(new Option(symbol,symbol));
    select.value = symbol; select.addEventListener("change", () => {window.location.href = `/analysis/${encodeURIComponent(select.value)}`;});
  }
  loadAnalysis();
});
