function scoreTone(score){
  if(score > 65) return "var(--bad)";
  if(score > 40) return "var(--warn)";
  return "var(--good)";
}

async function loadHomeSfiPreview(){
  const tbody = document.getElementById("homeSfiBody");
  if(!tbody) return;

  try{
    const res = await fetch("/api/coingecko");
    const data = await res.json();
    const rows = (data.data || []).slice(0, 6);

    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="5" class="sfi-loading">目前沒有可顯示的風險資料。</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function(coin){
      const risk = coin.risk || {};
      const score = Number(risk.score || 0);
      const change = Number(coin.change || 0);
      const price = Number(coin.price_usd || 0);
      return `
        <tr>
          <td>${coin.rank || "--"}</td>
          <td>
            <div class="sfi-coin">
              <strong>${coin.cn_name || coin.name || coin.symbol || "--"}</strong>
              <span>${coin.symbol || "--"}</span>
            </div>
          </td>
          <td>$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
          <td style="color:${change >= 0 ? "var(--good)" : "var(--bad)"};">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</td>
          <td>
            <div class="sfi-score">
              <div class="sfi-score-head">
                <span style="color:${scoreTone(score)};">${risk.msg || "風險觀察中"}</span>
                <b>${score}/100</b>
              </div>
              <div class="sfi-bar">
                <div class="sfi-bar-fill"></div>
                <div class="sfi-bar-pointer" style="left:${Math.max(0, Math.min(100, score))}%"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }catch(error){
    tbody.innerHTML = '<tr><td colspan="5" class="sfi-loading">風險資料載入失敗，請稍後再試。</td></tr>';
  }
}

document.addEventListener("DOMContentLoaded", loadHomeSfiPreview);
