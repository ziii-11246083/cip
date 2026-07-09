function radarScoreColor(score) {
  if (score >= 70) return "var(--bad)";
  if (score >= 40) return "var(--warn)";
  return "var(--good)";
}

async function loadNarratives() {
  const list = document.getElementById("narrativeList");
  const topNarrative = document.getElementById("topNarrative");
  const topScore = document.getElementById("topScore");
  if (!list) return;

  try {
    const res = await fetch("/api/narratives");
    const data = await res.json();
    const scores = data.narrative_scores || {};
    const rows = Object.entries(scores)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 6);

    if (!rows.length) {
      list.innerHTML = '<div class="member-record-empty">目前沒有明顯敘事。</div>';
      if (topNarrative) topNarrative.textContent = "市場盤整";
      if (topScore) topScore.textContent = "0";
      return;
    }

    const [name, score] = rows[0];
    if (topNarrative) topNarrative.textContent = name;
    if (topScore) topScore.textContent = `${score} 分`;

    list.innerHTML = rows.map(([label, value]) => `
      <div class="radar-item">
        <div>
          <strong>${label}</strong>
          <span>${label === name ? "目前最熱" : "可列入觀察"}</span>
        </div>
        <div class="radar-score" style="color:${radarScoreColor(Number(value))}">${value}</div>
      </div>
    `).join("");
  } catch (error) {
    list.innerHTML = '<div class="member-record-empty">敘事資料載入失敗。</div>';
  }
}

async function loadRiskRows() {
  const body = document.getElementById("riskRows");
  if (!body) return;

  try {
    const res = await fetch("/api/coingecko");
    const data = await res.json();
    const rows = (data.data || []).slice(0, 12);

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5">目前沒有可顯示資料。</td></tr>';
      return;
    }

    body.innerHTML = rows.map((coin) => {
      const score = Number(coin.risk?.score || 0);
      const change = Number(coin.change || 0);
      return `
        <tr>
          <td>${coin.rank || "--"}</td>
          <td>${coin.symbol || "--"} <span style="color:var(--muted)">${coin.cn_name || coin.name || ""}</span></td>
          <td style="color:${change >= 0 ? "var(--good)" : "var(--bad)"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</td>
          <td style="color:${radarScoreColor(score)}">${score}/100</td>
          <td><a class="button" href="/analysis/${coin.symbol || "BTC"}">分析</a></td>
        </tr>
      `;
    }).join("");
  } catch (error) {
    body.innerHTML = '<tr><td colspan="5">風險資料載入失敗。</td></tr>';
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadNarratives();
  loadRiskRows();
});
