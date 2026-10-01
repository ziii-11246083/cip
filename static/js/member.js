(function () {
  const USD_TO_TWD = 32;
  const $ = (id) => document.getElementById(id);
  let depositPending = false;
  let authRevision = 0;
  let previewWallet = null;

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

  function isPremiumMember() {
    return window.authManager?.getMembershipTier?.() === "premium";
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
    renderMemberProfile();
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
      capitalList.replaceChildren();
      if (!records.length) {
        appendText(capitalList, "div", "尚未產生資產曲線紀錄。", "member-record-empty");
      }
      records.forEach((item) => {
        const recordId = item.id || item.timestamp || item.ts || "";
        const row = document.createElement("div");
        row.className = "member-list-item";
        const info = document.createElement("div");
        appendText(info, "strong", fmtTwdFromUsd(item.amount_usd || item.total_value_usd));
        appendText(info, "span", item.note || "資金紀錄");
        row.appendChild(info);
        const actions = document.createElement("div");
        actions.className = "member-list-actions";
        appendText(actions, "time", dateText(item.timestamp || item.ts));
        if (isDemo && recordId) {
          const button = appendText(actions, "button", "刪除", "capital-delete-btn");
          button.type = "button";
          button.dataset.capitalId = recordId;
        }
        row.appendChild(actions);
        capitalList.appendChild(row);
      });
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
      ` : '<div class="member-record-empty">目前沒有模擬持倉。你可以在這裡建立，或前往模擬交易頁下單。</div>';
    }
  }

  function renderMemberProfile() {
    const profile = window.authManager?.getProfile?.();
    if ($("memberEmail")) $("memberEmail").textContent = profile?.email || "尚未登入";
    if ($("memberName")) $("memberName").textContent = profile?.displayName || "會員";
    if ($("memberAvatar")) {
      $("memberAvatar").src = `/static/images/agent-cat-${profile?.avatarKey || "happy"}.png`;
    }
    const isTestPremium = Boolean(window.authManager?.isDemoMember?.());
    const premium = isPremiumMember();
    const tier = !isMember() ? "訪客" : isTestPremium ? "進階會員（TEST）" : premium ? "進階會員" : "免費會員";
    if ($("memberCurrentTier")) $("memberCurrentTier").textContent = `目前方案：${tier}`;
    if ($("memberFreeTag")) $("memberFreeTag").hidden = !isMember() || premium;
    if ($("memberPremiumTag")) $("memberPremiumTag").textContent = premium ? "目前方案" : "規劃中";
    $("memberFreePlan")?.classList.toggle("is-current", isMember() && !premium);
    $("memberPremiumPlan")?.classList.toggle("is-current", premium);
    if ($("memberPremiumAction")) {
      $("memberPremiumAction").innerHTML = premium
        ? '查看會員狀態 <i class="fas fa-arrow-right"></i>'
        : '了解訂閱進度 <i class="fas fa-arrow-right"></i>';
    }
    if ($("memberSubscribeLabel")) {
      $("memberSubscribeLabel").textContent = premium ? "查看進階會員權益" : "訂閱進階會員";
    }
    if ($("memberSubscribeHint")) {
      $("memberSubscribeHint").textContent = premium
        ? `${isTestPremium ? "TEST 帳號" : "原有會員"} · 目前方案`
        : "NT$399／月 · 規劃中";
    }
  }

  function openProfileEditor() {
    if (!requireMember()) return;
    const editor = $("profileEditor");
    const profile = window.authManager?.getProfile?.();
    if (!editor || !profile) return;
    if ($("profileDisplayName")) $("profileDisplayName").value = profile.displayName;
    const choice = editor.querySelector(`input[name="avatarKey"][value="${profile.avatarKey}"]`);
    if (choice) choice.checked = true;
    if ($("profileStatus")) $("profileStatus").textContent = "";
    editor.hidden = false;
    $("profileDisplayName")?.focus();
  }

  function closeProfileEditor() {
    if ($("profileEditor")) $("profileEditor").hidden = true;
  }

  function setProfileStatus(message, isError = false) {
    const status = $("profileStatus");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!requireMember()) return;
    const form = $("profileForm");
    const button = $("saveProfileBtn");
    if (!form || button?.disabled) return;
    const avatarKey = form.querySelector('input[name="avatarKey"]:checked')?.value || "happy";
    if (button) button.disabled = true;
    setProfileStatus("儲存中...");
    try {
      await window.authManager.updateProfile({
        displayName: $("profileDisplayName")?.value || "",
        avatarKey,
      });
      renderMemberProfile();
      closeProfileEditor();
      window.toast?.("個人資料", "名稱與頭貼已更新。");
    } catch (error) {
      setProfileStatus(error.message || "儲存失敗，請稍後重試。", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openSubscriptionDialog() {
    const dialog = $("subscriptionDialog");
    if (!dialog) return;
    const tier = !isMember() ? "尚未登入" : window.authManager?.isDemoMember?.() ? "進階會員（TEST，無扣款）" : isPremiumMember() ? "進階會員（原有會員）" : "免費會員（尚無付費訂閱）";
    if ($("subscriptionAccountStatus")) $("subscriptionAccountStatus").textContent = `目前狀態：${tier}`;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeSubscriptionDialog() {
    const dialog = $("subscriptionDialog");
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function setRealAssetAccess(allowed, title, description) {
    if ($("realAssetForm")) $("realAssetForm").hidden = !allowed;
    if ($("realAssetAccess")) $("realAssetAccess").hidden = allowed;
    if ($("realAssetAccessTitle")) $("realAssetAccessTitle").textContent = title;
    if ($("realAssetAccessText")) $("realAssetAccessText").textContent = description;
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
      renderRealAssetMessage("可輸入 Ethereum 公開地址體驗連結流程；目前不讀取真實資產。", "info");
      return;
    }
    renderRealAssetMessage(accounts[0]?.account?.preview ? "已建立錢包連結畫面示範；尚未連接真實服務。" : `已連結 ${accounts.length} 個唯讀錢包。`, "success");
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
      appendText(identity, "span", account.preview ? "連結畫面示範 · 未讀取資產" : "Ethereum Mainnet · Alchemy 唯讀", "real-account-meta");
      head.appendChild(identity);
      const actions = document.createElement("div");
      actions.className = "real-account-actions";
      if (account.status === "active") {
        const sync = appendText(actions, "button", account.preview ? "示範同步" : "立即同步");
        sync.type = "button";
        sync.dataset.assetAction = "sync";
        sync.dataset.accountId = account.id || "";
        const disconnect = appendText(actions, "button", account.preview ? "解除示範連結" : "停止連結", "secondary");
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
      appendText(summary, "span", account.preview ? "展示模式" : snapshot ? `狀態：${snapshot.status}` : "尚無快照");
      appendText(summary, "strong", account.preview ? "未讀取真實資產" : snapshot ? fmtUsd(snapshot.total_value_usd) : "尚未同步");
      appendText(summary, "small", account.preview ? "正式串接前不顯示餘額" : snapshot?.captured_at ? `資料時間：${dateText(snapshot.captured_at)}` : "同步後會顯示 as-of 時間");
      card.appendChild(summary);

      const list = document.createElement("div");
      list.className = "real-balance-list";
      if (!balances.length) {
        appendText(list, "p", account.preview ? "這裡會顯示同步後的資產明細。" : "沒有可顯示的錢包餘額。");
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

  async function refreshRealAssets(headers, revision = authRevision) {
    if (revision !== authRevision) return;
    if (isPremiumMember()) {
      setRealAssetAccess(true, "", "");
      renderRealAssets({ accounts: previewWallet ? [{
        account: { id: "preview", status: "active", preview: true, address_masked: `${previewWallet.slice(0, 6)}…${previewWallet.slice(-4)}` },
        snapshot: null,
        balances: []
      }] : [] });
      return;
    }
    $("realAssetAccounts")?.replaceChildren();
    setRealAssetAccess(false, isMember() ? "目前為免費會員" : "登入後查看使用資格",
      isMember() ? "錢包連結流程示範屬進階會員；你仍可使用模擬交易與基礎 AI 教練。" : "錢包連結流程示範開放給進階會員。");
    renderRealAssetMessage(isMember() ? "免費會員目前沒有錢包連結權限。" : "登入後可查看連結流程示範。", "info");
  }

  async function refreshData() {
    const revision = authRevision;
    const token = await waitForAuthToken();
    if (!token || revision !== authRevision) return;
    const headers = { Authorization: `Bearer ${token}` };
    const [portfolioData, tradeData] = await Promise.all([
      request("/api/sim-trade/portfolio", { headers }),
      request("/api/sim-trade/history?limit=50", { headers })
    ]);
    if (revision !== authRevision) return;
    renderPortfolio(portfolioData.portfolio);
    renderTrades(tradeData.trades || []);
    await refreshRealAssets(headers, revision);
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderMemberProfile();
    $("editProfileBtn")?.addEventListener("click", openProfileEditor);
    document.querySelector(".user-menu-profile-link")?.addEventListener("click", openProfileEditor);
    $("cancelProfileEdit")?.addEventListener("click", closeProfileEditor);
    document.querySelectorAll("[data-profile-cancel]").forEach((button) => {
      button.addEventListener("click", closeProfileEditor);
    });
    $("profileForm")?.addEventListener("submit", saveProfile);
    document.querySelectorAll("[data-subscribe-open]").forEach((button) => {
      button.addEventListener("click", openSubscriptionDialog);
    });
    $("subscriptionClose")?.addEventListener("click", closeSubscriptionDialog);
    $("subscriptionContinueFree")?.addEventListener("click", closeSubscriptionDialog);
    $("subscriptionViewPlan")?.addEventListener("click", closeSubscriptionDialog);
    window.authManager?.whenReady?.().then(() => {
      renderMemberProfile();
      refreshRealAssets();
      if (window.location.hash === "#profileEditor") openProfileEditor();
    });
    refreshData().catch(() => {});

    $("capitalForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (depositPending) return;
      if (!requireMember()) return;
      const amountTwd = Number($("capitalAmount")?.value || 0);
      if (!Number.isFinite(amountTwd) || amountTwd <= 0) return alert("請輸入大於 0 的新增資金。");
      depositPending = true;
      const submitButton = $("capitalForm")?.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;
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
      }).finally(() => {
        depositPending = false;
        if (submitButton) submitButton.disabled = false;
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

    $("realAssetForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireMember()) return;
      if (!isPremiumMember()) return;
      const input = $("realAssetAddress");
      const address = input?.value?.trim() || "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        renderRealAssetMessage("請輸入 0x 開頭、共 42 字元的 Ethereum 公開地址。", "warning");
        return;
      }
      previewWallet = address;
      if (input) input.value = "";
      refreshRealAssets();
    });

    $("realAssetAccounts")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-asset-action]");
      if (!button || button.disabled) return;
      if (!isPremiumMember() || !previewWallet) return;
      const action = button.dataset.assetAction;
      if (action === "sync") {
        renderRealAssetMessage("已點擊示範同步；目前不會讀取或顯示真實資產。", "info");
      } else if (action === "disconnect") {
        previewWallet = null;
        refreshRealAssets();
      }
    });
  });

  window.addEventListener("smartinvest:sim-trade-updated", () => {
    refreshData().catch(() => {});
  });

  window.addEventListener("smartinvest:auth-state", () => {
    authRevision += 1;
    previewWallet = null;
    renderMemberProfile();
    refreshRealAssets();
    if (!isMember()) {
      return;
    }
    refreshData().catch(() => {});
  });
  window.addEventListener("smartinvest:profile-updated", renderMemberProfile);
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#profileEditor") openProfileEditor();
  });
})();
