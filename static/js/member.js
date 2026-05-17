(function () {
  const STORAGE = {
    capital: "smartinvest_member_capital_records",
    orders: "smartinvest_member_mock_orders",
    holdings: "smartinvest_member_mock_holdings"
  };

  const coinPricesTwd = {
    BTC: 3200000,
    ETH: 160000,
    SOL: 7200,
    XRP: 28,
    BNB: 28500,
    DOGE: 5.2,
    USDT: 32,
    USDC: 32
  };

  const $ = (id) => document.getElementById(id);

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function fmt(value) {
    return "TWD " + Number(value || 0).toLocaleString("zh-TW", {
      maximumFractionDigits: 0
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

  function requireMember() {
    if (isMember()) return true;
    window.authManager?.requireMember?.("會員中心");
    return false;
  }

  function saveOrder(side, symbol, amount) {
    const price = coinPricesTwd[symbol] || 100;
    const quantity = amount / price;
    const orders = readJson(STORAGE.orders, []);
    const holdings = readJson(STORAGE.holdings, {});
    const current = holdings[symbol] || { symbol, quantity: 0, amount: 0 };

    if (side === "buy") {
      current.quantity += quantity;
      current.amount += amount;
    } else {
      current.quantity = Math.max(0, current.quantity - quantity);
      current.amount = Math.max(0, current.amount - amount);
    }

    if (current.amount <= 0 || current.quantity <= 0) {
      delete holdings[symbol];
    } else {
      holdings[symbol] = current;
    }

    orders.unshift({
      id: `manual-${Date.now()}`,
      time: new Date().toISOString(),
      side,
      symbol,
      amount,
      price,
      quantity
    });

    writeJson(STORAGE.orders, orders.slice(0, 30));
    writeJson(STORAGE.holdings, holdings);
  }

  function render() {
    const capital = readJson(STORAGE.capital, []);
    const orders = readJson(STORAGE.orders, []);
    const holdings = readJson(STORAGE.holdings, {});
    const capitalTotal = capital.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const holdingEntries = Object.values(holdings);
    const holdingTotal = holdingEntries.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    if ($("memberEmail")) $("memberEmail").textContent = window.smartInvestMembership?.email || "測試會員";
    if ($("kpiCapital")) $("kpiCapital").textContent = fmt(capitalTotal);
    if ($("kpiCapitalCount")) $("kpiCapitalCount").textContent = `${capital.length} 筆資金紀錄`;
    if ($("kpiHoldings")) $("kpiHoldings").textContent = fmt(holdingTotal);
    if ($("kpiHoldingCount")) $("kpiHoldingCount").textContent = `${holdingEntries.length} 種資產`;
    if ($("kpiOrders")) $("kpiOrders").textContent = orders.length;

    const capitalList = $("capitalList");
    if (capitalList) {
      capitalList.innerHTML = capital.length ? capital.map((item) => `
        <div class="member-list-item">
          <div><strong>${fmt(item.amount)}</strong><span>${item.note || "資金投放"}</span></div>
          <time>${dateText(item.time)}</time>
        </div>
      `).join("") : '<div class="member-record-empty">尚未新增資金投放。</div>';
    }

    const orderList = $("orderList");
    if (orderList) {
      orderList.innerHTML = orders.length ? orders.slice(0, 8).map((order) => `
        <div class="member-list-item">
          <div><strong>${order.side === "buy" ? "買入" : "賣出"} ${order.symbol}</strong><span>${fmt(order.amount)} · 約 ${Number(order.quantity || 0).toFixed(6)} 顆</span></div>
          <time>${dateText(order.time)}</time>
        </div>
      `).join("") : '<div class="member-record-empty">尚未建立模擬下單。</div>';
    }

    const holdingTable = $("holdingTable");
    if (holdingTable) {
      holdingTable.innerHTML = holdingEntries.length ? `
        <table>
          <thead><tr><th>幣種</th><th>數量</th><th>投入金額</th><th>配置比例</th></tr></thead>
          <tbody>
            ${holdingEntries.map((item) => {
              const pct = holdingTotal ? Number(item.amount || 0) / holdingTotal * 100 : 0;
              return `<tr><td>${item.symbol}</td><td>${Number(item.quantity || 0).toFixed(6)}</td><td>${fmt(item.amount)}</td><td>${pct.toFixed(1)}%</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      ` : '<div class="member-record-empty">目前沒有模擬持倉。你可以在這裡建立，或到 AI Agent 用一句話下單。</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    render();

    $("capitalForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      const amount = Number($("capitalAmount")?.value || 0);
      if (amount <= 0) return alert("請輸入大於 0 的金額。");
      const capital = readJson(STORAGE.capital, []);
      capital.unshift({
        id: `capital-${Date.now()}`,
        time: new Date().toISOString(),
        amount,
        note: $("capitalNote")?.value.trim() || "資金投放"
      });
      writeJson(STORAGE.capital, capital.slice(0, 30));
      $("capitalAmount").value = "";
      $("capitalNote").value = "";
      render();
    });

    $("orderForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      const amount = Number($("orderAmount")?.value || 0);
      if (amount <= 0) return alert("請輸入大於 0 的下單金額。");
      saveOrder($("orderSide")?.value || "buy", $("orderSymbol")?.value || "BTC", amount);
      $("orderAmount").value = "";
      render();
    });

    $("clearMemberData")?.addEventListener("click", () => {
      if (!requireMember()) return;
      if (!confirm("確定要清除會員中心的前端模擬紀錄嗎？")) return;
      Object.values(STORAGE).forEach((key) => localStorage.removeItem(key));
      render();
    });
  });
})();
