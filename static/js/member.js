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
      const error = new Error(data.error || data.detail || "請求失敗");
      error.code = data.code || "request_failed";
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function renderPortfolio(portfolio) {
    if ($("memberEmail")) $("memberEmail").textContent = window.smartInvestMembership?.email || "測試會員";
    if (!portfolio) return;
    const isDemo = Boolean(window.authManager?.isDemoMember?.());

    const cash = Number(portfolio.cash || 0);
    const totalValue = Number(portfolio.total_value_usd || 0);
    const holdingTotal = Math.max(0, totalValue - cash);
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const equityCurve = Array.isArray(portfolio.equity_curve) ? portfolio.equity_curve : [];
    const capitalRecords = Array.isArray(portfolio.capital_records) ? portfolio.capital_records : [];

    if ($("kpiCapital")) $("kpiCapital").textContent = fmtTwdFromUsd(totalValue);
    if ($("kpiCapitalCount")) $("kpiCapitalCount").textContent = `${capitalRecords.length || equityCurve.length} 筆資金紀錄`;
    if ($("kpiHoldings")) $("kpiHoldings").textContent = fmtTwdFromUsd(holdingTotal);
    if ($("kpiHoldingCount")) $("kpiHoldingCount").textContent = `${positions.length} 種資產`;

    const capitalList = $("capitalList");
    if (capitalList) {
      const records = capitalRecords.length ? capitalRecords.slice(0, 8) : equityCurve.slice(-8).reverse();
      capitalList.innerHTML = records.length ? records.map((item) => {
        const recordId = item.id || item.timestamp || item.ts || "";
        return `
        <div class="member-list-item">
          <div><strong>${fmtTwdFromUsd(item.amount_usd || item.total_value_usd)}</strong><span>${item.note || "資金紀錄"}</span></div>
          <div class="member-list-actions">
            <time>${dateText(item.timestamp || item.ts)}</time>
            ${isDemo && recordId ? `<button class="capital-delete-btn" type="button" data-capital-id="${recordId}">刪除</button>` : ""}
          </div>
        </div>
      `;
      }).join("") : '<div class="member-record-empty">尚未產生資產曲線紀錄。</div>';
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

  function appendText(parent, tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function fmtUsd(value) {
    if (value === null || value === undefined || value === "") return "價格未取得";
    const number = Number(value);
    if (!Number.isFinite(number)) return "價格未取得";
    return "USD " + number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function renderRealAssetMessage(message, kind) {
    const status = $("realAssetStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "info";
  }

  function renderRealAssets(portfolio) {
    const root = $("realAssetAccounts");
    if (!root) return;
    root.replaceChildren();
    const accounts = Array.isArray(portfolio?.accounts) ? portfolio.accounts : [];
    if (!accounts.length) {
      renderRealAssetMessage("尚未連結錢包。只輸入公開地址即可，不要輸入任何密鑰。", "info");
      return;
    }
    renderRealAssetMessage(`已連結 ${accounts.length} 個唯讀錢包。`, "success");
    accounts.forEach((group) => {
      const account = group?.account || {};
      const snapshot = group?.snapshot || null;
      const balances = Array.isArray(group?.balances) ? group.balances : [];
      const card = document.createElement("article");
      card.className = "real-account";
      const head = document.createElement("div");
      head.className = "real-account-head";
      const identity = document.createElement("div");
      appendText(identity, "strong", account.address_masked || "Ethereum 錢包");
      appendText(identity, "span", "Ethereum Mainnet · Alchemy 唯讀", "real-account-meta");
      head.appendChild(identity);
      const actions = document.createElement("div");
      actions.className = "real-account-actions";
      if (account.status === "active") {
        const sync = appendText(actions, "button", "立即同步");
        sync.type = "button";
        sync.dataset.assetAction = "sync";
        sync.dataset.accountId = account.id || "";
        const disconnect = appendText(actions, "button", "停止連結", "secondary");
        disconnect.type = "button";
        disconnect.dataset.assetAction = "disconnect";
        disconnect.dataset.accountId = account.id || "";
      } else {
        appendText(actions, "span", "已停止", "real-disconnected");
      }
      head.appendChild(actions);
      card.appendChild(head);

      const summary = document.createElement("div");
      summary.className = "real-account-summary";
      appendText(summary, "span", snapshot ? `狀態：${snapshot.status}` : "尚無快照");
      appendText(summary, "strong", snapshot ? fmtUsd(snapshot.total_value_usd) : "尚未同步");
      appendText(summary, "small", snapshot?.captured_at ? `資料時間：${dateText(snapshot.captured_at)}` : "同步後會顯示 as-of 時間");
      card.appendChild(summary);

      const list = document.createElement("div");
      list.className = "real-balance-list";
      if (!balances.length) {
        appendText(list, "p", "沒有可顯示的錢包餘額。");
      } else {
        balances.forEach((item) => {
          const row = document.createElement("div");
          appendText(row, "strong", item.symbol || "Unknown");
          appendText(row, "span", `${fmtQty(item.quantity)} · ${fmtUsd(item.value_usd)}`);
          const price = item.price_usd === null || item.price_usd === undefined
            ? "無 USD 價格，僅顯示數量"
            : `單價 ${fmtUsd(item.price_usd)} · ${item.price_source || "來源未知"} · ${item.price_as_of ? dateText(item.price_as_of) : "時間未知"}`;
          appendText(row, "small", price);
          list.appendChild(row);
        });
      }
      card.appendChild(list);
      root.appendChild(card);
    });
  }

  async function refreshRealAssets(headers) {
    try {
      const data = await request("/api/asset-sync/portfolio", { headers });
      renderRealAssets(data.portfolio);
    } catch (error) {
      const root = $("realAssetAccounts");
      if (root) root.replaceChildren();
      renderRealAssetMessage(error.message || "真實資產暫時無法讀取。", "warning");
    }
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
    await refreshRealAssets(headers);
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshData().catch(() => {});

    $("capitalForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      const amountTwd = Number($("capitalAmount")?.value || 0);
      if (amountTwd <= 0) return alert("請輸入大於 0 的新增資金。");
      request("/api/sim-trade/deposit", {
        method: "POST",
        body: JSON.stringify({
          amount_twd: amountTwd,
          note: $("capitalNote")?.value || ""
        })
      }).then(() => {
        $("capitalAmount").value = "";
        $("capitalNote").value = "";
        return refreshData();
      }).catch((error) => {
        alert(error.message || "新增資金失敗");
      });
    });

    $("capitalList")?.addEventListener("click", async (event) => {
      const btn = event.target.closest(".capital-delete-btn");
      if (!btn) return;
      if (!window.authManager?.isDemoMember?.()) {
        alert("只有 Demo 帳號可以刪除資金紀錄。");
        return;
      }
      const recordId = btn.dataset.capitalId || "";
      if (!recordId) return;
      if (!confirm("確定刪除此筆資金紀錄？帳戶現金會同步扣回。")) return;
      try {
        await request(`/api/sim-trade/capital/${encodeURIComponent(recordId)}`, {
          method: "DELETE"
        });
        await refreshData();
      } catch (error) {
        alert(error.message || "刪除資金失敗");
      }
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

    $("realAssetForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      const input = $("realAssetAddress");
      const address = input?.value?.trim() || "";
      renderRealAssetMessage("正在建立唯讀連結…", "info");
      try {
        await request("/api/asset-sync/accounts", {
          method: "POST",
          body: JSON.stringify({ public_address: address })
        });
        if (input) input.value = "";
        const token = await getAuthToken();
        await refreshRealAssets({ Authorization: `Bearer ${token}` });
      } catch (error) {
        renderRealAssetMessage(error.message || "錢包連結失敗。", "warning");
      }
    });

    $("realAssetAccounts")?.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-asset-action]");
      if (!button || button.disabled) return;
      const accountId = button.dataset.accountId || "";
      const action = button.dataset.assetAction;
      if (!accountId) return;
      if (action === "disconnect" && !confirm("停止後將不再同步，已有快照會保留並顯示時間。確定繼續？")) return;
      button.disabled = true;
      renderRealAssetMessage(action === "sync" ? "正在唯讀同步…" : "正在停止連結…", "info");
      try {
        await request(`/api/asset-sync/accounts/${encodeURIComponent(accountId)}${action === "sync" ? "/sync" : ""}`, {
          method: action === "sync" ? "POST" : "DELETE",
          body: action === "sync" ? "{}" : undefined
        });
        const token = await getAuthToken();
        await refreshRealAssets({ Authorization: `Bearer ${token}` });
      } catch (error) {
        renderRealAssetMessage(error.message || "操作失敗。", "warning");
        button.disabled = false;
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
