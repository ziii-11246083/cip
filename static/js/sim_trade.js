(function () {
  const $ = (id) => document.getElementById(id);
  let equityChart = null;
  let allocChart = null;
  let coinOptions = [];
  let currentPortfolio = null;
  let basePortfolio = null;
  let isLocked = false;
  let activeScenario = "normal";
  let initStarted = false;
  const DEFAULT_TIMEOUT_MS = 2600;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_KEYS = {
    portfolio: "si_sim_trade_portfolio_cache_v1",
    trades: "si_sim_trade_trades_cache_v1",
    coins: "si_sim_trade_coins_cache_v1"
  };
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
  const SCENARIO_UI = {
    normal: { label: "一般市場", advice: "正常操作，適合做基本買賣練習。" },
    sideways: { label: "盤整市場", advice: "控制交易頻率，觀察等待成本。" },
    bull: { label: "牛市", advice: "避免追高，分批進出比較穩。" },
    alt_rotation: { label: "山寨輪動", advice: "波動較高，留意單一幣種比例。" },
    bear: { label: "熊市", advice: "降低部位，保留現金緩衝。" },
    black_swan: { label: "黑天鵝", advice: "極端風險，優先檢查最大回撤。" }
  };
  const FALLBACK_SCENARIOS = {
    normal: { label: "一般市場", price_multiplier: 1, volatility_multiplier: 1 },
    sideways: { label: "盤整市場", price_multiplier: 1, volatility_multiplier: 0.6 },
    bull: { label: "牛市", price_multiplier: 1.3, volatility_multiplier: 0.8 },
    alt_rotation: { label: "山寨輪動", price_multiplier: 1.15, volatility_multiplier: 1.8 },
    bear: { label: "熊市", price_multiplier: 0.7, volatility_multiplier: 1.5 },
    black_swan: { label: "黑天鵝", price_multiplier: 0.4, volatility_multiplier: 3 }
  };
  let scenarioData = Object.assign({}, FALLBACK_SCENARIOS);

  function defaultPortfolio() {
    return {
      cash: 100000,
      positions: [],
      total_value_usd: 100000,
      unrealized_pnl: 0,
      pnl_pct: 0,
      equity_curve: [{ timestamp: new Date().toISOString(), total_value_usd: 100000 }],
      capital_records: [],
      scenario: activeScenario
    };
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached?.ts || Date.now() - cached.ts > CACHE_TTL_MS) return null;
      return cached.value || null;
    } catch {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), value }));
    } catch {
      // localStorage can be unavailable in private browsing; the page should still work.
    }
  }

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

  function currentScenarioQuery() {
    return "?scenario=" + encodeURIComponent(activeScenario || "normal");
  }

  function scenarioAdjustedPrice(symbol, basePrice) {
    const sc = scenarioData[activeScenario] || FALLBACK_SCENARIOS[activeScenario] || {};
    const stable = symbol === "USDT" || symbol === "USDC";
    const multiplier = stable ? 1 : Number(sc.price_multiplier || 1);
    return Number(basePrice || 0) * multiplier;
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

  async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function request(url, options) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    try {
      payload = await fetchJson(url, Object.assign({}, options, { headers }));
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("模擬交易資料載入逾時，請稍後再試或重新整理。");
      }
      throw error;
    }
    const { res, data } = payload;
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
    const cachedCoins = readCache(CACHE_KEYS.coins);
    const seedCoins = Array.isArray(cachedCoins) && cachedCoins.length ? cachedCoins : DEFAULT_COINS;
    const bySymbol = new Map(seedCoins.map((coin) => [String(coin.symbol || "").toUpperCase(), coin]));
    try {
      const { res, data } = await fetchJson("/crypto/popular?vs_currency=usd&per_page=20", {}, 1800);
      if (!res.ok) throw new Error("coin list failed");
      const apiCoins = Array.isArray(data) ? data : [];
      apiCoins.forEach((coin) => {
        const symbol = String(coin.symbol || "").toUpperCase();
        if (!symbol) return;
        bySymbol.set(symbol, Object.assign({}, coin, { symbol }));
      });
    } catch {
      setStatus("行情更新較慢，已先使用快取或內建幣種。", "warn");
    }
    coinOptions = Array.from(bySymbol.values());
    writeCache(CACHE_KEYS.coins, coinOptions);

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

  function renderScenarioImpact() {
    const sc = scenarioData[activeScenario] || {};
    const label = SCENARIO_UI[activeScenario]?.label || sc.label || (activeScenario === "normal" ? "一般市場" : activeScenario);
    const totalValue = Number(currentPortfolio?.total_value_usd || 0);
    const cash = Number(currentPortfolio?.cash || 0);
    const cashPct = totalValue ? cash / totalValue * 100 : 0;
    const amount = Number($("orderAmt")?.value || 0);
    const qty = Number($("orderQty")?.value || 0);
    const symbol = String($("orderSymbol")?.value || "BTC").toUpperCase();
    const coin = getSelectedCoin();
    const basePrice = Number(coin.current_price || FALLBACK_PRICES[symbol] || 0);
    const price = scenarioAdjustedPrice(symbol, basePrice);
    const orderValue = amount > 0 ? amount : qty > 0 && price ? qty * price : 0;
    const orderPct = totalValue ? orderValue / totalValue * 100 : 0;
    const vol = Number(sc.volatility_multiplier || 1);
    const priceMult = Number(sc.price_multiplier || 1);

    if ($("scImpactLabel")) $("scImpactLabel").textContent = label;
    if ($("scPortfolioValue")) $("scPortfolioValue").textContent = totalValue ? fmtUSD(totalValue) : "--";
    if ($("scCashBuffer")) $("scCashBuffer").textContent = totalValue ? `${fmtUSD(cash)} (${cashPct.toFixed(1)}%)` : "--";
    if ($("scOrderImpact")) {
      $("scOrderImpact").textContent = orderValue > 0
        ? `${fmtUSD(orderValue)} · ${orderPct.toFixed(1)}% 資產`
        : "請輸入訂單";
    }
    if ($("scRiskNote")) {
      if (activeScenario === "black_swan") {
        $("scRiskNote").textContent = "黑天鵝情境會大幅壓低非穩定幣估值，適合展示極端風險與現金緩衝的重要性。";
      } else if (activeScenario === "bear") {
        $("scRiskNote").textContent = "熊市情境可用來檢查持倉是否過度集中，並評估是否需要降低單筆下單比例。";
      } else if (activeScenario === "alt_rotation") {
        $("scRiskNote").textContent = "山寨輪動情境波動較高，適合比較高風險資產上漲時的追高與回撤風險。";
      } else if (activeScenario === "sideways") {
        $("scRiskNote").textContent = "盤整情境價格不大幅偏移，重點放在資金使用率、交易節奏與等待成本。";
      } else if (priceMult > 1 || vol > 1) {
        $("scRiskNote").textContent = "此情境會放大價格或波動，送單前可先確認現金緩衝與單筆部位比例。";
      } else {
        $("scRiskNote").textContent = "一般市場採用即時價格，適合做正常買賣練習與基本持倉紀錄。";
      }
    }
  }

  function updateQuotePanel() {
    const coin = getSelectedCoin();
    const symbol = String(coin.symbol || "BTC").toUpperCase();
    const basePrice = Number(coin.current_price || FALLBACK_PRICES[symbol] || 0);
    const price = scenarioAdjustedPrice(symbol, basePrice);
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
    renderScenarioImpact();
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

  function scenarioMultiplierFor(symbol) {
    const sc = scenarioData[activeScenario] || FALLBACK_SCENARIOS[activeScenario] || FALLBACK_SCENARIOS.normal;
    const stable = symbol === "USDT" || symbol === "USDC";
    return stable ? 1 : Number(sc.price_multiplier || 1);
  }

  function applyScenarioToPortfolio(snapshot) {
    const source = snapshot || defaultPortfolio();
    const copy = JSON.parse(JSON.stringify(source));
    const cash = Number(copy.cash || 0);
    let total = cash;
    copy.positions = (Array.isArray(copy.positions) ? copy.positions : []).map((pos) => {
      const symbol = String(pos.symbol || "").toUpperCase();
      const qty = Number(pos.quantity || 0);
      const basePrice = Number(pos.base_price || pos.current_price || pos.avg_price || FALLBACK_PRICES[symbol] || 0);
      const currentPrice = basePrice * scenarioMultiplierFor(symbol);
      const marketValue = qty * currentPrice;
      total += marketValue;
      return Object.assign({}, pos, {
        symbol,
        base_price: basePrice,
        current_price: currentPrice,
        market_value: marketValue,
        unrealized_pnl: (currentPrice - Number(pos.avg_price || currentPrice)) * qty
      });
    });

    const initial = Math.max(1, total - Number(copy.unrealized_pnl || 0));
    copy.total_value_usd = total;
    copy.unrealized_pnl = total - (Number(source.total_value_usd || total) - Number(source.unrealized_pnl || 0));
    copy.pnl_pct = copy.unrealized_pnl / initial * 100;
    copy.scenario = activeScenario;
    return copy;
  }

  function renderPortfolio(snapshot) {
    currentPortfolio = applyScenarioToPortfolio(snapshot || basePortfolio || defaultPortfolio());
    updateKpis(currentPortfolio);
    renderPositions(currentPortfolio);
    drawEquity(currentPortfolio);
    drawAlloc(currentPortfolio);
    updateQuotePanel();
  }

  function renderInstantState() {
    coinOptions = readCache(CACHE_KEYS.coins) || DEFAULT_COINS;
    const cachedPortfolio = readCache(CACHE_KEYS.portfolio) || defaultPortfolio();
    const cachedTrades = readCache(CACHE_KEYS.trades) || [];
    basePortfolio = cachedPortfolio;
    renderCoinSelect();
    renderPortfolio(cachedPortfolio);
    renderTrades(cachedTrades);
  }

  function renderCoinSelect() {
    const select = $("orderSymbol");
    if (!select) return;
    const selected = select.value || "BTC";
    select.innerHTML = "";
    coinOptions.forEach((coin) => {
      const symbol = String(coin.symbol || "").toUpperCase();
      if (!symbol) return;
      select.add(new Option(`${symbol} | ${coin.name || symbol}`, symbol));
    });
    if ([...select.options].some((opt) => opt.value === selected)) {
      select.value = selected;
    }
  }

  async function refreshPortfolio({ background = false } = {}) {
    if (!background) setStatus("正在更新帳戶資料...", "");
    const data = await request("/api/sim-trade/portfolio?scenario=normal");
    basePortfolio = data.portfolio || defaultPortfolio();
    writeCache(CACHE_KEYS.portfolio, basePortfolio);
    renderPortfolio(basePortfolio);
  }

  async function refreshTrades({ background = false } = {}) {
    const data = await request("/api/sim-trade/history?limit=50", { headers: {} });
    const trades = Array.isArray(data.trades) ? data.trades : [];
    writeCache(CACHE_KEYS.trades, trades);
    renderTrades(trades);
    if (!background) setStatus("交易紀錄已更新。", "ok");
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
          amount_usd: amountRaw ? Number(amountRaw) : null,
          scenario: activeScenario
        })
      });
      $("orderQty").value = "";
      $("orderAmt").value = "";
      setStatus("委託成功，已更新持倉。", "ok");
      await Promise.allSettled([refreshPortfolio(), refreshTrades({ background: true })]);
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
      await Promise.allSettled([refreshPortfolio(), refreshTrades({ background: true })]);
    } catch (error) {
      setStatus(error.message || "重置失敗", "bad");
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (initStarted) return;
    initStarted = true;
    renderInstantState();
    setStatus("已載入 Demo 交易介面，資料背景更新中...", "ok");

    $("btnDemoAccess")?.addEventListener("click", async function () {
      try {
        if (window.authManager?.loginWithEmail) {
          await window.authManager.loginWithEmail("test@smartinvest.local", "Test123456", { silent: true });
          setLockedState(false);
          setStatus("已切換為 Demo 會員，可立即操作。", "ok");
          refreshPortfolio({ background: true }).catch(() => {});
          refreshTrades({ background: true }).catch(() => {});
        }
      } catch (error) {
        setStatus(error?.message || "Demo 登入失敗，請稍後再試。", "bad");
      }
    });

    $("btnPlaceOrder")?.addEventListener("click", function () {
      if (isLocked) return;
      placeOrder();
    });

    $("btnReload")?.addEventListener("click", async function () {
      if (isLocked) return;
      setStatus("正在重新整理...", "");
      const results = await Promise.allSettled([
        loadCoins(),
        refreshPortfolio(),
        refreshTrades({ background: true })
      ]);
      const failed = results.some((item) => item.status === "rejected");
      setStatus(failed ? "部分資料更新較慢，已保留目前可用資料。" : "資料已更新。", failed ? "warn" : "ok");
    });

    $("btnReset")?.addEventListener("click", function () {
      if (isLocked) return;
      resetPortfolio();
    });

    ["orderSymbol", "orderSide", "orderQty", "orderAmt"].forEach((id) => {
      $(id)?.addEventListener("input", updateQuotePanel);
      $(id)?.addEventListener("change", updateQuotePanel);
    });

    // —— Market Scenario Switcher ——
    async function loadScenarios() {
      try {
        const { res, data } = await fetchJson("/api/market-scenarios", {}, 3000);
        if (!res.ok) return;
        scenarioData = Object.assign({}, FALLBACK_SCENARIOS, data.scenarios || {});
      } catch (e) {
        console.warn("Failed to load market scenarios", e);
        scenarioData = Object.assign({}, FALLBACK_SCENARIOS);
      }
    }

    function applyScenario(scenarioKey) {
      activeScenario = scenarioKey;
      const ui = SCENARIO_UI[scenarioKey] || {};
      const sc = scenarioData[scenarioKey] || { label: "一般市場", price_multiplier: 1.0, volatility_multiplier: 1.0 };
      $("scenarioBadge") && ($("scenarioBadge").textContent = ui.label || sc.label || scenarioKey);
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

      if ($("scAdvice") && ui.advice) $("scAdvice").textContent = ui.advice;
      renderPortfolio(basePortfolio || currentPortfolio || defaultPortfolio());
      console.log("[sim-trade] scenario switched to", scenarioKey, sc);
    }

    document.querySelectorAll(".scenario-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyScenario(btn.dataset.scenario));
    });

    loadScenarios().then(() => applyScenario("normal"));
    // —— End Scenario Switcher ——

    const wantsDemo = new URLSearchParams(window.location.search).get("demo") === "1";
    if (wantsDemo && window.authManager?.loginWithEmail) {
      await window.authManager.loginWithEmail("test@smartinvest.local", "Test123456", { silent: true }).catch(() => null);
    } else {
      await waitForAuthToken(900).catch(() => null);
    }

    const effectiveToken = await getAuthToken();
    if (!effectiveToken) {
      setLockedState(true);
      setStatus("目前是訪客模式，請按上方 Demo 會員體驗即可開始。", "bad");
      return;
    }

    setLockedState(false);
    Promise.allSettled([
      loadCoins(),
      refreshPortfolio({ background: true }),
      refreshTrades({ background: true })
    ]).then((results) => {
      const failed = results.some((item) => item.status === "rejected");
      setStatus(failed ? "部分外部資料較慢，模擬交易仍可使用。" : "模擬交易已就緒。", failed ? "warn" : "ok");
    });
  });

  window.addEventListener("smartinvest:auth-state", (event) => {
    const loggedIn = Boolean(event.detail?.isMember || window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
    setLockedState(!loggedIn);
    if (loggedIn) {
      refreshPortfolio({ background: true }).catch(() => {});
      refreshTrades({ background: true }).catch(() => {});
    }
  });
})();
