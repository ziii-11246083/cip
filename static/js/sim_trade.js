(function () {
  const $ = (id) => document.getElementById(id);
  let equityChart = null;
  let allocChart = null;
  let coinOptions = [];
  let currentPortfolio = null;
  let isLocked = false;
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
  const FALLBACK_PRICES = {
    BTC: 65000,
    ETH: 3200,
    SOL: 150,
    XRP: 0.55,
    BNB: 600,
    DOGE: 0.12,
    USDT: 1,
    USDC: 1
  };

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

  function fmtCompactUSD(value) {
    const n = Number(value || 0);
    if (!n) return "--";
    if (n >= 1_000_000_000_000) return "$" + (n / 1_000_000_000_000).toFixed(2) + "T";
    if (n >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2) + "B";
    if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
    return fmtUSD(n);
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

  async function getAuthToken() {
    try {
      if (window.authManager?.whenReady) {
        await window.authManager.whenReady();
      }
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

    const select = $("orderSymbol");
    if (!select) return;
    select.innerHTML = "";
    coinOptions.forEach((coin) => {
      const symbol = String(coin.symbol || "").toUpperCase();
      if (!symbol) return;
      select.add(new Option(`${symbol} | ${coin.name || symbol}`, symbol));
    });
    updateQuotePanel();
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
    const price = Number(coin.current_price || FALLBACK_PRICES[symbol] || 0);
    const marketCap = Number(coin.market_cap || 0);
    const change24h = Number(coin.price_change_percentage_24h || 0);
    const side = $("orderSide")?.value || "buy";
    const qtyRaw = $("orderQty")?.value.trim();
    const amountRaw = $("orderAmt")?.value.trim();
    const qty = Number(qtyRaw || 0);
    const amount = Number(amountRaw || 0);

    if ($("quoteSymbol")) $("quoteSymbol").textContent = symbol;
    if ($("quoteName")) $("quoteName").textContent = coin.name || symbol;
    if ($("quotePrice")) $("quotePrice").textContent = price ? fmtUSD(price) : "--";
    if ($("quoteChange")) {
      $("quoteChange").textContent = Number.isFinite(change24h)
        ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`
        : "--";
      $("quoteChange").className = change24h >= 0 ? "ok" : "bad";
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

    if (!price) {
      setAdvice("目前沒有可用市價，建議先重新整理行情後再下單。", "warn");
    } else if (side === "buy" && orderAmount > cash) {
      setAdvice(`現金不足，帳戶目前可用現金 ${fmtUSD(cash)}。`, "bad");
    } else if (side === "sell" && orderQty > holdingQty) {
      setAdvice(`持倉不足，目前持有 ${fmtQty(holdingQty)} ${symbol}。`, "bad");
    } else if (side === "sell" && holdingQty <= 0) {
      setAdvice(`目前沒有 ${symbol} 持倉，暫不適合送出賣單。`, "bad");
    } else if (side === "buy" && change24h >= 8) {
      setAdvice(`24 小時漲幅約 +${change24h.toFixed(2)}%，價格偏熱，較適合小額分批。`, "warn");
    } else if (side === "buy" && change24h <= -8) {
      setAdvice(`24 小時跌幅約 ${change24h.toFixed(2)}%，波動偏大，建議降低單筆金額。`, "warn");
    } else if (orderAmount > 0 || orderQty > 0) {
      setAdvice("條件可送出模擬單；仍建議保留部分現金，避免一次投入過多。", "ok");
    } else {
      setAdvice("選好幣種後，可先用 0.1 顆或小額金額試算，再決定是否下單。", "ok");
    }
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
    currentPortfolio = data.portfolio || null;
    updateKpis(data.portfolio);
    renderPositions(data.portfolio);
    drawEquity(data.portfolio);
    drawAlloc(data.portfolio);
    updateQuotePanel();
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
    const token = await waitForAuthToken();
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

    ["orderSymbol", "orderSide", "orderQty", "orderAmt"].forEach((id) => {
      $(id)?.addEventListener("input", updateQuotePanel);
      $(id)?.addEventListener("change", updateQuotePanel);
    });
<<<<<<< HEAD
=======

    // —— Market Scenario Switcher ——
    let activeScenario = "normal";
    let scenarioData = {};

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

    function applyScenario(scenarioKey) {
      activeScenario = scenarioKey;
      const sc = scenarioData[scenarioKey] || { label: "一般市場", price_multiplier: 1.0, volatility_multiplier: 1.0 };
      $("scenarioBadge") && ($("scenarioBadge").textContent = sc.label || scenarioKey);
      $("scPriceMult") && ($("scPriceMult").textContent = (sc.price_multiplier || 1).toFixed(1) + "x");
      $("scVolMult") && ($("scVolMult").textContent = (sc.volatility_multiplier || 1).toFixed(1) + "x");

      const adviceMap = {
        normal: "按照策略正常操作",
        bull: "可提高風險資產佔比，定期獲利了結",
        bear: "提高穩定幣佔比，嚴格執行止損",
        black_swan: "極端風險規避，建議全倉現金為主"
      };
      $("scAdvice") && ($("scAdvice").textContent = adviceMap[scenarioKey] || "正常操作");

      document.querySelectorAll(".scenario-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.scenario === scenarioKey);
      });

      // placeholder: 展示情境資訊，不修改實際交易數據
      console.log("[sim-trade] scenario switched to", scenarioKey, sc);
    }

    document.querySelectorAll(".scenario-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyScenario(btn.dataset.scenario));
    });

    loadScenarios().then(() => applyScenario("normal"));
    // —— End Scenario Switcher ——
>>>>>>> origin/0709
  });
})();
