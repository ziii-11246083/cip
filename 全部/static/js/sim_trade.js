(function () {
  const $ = (id) => document.getElementById(id);
  let equityChart = null;
  let allocChart = null;
  let coinOptions = [];
  let isLocked = false;

  function fmtUSD(value) {
    const n = Number(value || 0);
    return "$" + n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtQty(value) {
    const n = Number(value || 0);
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8
    });
  }

  function setStatus(message, type) {
    const el = $("orderStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "status " + (type || "");
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

  async function loadCoins() {
    try {
      const res = await fetch("/crypto/popular?vs_currency=usd&per_page=20");
      const data = await res.json();
      coinOptions = Array.isArray(data) ? data : [];
    } catch {
      coinOptions = [
        { symbol: "btc", name: "Bitcoin" },
        { symbol: "eth", name: "Ethereum" },
        { symbol: "sol", name: "Solana" },
        { symbol: "xrp", name: "XRP" }
      ];
    }

    const select = $("orderSymbol");
    if (!select) return;
    select.innerHTML = "";
    coinOptions.forEach((coin) => {
      const symbol = String(coin.symbol || "").toUpperCase();
      if (!symbol) return;
      select.add(new Option(`${symbol} | ${coin.name || symbol}`, symbol));
    });
  }

  function updateKpis(snapshot) {
    if (!snapshot) return;
    $("kpiTotal").textContent = fmtUSD(snapshot.total_value_usd);
    $("kpiCash").textContent = fmtUSD(snapshot.cash);
    $("kpiPnl").textContent = fmtUSD(snapshot.unrealized_pnl);

    const pnlPct = Number(snapshot.pnl_pct || 0);
    const pnlPctEl = $("kpiPnlPct");
    pnlPctEl.textContent = (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(2) + "%";
    pnlPctEl.className = "sub " + (pnlPct >= 0 ? "ok" : "bad");
  }

  function renderPositions(snapshot) {
    const body = $("positionsBody");
    if (!body) return;
    const positions = snapshot?.positions || [];

    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="6">目前沒有持倉</td></tr>';
      return;
    }

    body.innerHTML = positions.map((pos) => {
      const pnl = Number(pos.unrealized_pnl || 0);
      return `
        <tr>
          <td>${pos.symbol}</td>
          <td>${fmtQty(pos.quantity)}</td>
          <td>${fmtUSD(pos.avg_price)}</td>
          <td>${fmtUSD(pos.current_price)}</td>
          <td>${fmtUSD(pos.market_value)}</td>
          <td class="${pnl >= 0 ? "ok" : "bad"}">${fmtUSD(pnl)}</td>
        </tr>
      `;
    }).join("");
  }

  function renderTrades(trades) {
    const body = $("tradesBody");
    if (!body) return;

    if (!Array.isArray(trades) || !trades.length) {
      body.innerHTML = '<tr><td colspan="6">目前沒有交易紀錄</td></tr>';
      return;
    }

    body.innerHTML = trades.map((trade) => `
      <tr>
        <td>${trade.timestamp || "--"}</td>
        <td class="${trade.side === "buy" ? "ok" : "bad"}">${String(trade.side || "").toUpperCase()}</td>
        <td>${trade.symbol || "--"}</td>
        <td>${fmtUSD(trade.price)}</td>
        <td>${fmtQty(trade.quantity)}</td>
        <td>${fmtUSD(trade.amount_usd)}</td>
      </tr>
    `).join("");
  }

  function ensureCharts() {
    if (typeof Chart === "undefined") return false;
    return true;
  }

  function drawEquity(snapshot) {
    if (!ensureCharts()) return;
    const canvas = $("equityChart");
    if (!canvas) return;

    const points = Array.isArray(snapshot?.equity_curve) ? snapshot.equity_curve : [];
    const labels = points.map((_, idx) => `${idx + 1}`);
    const values = points.map((item) => Number(item.total_value_usd || 0));

    equityChart?.destroy();
    equityChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: "#F97316",
          backgroundColor: "rgba(249,115,22,.12)",
          fill: true,
          tension: .35,
          borderWidth: 3,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false, grid: { display: false } },
          y: { grid: { color: "rgba(234,210,188,.5)" } }
        }
      }
    });
  }

  function drawAlloc(snapshot) {
    if (!ensureCharts()) return;
    const canvas = $("allocChart");
    if (!canvas) return;

    const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
    const labels = positions.map((pos) => pos.symbol);
    const values = positions.map((pos) => Number(pos.market_value || 0));

    allocChart?.destroy();
    allocChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: labels.length ? labels : ["現金"],
        datasets: [{
          data: labels.length ? values : [Number(snapshot?.cash || 0)],
          backgroundColor: ["#F97316", "#FDBA74", "#FB923C", "#7C9A6D", "#A85522", "#F59E0B"],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { usePointStyle: true, boxWidth: 8, font: { weight: "bold" } }
          }
        }
      }
    });
  }

  async function refreshPortfolio() {
    const data = await request("/api/sim-trade/portfolio");
    updateKpis(data.portfolio);
    renderPositions(data.portfolio);
    drawEquity(data.portfolio);
    drawAlloc(data.portfolio);
  }

  async function refreshTrades() {
    const data = await request("/api/sim-trade/history?limit=50", { headers: {} });
    renderTrades(data.trades);
  }

  async function placeOrder() {
    const symbol = $("orderSymbol")?.value || "BTC";
    const side = $("orderSide")?.value || "buy";
    const quantityRaw = $("orderQty")?.value.trim();
    const amountRaw = $("orderAmt")?.value.trim();

    if (!quantityRaw && !amountRaw) {
      setStatus("請至少填入數量或金額。", "bad");
      return;
    }

    try {
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
    } catch (error) {
      setStatus(error.message || "下單失敗", "bad");
    }
  }

  async function resetPortfolio() {
    try {
      setStatus("帳戶重置中...", "");
      await request("/api/sim-trade/reset", {
        method: "POST",
        body: JSON.stringify({})
      });
      setStatus("模擬帳戶已重置。", "ok");
      await Promise.all([refreshPortfolio(), refreshTrades()]);
    } catch (error) {
      setStatus(error.message || "重置失敗", "bad");
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
    if (!token) {
      setLockedState(true);
      setStatus("目前是訪客模式，請先登入會員。", "bad");
      return;
    }

    try {
      await loadCoins();
      await Promise.all([refreshPortfolio(), refreshTrades()]);
      setLockedState(false);
    } catch (error) {
      setStatus(error.message || "請先登入會員。", "bad");
    }

    $("btnPlaceOrder")?.addEventListener("click", function () {
      if (isLocked) return;
      placeOrder();
    });

    $("btnReload")?.addEventListener("click", async function () {
      if (isLocked) return;
      setStatus("正在重新整理...", "");
      await Promise.all([refreshPortfolio(), refreshTrades()]);
      setStatus("資料已更新。", "ok");
    });

    $("btnReset")?.addEventListener("click", function () {
      if (isLocked) return;
      resetPortfolio();
    });
  });
})();
