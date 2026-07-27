(function () {
  const USD_TO_TWD = 32;
  const ADMIN_EMAIL = "admin@smartinvest.local";
  const $ = (id) => document.getElementById(id);
  const DEFAULT_MEMBERSHIP_PLANS = [
    {
      plan_code: "free",
      plan_name: "免費版",
      monthly_price_usd: 0,
      features_json: { ai_chat_daily_limit: 5 }
    },
    {
      plan_code: "pro",
      plan_name: "進階版",
      monthly_price_usd: 9.99,
      features_json: { ai_chat_daily_limit: 20 }
    },
    {
      plan_code: "premium",
      plan_name: "專業版",
      monthly_price_usd: 24.99,
      features_json: { ai_chat_daily_limit: null }
    }
  ];
  let authRefreshTimer = null;
  let membershipRefreshInFlight = null;
  let dataRefreshInFlight = null;

  async function fetchJson(url, options = {}, timeoutMs = 2500) {
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

  function fmtUsd(value) {
    const amount = Number(value || 0);
    if (!amount) return "免費";
    return `US$ ${amount.toFixed(2)} / 月`;
  }

  function planDisplayName(plan) {
    const code = String(plan?.plan_code || "").toLowerCase();
    const defaults = {
      free: "免費版",
      pro: "進階版",
      premium: "專業版"
    };
    return plan?.plan_name || defaults[code] || code.toUpperCase() || "未命名方案";
  }

  function planFeatureList(plan) {
    const code = String(plan?.plan_code || "").toLowerCase();
    const limit = plan?.features_json?.ai_chat_daily_limit;
    const map = {
      free: ["每日 5 次 AI 問答", "基本市場資訊", "適合初次體驗"],
      pro: ["每日 20 次 AI 問答", "RAG 知識庫回答", "模擬交易紀錄"],
      premium: ["不限次數 AI 問答", "AI Agent 與健康度報告", "詐騙檢測與進階紀錄"]
    };
    if (map[code]) return map[code];
    return [
      limit ? `每日 ${limit} 次 AI 問答` : "不限次數 AI 問答",
      "會員功能權限",
      "付款與訂閱紀錄"
    ];
  }

  function normalizeSubscriptionPlanCode(subscription) {
    return String(
      subscription?.plan_code ||
      subscription?.plan?.plan_code ||
      subscription?.membership_plan?.plan_code ||
      "free"
    ).toLowerCase();
  }

  function isMember() {
    return Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
  }

  function isAdminMember() {
    const email = String(window.smartInvestMembership?.email || "").trim().toLowerCase();
    return Boolean(window.authManager?.isAdmin?.() || window.smartInvestMembership?.isAdmin || email === ADMIN_EMAIL);
  }

  function adminSubscription() {
    return {
      status: "active",
      plan: { plan_code: "premium", plan_name: "專業版" },
      source: "admin-demo",
      role: "admin"
    };
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
    const { res, data } = await fetchJson(url, Object.assign({}, options, { headers }), 2800);
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

  function renderSubscription(subscription) {
    const status = String(subscription?.status || "free").toLowerCase();
    const planName = (
      subscription?.plan?.plan_name ||
      subscription?.membership_plan?.plan_name ||
      planDisplayName({ plan_code: normalizeSubscriptionPlanCode(subscription) })
    );
    const badge = $("subscriptionStatusBadge");
    if (badge) {
      badge.textContent = status === "active" ? "已啟用" : status === "free" ? "免費方案" : status;
      badge.classList.toggle("is-active", status === "active");
    }
    if ($("subscriptionPlanName")) $("subscriptionPlanName").textContent = planName;
    if ($("subscriptionSource")) $("subscriptionSource").textContent = subscription?.source || "local";
    if ($("subscriptionMode")) $("subscriptionMode").textContent = subscription?.source === "demo" ? "Demo / Mock checkout" : "Mock checkout";
    if ($("subscriptionNote")) {
      $("subscriptionNote").textContent = status === "active"
        ? "目前已可展示訂閱狀態。正式第三方金流仍列 Phase 2，MVP 先保留付款紀錄與訂閱資料流程。"
        : "目前使用免費方案。可按下方方案按鈕模擬升級，系統會建立 mock checkout 結果。";
    }
  }

  function renderMembershipPlans(plans, subscription) {
    const wrap = $("membershipPlans");
    if (!wrap) return;
    const activeCode = normalizeSubscriptionPlanCode(subscription);
    const list = Array.isArray(plans) && plans.length ? plans : DEFAULT_MEMBERSHIP_PLANS;
    wrap.innerHTML = list.map((plan) => {
      const code = String(plan.plan_code || "").toLowerCase();
      const active = code === activeCode || (activeCode === "premium" && code === "premium");
      const features = planFeatureList(plan).map((item) => `<li><i class="fas fa-check"></i><span>${item}</span></li>`).join("");
      return `
        <article class="membership-plan ${active ? "is-current" : ""}">
          <div class="membership-plan-head">
            <span>${code || "plan"}</span>
            ${active ? "<em>目前方案</em>" : ""}
          </div>
          <strong>${planDisplayName(plan)}</strong>
          <div class="membership-price">${fmtUsd(plan.monthly_price_usd)}</div>
          <ul>${features}</ul>
          <button type="button" data-plan-code="${code}" ${active ? "disabled" : ""}>
            ${active ? "目前使用中" : "模擬升級"}
          </button>
        </article>
      `;
    }).join("") || '<div class="member-record-empty">目前沒有可顯示的會員方案。</div>';
  }

  async function refreshMembershipBilling() {
    if (membershipRefreshInFlight) return membershipRefreshInFlight;
    membershipRefreshInFlight = (async () => {
    const plansData = await fetchJson("/api/membership/plans", {}, 1800)
      .then(({ res, data }) => res.ok ? data : { plans: DEFAULT_MEMBERSHIP_PLANS })
      .catch(() => ({ plans: DEFAULT_MEMBERSHIP_PLANS }));
    const plans = Array.isArray(plansData.plans) && plansData.plans.length
      ? plansData.plans
      : DEFAULT_MEMBERSHIP_PLANS;
    let subscription = isAdminMember() ? adminSubscription() : { status: "free", source: "guest" };
    if (isAdminMember()) {
      renderSubscription(subscription);
      renderMembershipPlans(plans, subscription);
    }
    const token = await waitForAuthToken(1200);
    if (!token && isAdminMember()) return;
    if (token) {
      const subData = await request("/api/membership/subscription", {
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => ({ subscription }));
      subscription = subData.subscription || subscription;
    }
    renderSubscription(subscription);
    renderMembershipPlans(plans, subscription);
    })().finally(() => {
      membershipRefreshInFlight = null;
    });
    return membershipRefreshInFlight;
  }

  async function refreshData() {
    if (dataRefreshInFlight) return dataRefreshInFlight;
    dataRefreshInFlight = (async () => {
    const token = await waitForAuthToken();
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const [portfolioData, tradeData] = await Promise.allSettled([
      request("/api/sim-trade/portfolio", { headers }),
      request("/api/sim-trade/history?limit=50", { headers })
    ]);
    if (portfolioData.status === "fulfilled") renderPortfolio(portfolioData.value.portfolio);
    if (tradeData.status === "fulfilled") renderTrades(tradeData.value.trades || []);
    })().finally(() => {
      dataRefreshInFlight = null;
    });
    return dataRefreshInFlight;
  }

  function scheduleAuthRefresh() {
    window.clearTimeout(authRefreshTimer);
    authRefreshTimer = window.setTimeout(() => {
      refreshMembershipBilling().catch(() => {});
      refreshData().catch(() => {});
    }, 180);
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderSubscription({ status: "free", source: "loading" });
    renderMembershipPlans(DEFAULT_MEMBERSHIP_PLANS, { status: "free" });
    renderPortfolio({ cash: 100000, total_value_usd: 100000, positions: [], equity_curve: [], capital_records: [] });
    renderTrades([]);

    refreshMembershipBilling().catch(() => {
      renderSubscription({ status: "free", source: "fallback" });
    });
    refreshData().catch(() => {});

    $("membershipPlans")?.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-plan-code]");
      if (!btn) return;
      if (!requireMember()) return;
      const planCode = btn.dataset.planCode || "pro";
      btn.disabled = true;
      btn.textContent = "處理中...";
      try {
        const data = await request("/api/membership/mock-checkout", {
          method: "POST",
          body: JSON.stringify({ plan_code: planCode })
        });
        renderSubscription(data.subscription || { status: "active", plan_code: planCode, source: data.mode || "mock" });
        await refreshMembershipBilling();
        alert("已完成 mock checkout，訂閱狀態已更新。");
      } catch (error) {
        alert(error.message || "會員方案更新失敗。");
      } finally {
        btn.disabled = false;
      }
    });

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
  });

  window.addEventListener("smartinvest:sim-trade-updated", () => {
    refreshData().catch(() => {});
  });

  window.addEventListener("smartinvest:auth-state", () => {
    scheduleAuthRefresh();
  });
})();
