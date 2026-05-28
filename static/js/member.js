(function () {
  const USD_TO_TWD = 32;
  const $ = (id) => document.getElementById(id);

  function fmtTwdFromUsd(valueUsd) {
    const value = Number(valueUsd || 0) * USD_TO_TWD;
    return "TWD " + value.toLocaleString("zh-TW", {
      maximumFractionDigits: 0
    });
  }

  function fmtQty(value) {
    return Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8
    });
  }

  function dateText(value) {
    return new Date(value).toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function isMember() {
    return Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
  }

  async function getAuthToken() {
    try {
      return window.authManager ? await window.authManager.getToken() : null;
    } catch {
      return null;
    }
  }

  async function waitForAuthToken(timeoutMs = 1600) {
    const token = await getAuthToken();
    if (token) return token;

    const waitForAuthEvent = new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      window.addEventListener("smartinvest:auth-state", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });

    await waitForAuthEvent;
    return await getAuthToken();
  }

  function requireMember() {
    if (isMember()) return true;
    window.authManager?.requireMember?.("會員中心");
    return false;
  }

  async function request(url, options) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    if (!headers.Authorization) {
      const token = await getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error(data.error || "請先登入會員。");
    }
    if (!res.ok) {
      throw new Error(data.error || data.detail || "請求失敗");
    }
    return data;
  }

  function renderPortfolio(portfolio) {
    if ($("memberEmail")) $("memberEmail").textContent = window.smartInvestMembership?.email || "測試會員";
    if (!portfolio) return;

    const cash = Number(portfolio.cash || 0);
    const totalValue = Number(portfolio.total_value_usd || 0);
    const holdingTotal = Math.max(0, totalValue - cash);
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const equityCurve = Array.isArray(portfolio.equity_curve) ? portfolio.equity_curve : [];

    if ($("kpiCapital")) $("kpiCapital").textContent = fmtTwdFromUsd(totalValue);
    if ($("kpiCapitalCount")) $("kpiCapitalCount").textContent = `${equityCurve.length} 筆資產曲線`;
    if ($("kpiHoldings")) $("kpiHoldings").textContent = fmtTwdFromUsd(holdingTotal);
    if ($("kpiHoldingCount")) $("kpiHoldingCount").textContent = `${positions.length} 種資產`;

    const capitalList = $("capitalList");
    if (capitalList) {
      const points = equityCurve.slice(-8);
      capitalList.innerHTML = points.length ? points.map((item) => `
        <div class="member-list-item">
          <div><strong>${fmtTwdFromUsd(item.total_value_usd)}</strong><span>資產曲線</span></div>
          <time>${dateText(item.timestamp || item.ts)}</time>
        </div>
      `).join("") : '<div class="member-record-empty">尚未產生資產曲線紀錄。</div>';
    }

    const holdingTable = $("holdingTable");
    if (holdingTable) {
      holdingTable.innerHTML = positions.length ? `
        <table>
          <thead><tr><th>幣種</th><th>數量</th><th>市值</th><th>配置比例</th></tr></thead>
          <tbody>
            ${positions.map((item) => {
              const marketValue = Number(item.market_value || 0);
              const pct = totalValue ? marketValue / totalValue * 100 : 0;
              return `<tr><td>${item.symbol}</td><td>${fmtQty(item.quantity)}</td><td>${fmtTwdFromUsd(marketValue)}</td><td>${pct.toFixed(1)}%</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      ` : '<div class="member-record-empty">目前沒有模擬持倉。你可以在這裡建立，或到 AI Agent 用一句話下單。</div>';
    }
  }

  function renderTrades(trades) {
    const orderList = $("orderList");
    if (!orderList) return;
    if (!Array.isArray(trades) || !trades.length) {
      orderList.innerHTML = '<div class="member-record-empty">尚未建立模擬下單。</div>';
      if ($("kpiOrders")) $("kpiOrders").textContent = "0";
      return;
    }

    if ($("kpiOrders")) $("kpiOrders").textContent = trades.length;
    orderList.innerHTML = trades.slice(0, 8).map((order) => `
      <div class="member-list-item">
        <div><strong>${order.side === "buy" ? "買入" : "賣出"} ${order.symbol}</strong><span>${fmtTwdFromUsd(order.amount_usd)} · 約 ${fmtQty(order.quantity)} 顆</span></div>
        <time>${dateText(order.timestamp || order.executed_at)}</time>
      </div>
    `).join("");
  }

  async function refreshData() {
    const token = await waitForAuthToken();
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const [portfolioData, tradeData] = await Promise.all([
      request("/api/sim-trade/portfolio", { headers }),
      request("/api/sim-trade/history?limit=50", { headers })
    ]);
    renderPortfolio(portfolioData.portfolio);
    renderTrades(tradeData.trades || []);
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshData().catch(() => {});

    $("capitalForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      alert("資金與資產以模擬交易帳戶為準，請至模擬交易頁調整。\n\n若需要重新配置，可使用重置功能。 ");
    });

    $("orderForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      const amountTwd = Number($("orderAmount")?.value || 0);
      if (amountTwd <= 0) return alert("請輸入大於 0 的下單金額。");
      const amountUsd = amountTwd / USD_TO_TWD;
      try {
        await request("/api/sim-trade/order", {
          method: "POST",
          body: JSON.stringify({
            symbol: $("orderSymbol")?.value || "BTC",
            side: $("orderSide")?.value || "buy",
            amount_usd: amountUsd
          })
        });
        $("orderAmount").value = "";
        await refreshData();
      } catch (error) {
        alert(error.message || "下單失敗");
      }
    });

    $("clearMemberData")?.addEventListener("click", async () => {
      if (!requireMember()) return;
      if (!confirm("確定要重置模擬帳戶嗎？這將清空持倉與交易紀錄。")) return;
      try {
        await request("/api/sim-trade/reset", { method: "POST", body: "{}" });
        await refreshData();
      } catch (error) {
        alert(error.message || "重置失敗");
      }
    });
  });

  window.addEventListener("smartinvest:sim-trade-updated", () => {
    refreshData().catch(() => {});
  });

  window.addEventListener("smartinvest:auth-state", () => {
    refreshData().catch(() => {});
  });
})();
