const radarTools = window.ResearchTools;
let radarCoins = [], radarPending = false;
function radarScoreColor(score) { return score === null ? "muted" : score >= 65 ? "down" : score >= 40 ? "warm" : "up"; }

function renderNarratives(data) {
  const rows = Object.entries(data.narrative_scores || {}).map(([name,raw]) => [name,radarTools.number(raw)])
    .filter(([,value]) => value !== null && value >= 0).sort((a,b) => b[1]-a[1]);
  const [name,count] = rows[0] || ["資料暫缺",null], peak = Math.max(1,count || 0);
  radarTools.text("topNarrative",count > 0 ? name : rows.length ? "暫無焦點題材" : "資料暫缺"); radarTools.text("topScore",count === null ? "--" : count);
  radarTools.text("narrativeCount",rows.length || "--"); radarTools.text("narrativeHits",rows.length ? rows.reduce((sum,[,value]) => sum+value,0) : "--");
  document.getElementById("narrativeList").innerHTML = rows.length ? rows.slice(0,8).map(([label,value],index) =>
    `<div class="tools-heat-row narrative-heat"><span class="tools-rank">${String(index+1).padStart(2,"0")}</span><span class="tools-heat-label"><strong>${radarTools.escape(label)}</strong><span class="tools-bar"><i style="width:${value/peak*100}%;opacity:${index ? .6 : 1}"></i></span></span><strong>${value}<small> 次</small></strong></div>`).join("")
    : '<div class="tools-empty"><i class="fas fa-satellite-dish" aria-hidden="true"></i><strong>敘事資料暫缺</strong><span>請稍後重新取得。</span></div>';
}

function renderRiskRows() {
  const search = document.getElementById("radarCoinSearch").value.trim().toLowerCase(), sort = document.getElementById("radarSort").value;
  const rows = radarCoins.filter(coin => `${coin.symbol || ""} ${coin.cn_name || coin.name || ""}`.toLowerCase().includes(search));
  if (sort !== "rank") rows.sort((a,b) => {
    const first = radarTools.number(a.risk?.score), second = radarTools.number(b.risk?.score);
    if (first === null) return second === null ? 0 : 1; if (second === null) return -1;
    return sort === "high" ? second-first : first-second;
  });
  radarTools.text("radarVisible",`${rows.length} 種幣種`);
  document.getElementById("riskRows").innerHTML = rows.length ? rows.map(coin => {
    const raw = radarTools.number(coin.risk?.score), symbol = String(coin.symbol || "").toUpperCase();
    const benchmark = symbol === "BTC" || coin.risk?.msg === "市場基準";
    const score = benchmark ? null : raw !== null && raw >= 0 && raw <= 100 ? raw : null;
    const change = radarTools.number(coin.change), validSymbol = /^[A-Z0-9]{1,16}$/.test(symbol), tone = radarScoreColor(score);
    const changeTone = change === null || change === 0 ? "muted" : change > 0 ? "up" : "down";
    const changeText = change === null ? "--" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
    return `<tr><td class="tools-table-rank">${radarTools.escape(coin.rank ?? "--")}</td><td><div class="tools-asset"><span>${radarTools.escape(symbol.slice(0,1) || "?")}</span><div><strong>${radarTools.escape(symbol || "--")}</strong><small>${radarTools.escape(coin.cn_name || coin.name || "")}</small><small class="tools-mobile-change ${changeTone}">${changeText} / 24H</small></div></div></td>
      <td><span class="tools-change ${change === null || change === 0 ? "muted" : change > 0 ? "up" : "down"}">${change === null ? "--" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}</span></td>
      <td><div class="tools-risk-score ${tone}"><strong>${benchmark ? "比較基準" : score === null ? "資料不足" : `${score}<small>/100</small>`}</strong>${score === null ? "" : `<span class="tools-bar"><i style="width:${score}%"></i></span>`}</div></td>
      <td>${validSymbol ? `<a class="tools-table-link" href="/analysis/${encodeURIComponent(symbol)}">查看分析 <i class="fas fa-arrow-right" aria-hidden="true"></i></a>` : "--"}</td></tr>`;
  }).join("") : '<tr><td colspan="5"><div class="tools-empty compact"><span>沒有符合的幣種。</span></div></td></tr>';
}

async function loadRadar() {
  if (radarPending) return;
  radarPending = true; document.getElementById("toolsReload").disabled = true; radarTools.text("toolsStatus","整理中");
  const results = await Promise.allSettled([radarTools.json("/api/narratives"),radarTools.json("/api/coingecko")]);
  renderNarratives(results[0].status === "fulfilled" ? results[0].value : {});
  radarCoins = results[1].status === "fulfilled" && Array.isArray(results[1].value.data) ? results[1].value.data.filter(coin => coin && typeof coin === "object") : []; renderRiskRows();
  if (results[1].status === "rejected") document.getElementById("riskRows").innerHTML = '<tr><td colspan="5">風險資料暫不可用，請稍後重試。</td></tr>';
  if (results.every(item => item.status === "rejected")) {
    radarTools.text("toolsStatus","資料暫不可用"); radarTools.text("toolsUpdatedAt","請稍後重新取得");
  } else radarTools.updated(results.every(item => item.status === "fulfilled") ? "已取得資料" : "部分資料暫缺");
  radarPending = false; document.getElementById("toolsReload").disabled = false;
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("toolsReload").addEventListener("click",loadRadar);
  document.getElementById("radarCoinSearch").addEventListener("input",renderRiskRows);
  document.getElementById("radarSort").addEventListener("change",renderRiskRows); loadRadar();
});
