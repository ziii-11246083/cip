(function () {
  const $ = (id) => document.getElementById(id);
  let depositPending = false;
  let authRevision = 0;
  let previewWallet = null;
  let currentPortfolio = null;
  let allocationMode = "all";
  let trendDays = "all";
  let refreshPending = false;
  let orderPending = false;
  const ASSET_COLORS = ["#ed8a3e", "#5e9684", "#d4b172", "#9eacc7", "#b79681", "#b6879f", "#8da477", "#ca9c68"];

  function finiteNumber(value) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function displayPct(value) {
    const number = finiteNumber(value);
    return number === null ? "--" : number > 0 && number < .1 ? "<0.1%" : number.toFixed(1) + "%";
  }

  function portfolioMix(portfolio, mode = "all") {
    if (!portfolio || portfolio.price_unavailable_symbols?.length) return null;
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    if (positions.some(item => finiteNumber(item.market_value) === null || Number(item.market_value) < 0)) return null;
    const entries = positions.map((item, index) => ({ symbol: String(item.symbol || "--"), value: Number(item.market_value), color: ASSET_COLORS[index % ASSET_COLORS.length] })).filter(item => item.value > 0);
    const holdingTotal = entries.reduce((sum, item) => sum + item.value, 0), cash = finiteNumber(portfolio.cash);
    if (mode === "all" && (cash === null || cash < 0)) return null;
    if (mode === "all" && cash > 0) entries.push({ symbol: "虛擬現金", value: cash, color: "#e6d9c6" });
    const total = entries.reduce((sum, item) => sum + item.value, 0);
    return { total, holdingTotal, investedPct: total > 0 ? holdingTotal / total * 100 : null,
      entries: entries.map(item => ({ ...item, pct: total > 0 ? item.value / total * 100 : null })) };
  }

  function memberTrendData(portfolio, days = "all", now = Date.now()) {
    if (portfolio?.price_unavailable_symbols?.length) return [];
    return (Array.isArray(portfolio?.equity_curve) ? portfolio.equity_curve : []).map((item, index) => ({
      value: finiteNumber(item.total_value_usd), date: window.SIFormat?.date?.(item.timestamp || item.ts) || null,
      timestamp: item.timestamp || item.ts, index
    })).filter(item => item.value !== null && item.value >= 0 && (days === "all" || (item.date && item.date.getTime() >= now - Number(days) * 86400000)))
      .sort((a, b) => a.date && b.date ? a.date - b.date : a.index - b.index);
  }

  function scrollToMemberSection(id) {
    const target = $(id);
    if (!target?.getBoundingClientRect || !window.scrollTo) return;
    const top = target.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height || 80) - 18;
    window.scrollTo({ top, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function renderAllocation(portfolio) {
    const ring = $("memberAllocationRing"), legend = $("memberAllocationLegend");
    if (!ring || !legend) return;
    const mix = portfolioMix(portfolio, allocationMode);
    ring.dataset.mode = allocationMode;
    let cursor = 0;
    ring.style.background = mix?.total ? `conic-gradient(${mix.entries.map(item => { const start = cursor; cursor += item.pct * 3.6; return `${item.color} ${start}deg ${cursor}deg`; }).join(",")})` : "#e8dccd";
    ring.setAttribute("aria-label", mix?.total ? `${allocationMode === "all" ? "全部資產" : "持倉內"}配置：${mix.entries.map(item => `${item.symbol} ${displayPct(item.pct)}`).join("、")}` : "配置資料尚未可用");
    $("memberAllocationLabel").textContent = allocationMode === "all" ? "已投入" : "持倉市值";
    $("memberAllocationValue").textContent = mix && mix.total > 0 ? allocationMode === "all" ? displayPct(mix.investedPct) : fmtUsd(mix.holdingTotal) : "--";
    $("memberAllocationCaption").textContent = allocationMode === "all" ? "含虛擬現金" : "不含現金";
    legend.innerHTML = mix ? mix.entries.map(item => `<div class="member-mix-row"><i class="member-mix-dot" style="background:${item.color}" aria-hidden="true"></i><span>${escapeHTML(item.symbol)}</span><b>${escapeHTML(displayPct(item.pct))}</b><small>${fmtUsd(item.value)}</small></div>`).join("") : "";
    $("memberAllocationNote").textContent = !portfolio ? "登入進階會員後可查看配置。" : !mix ? "部分估值資料缺少，配置比例暫不計算。" : !mix.total ? "目前沒有可計算的資產。" : allocationMode === "all" ? "以持倉市值與虛擬現金合計計算。" : "以持倉市值合計計算，方便比較幣種比例。";
  }

  function renderMemberTrend(portfolio) {
    const root = $("memberTrendChart");
    if (!root) return;
    const points = memberTrendData(portfolio, trendDays);
    if ($("memberTrendCaption")) $("memberTrendCaption").textContent = `${points.length} 筆帳戶快照`;
    if (!points.length) {
      root.innerHTML = `<div class="member-chart-empty">${!portfolio ? "登入進階會員後可查看資產走勢。" : portfolio.price_unavailable_symbols?.length ? "部分行情暫不可用，資產走勢暫不呈現。" : "這段期間沒有帳戶快照。"}</div>`;
      return;
    }
    const values = points.map(item => item.value), min = Math.min(...values), max = Math.max(...values);
    const padding = Math.max((max - min) * .12, max * .005, 1), low = Math.max(0, min - padding), high = max + padding;
    const width = Math.max(260, root.clientWidth || 640), right = width - 16;
    const x = index => points.length === 1 ? (right + 64) / 2 : 64 + index / (points.length - 1) * (right - 64);
    const y = value => 182 - (value - low) / (high - low) * 164;
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
    const grid = [0, 1, 2, 3].map(index => { const value = low + (high - low) * index / 3, py = y(value); return `<line x1="64" y1="${py}" x2="${right}" y2="${py}" stroke="#efe5d9"/><text x="55" y="${py + 4}" text-anchor="end">${value >= 1000 ? (value / 1000).toFixed(1) + "K" : value.toFixed(0)}</text>`; }).join("");
    const dates = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(index => `<text x="${x(index)}" y="207" text-anchor="middle">${points[index].date ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit" }).format(points[index].date) : `快照 ${points[index].index + 1}`}</text>`).join("");
    root.innerHTML = `<svg viewBox="0 0 ${width} 224" role="img" aria-label="${points.length} 筆資產快照；最後總值 ${fmtUsd(points.at(-1).value)}"><text x="8" y="10">USD</text>${grid}${points.length > 1 ? `<path d="${path} L${right},182 L64,182 Z" fill="#ef8a3b10"/>` : ""}<path d="${path}" fill="none" stroke="#e68b42" stroke-width="2.5" stroke-linejoin="round"/>${points.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.value)}" r="${points.length < 5 ? 4 : 2}" fill="#e68b42"><title>${escapeHTML(dateText(point.timestamp))} · ${point.value.toLocaleString("zh-TW", {minimumFractionDigits:2,maximumFractionDigits:2})}（USD）</title></circle>`).join("")}${dates}</svg>`;
  }

  function fmtUsd(valueUsd) {
    const value = finiteNumber(valueUsd);
    if (value === null) return "--";
    return "USD " + value.toLocaleString("zh-TW", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtQty(value) {
    return window.SIFormat.quantity(value);
  }

  function dateText(value) {
    return window.SIFormat.dateText(value);
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

  function requirePremium() {
    if (isPremiumMember()) return true;
    window.authManager?.requireMember?.("模擬交易");
    return false;
  }

  async function request(url, options) {
    const revision = authRevision;
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    if (!headers.Authorization) {
      const token = await getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (revision !== authRevision && ["POST", "DELETE"].includes(options?.method)) throw new Error("帳戶狀態已變更，請重新確認操作。");
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
    currentPortfolio = portfolio;
    const isDemo = Boolean(window.authManager?.isDemoMember?.());
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const capitalRecords = Array.isArray(portfolio.capital_records) ? portfolio.capital_records : [];
    const mix = portfolioMix(portfolio), holdings = portfolioMix(portfolio, "holdings");
    const unavailable = Boolean(portfolio.price_unavailable_symbols?.length);
    if ($("kpiCapital")) $("kpiCapital").textContent = unavailable ? "--" : fmtUsd(portfolio.total_value_usd);
    if ($("kpiCapitalCount")) $("kpiCapitalCount").textContent = unavailable ? "部分行情暫不可用" : "含現金與持倉市值";
    if ($("kpiCash")) $("kpiCash").textContent = fmtUsd(portfolio.cash);
    if ($("kpiHoldings")) $("kpiHoldings").textContent = fmtUsd(holdings?.holdingTotal);
    if ($("kpiHoldingCount")) $("kpiHoldingCount").textContent = `${positions.length} 種資產`;
    if ($("memberCapitalRecordCount")) $("memberCapitalRecordCount").textContent = `${capitalRecords.length} 筆紀錄 · 顯示最近 8 筆`;
    const pnl = unavailable ? null : finiteNumber(portfolio.unrealized_pnl);
    if ($("memberHoldingPnl")) {
      $("memberHoldingPnl").textContent = pnl !== null && pnl > 0 ? "+ " + fmtUsd(pnl) : fmtUsd(pnl);
      $("memberHoldingPnl").className = pnl === null || pnl === 0 ? "" : pnl > 0 ? "member-gain" : "member-loss";
    }
    renderAllocation(portfolio);
    renderMemberTrend(portfolio);

    const capitalList = $("capitalList");
    if (capitalList) {
      const records = capitalRecords.slice(0, 8);
      capitalList.replaceChildren();
      if (!records.length) {
        appendText(capitalList, "div", "尚無資金投放紀錄，資產快照可在上方走勢查看。", "member-record-empty");
      }
      records.forEach((item) => {
        const recordId = item.id || "";
        const row = document.createElement("div");
        row.className = "member-list-item";
        const info = document.createElement("div");
        appendText(info, "strong", fmtUsd(item.amount_usd));
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

    const cards = $("memberHoldingCards");
    if (cards) cards.innerHTML = positions.length ? positions.map((item, index) => {
      const symbol = String(item.symbol || "--"), color = ASSET_COLORS[index % ASSET_COLORS.length];
      const entry = holdings?.entries.find(entry => entry.symbol === symbol), pct = entry?.pct ?? null;
      const missing = portfolio.price_unavailable_symbols?.includes(symbol) || finiteNumber(item.market_value) === null;
      const pnl = missing ? null : finiteNumber(item.unrealized_pnl), tone = pnl === null || pnl === 0 ? "" : pnl > 0 ? "member-gain" : "member-loss";
      return `<article class="member-holding-card"><div class="member-holding-top"><span class="member-coin-mark" style="color:${color}">${escapeHTML(symbol.slice(0, 1))}</span><strong>${escapeHTML(symbol)}</strong><b>${escapeHTML(displayPct(pct))}</b></div><strong class="member-holding-value">${missing ? "--" : fmtUsd(item.market_value)}</strong><div class="member-holding-track" aria-hidden="true"><span style="background:${color};width:${pct === null ? 0 : pct}%"></span></div><div class="member-holding-bottom"><span>數量 ${escapeHTML(fmtQty(item.quantity))}</span><span>損益 <b class="${tone}">${pnl !== null && pnl > 0 ? "+ " : ""}${fmtUsd(pnl)}</b></span></div></article>`;
    }).join("") : '<div class="member-record-empty">目前沒有持倉，建立模擬買單後就會顯示在這裡。</div>';
    const holdingTable = $("holdingTable");
    if (holdingTable) {
      holdingTable.innerHTML = positions.length ? `
        <table>
          <thead><tr><th>幣種</th><th>數量</th><th>現價（USD）</th><th>市值（USD）</th><th>占全部資產</th><th>持倉內占比</th></tr></thead>
          <tbody>
            ${positions.map((item) => {
              const allPct = mix?.entries.find(entry => entry.symbol === item.symbol)?.pct ?? null;
              const holdingPct = holdings?.entries.find(entry => entry.symbol === item.symbol)?.pct ?? null;
              const missing = portfolio.price_unavailable_symbols?.includes(item.symbol);
              return `<tr><td>${escapeHTML(item.symbol)}</td><td>${escapeHTML(fmtQty(item.quantity))}</td><td>${missing ? "--" : fmtUsd(item.current_price)}</td><td>${missing ? "--" : fmtUsd(item.market_value)}</td><td>${escapeHTML(displayPct(allPct))}</td><td>${escapeHTML(displayPct(holdingPct))}</td></tr>`;
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
    const tier = !isMember() ? "訪客" : isTestPremium ? "進階會員 · 預覽模式" : premium ? "進階會員" : "尚未開通進階會員";
    if ($("memberCurrentTier")) $("memberCurrentTier").textContent = `目前方案：${tier}`;
    if ($("memberFreeTag")) $("memberFreeTag").hidden = true;
    if ($("memberPremiumTag")) $("memberPremiumTag").textContent = premium ? "目前方案" : "付款後開通";
    $("memberFreePlan")?.classList.remove("is-current");
    $("memberPremiumPlan")?.classList.toggle("is-current", premium);
    if ($("memberPremiumAction")) {
      $("memberPremiumAction").innerHTML = premium
        ? '查看會員狀態 <i class="fas fa-arrow-right"></i>'
        : '繼續付款開通 <i class="fas fa-arrow-right"></i>';
    }
    if ($("memberSubscribeLabel")) {
      $("memberSubscribeLabel").textContent = premium ? "查看進階會員權益" : "訂閱進階會員";
    }
    if ($("memberSubscribeHint")) {
      $("memberSubscribeHint").textContent = premium
        ? `${isTestPremium ? "預覽帳號" : "進階會員"} · 目前方案`
        : "99 TWD／月 · 付款後開通";
    }
    if ($("memberRefresh")) $("memberRefresh").disabled = !premium || refreshPending;
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
    scrollToMemberSection("profileEditor");
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
    if (!isPremiumMember()) {
      window.location.assign(isMember() ? "/register?step=payment" : "/register");
      return;
    }
    const dialog = $("subscriptionDialog");
    if (!dialog) return;
    const tier = !isMember() ? "尚未登入" : window.authManager?.isDemoMember?.() ? "進階會員 · 預覽模式（無扣款）" : isPremiumMember() ? "進階會員" : "尚未開通進階會員";
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
        <div><strong>${order.side === "buy" ? "買入" : order.side === "sell" ? "賣出" : "交易"} ${escapeHTML(order.symbol)}</strong><span>${fmtUsd(order.amount_usd)} · 約 ${escapeHTML(fmtQty(order.quantity))} 顆</span></div>
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

  function fmtAssetUsd(value) {
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
    renderRealAssetMessage(accounts[0]?.account?.preview ? "已建立錢包連結流程預覽；尚未連接真實服務。" : `已連結 ${accounts.length} 個唯讀錢包。`, "success");
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
      appendText(identity, "span", account.preview ? "連結流程預覽 · 未讀取資產" : "Ethereum Mainnet · Alchemy 唯讀", "real-account-meta");
      head.appendChild(identity);
      const actions = document.createElement("div");
      actions.className = "real-account-actions";
      if (account.status === "active") {
        const sync = appendText(actions, "button", account.preview ? "預覽同步" : "立即同步");
        sync.type = "button";
        sync.dataset.assetAction = "sync";
        sync.dataset.accountId = account.id || "";
        const disconnect = appendText(actions, "button", account.preview ? "解除預覽連結" : "停止連結", "secondary");
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
      appendText(summary, "span", account.preview ? "預覽模式" : snapshot ? `狀態：${snapshot.status}` : "尚無快照");
      appendText(summary, "strong", account.preview ? "未讀取真實資產" : snapshot ? fmtAssetUsd(snapshot.total_value_usd) : "尚未同步");
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
          appendText(row, "span", `${fmtQty(item.quantity)} · ${fmtAssetUsd(item.value_usd)}`);
          const price = item.price_usd === null || item.price_usd === undefined
            ? "無 USD 價格，僅顯示數量"
            : `單價 ${fmtAssetUsd(item.price_usd)} · ${item.price_source || "來源未知"} · ${item.price_as_of ? dateText(item.price_as_of) : "時間未知"}`;
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
    setRealAssetAccess(false, isMember() ? "進階會員尚未開通" : "加入進階會員後可使用",
      "錢包連結流程預覽開放給進階會員。");
    renderRealAssetMessage("完成付款開通後，可預覽錢包連結流程。", "info");
  }

  async function refreshData() {
    const revision = authRevision;
    const token = await waitForAuthToken();
    if (!isPremiumMember()) return;
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
    if ($("memberDataStatus")) $("memberDataStatus").textContent = portfolioData.portfolio?.price_unavailable_symbols?.length ? "部分行情暫不可用" : `資料更新 ${new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date())}`;
  }

  function clearAccountVisuals() {
    currentPortfolio = null;
    ["kpiCapital", "kpiCash", "kpiHoldings", "kpiOrders", "memberHoldingPnl", "memberCapitalRecordCount"].forEach(id => { if ($(id)) $(id).textContent = "--"; });
    if ($("memberHoldingPnl")) $("memberHoldingPnl").className = "";
    if ($("kpiCapitalCount")) $("kpiCapitalCount").textContent = "含現金與持倉市值";
    if ($("kpiHoldingCount")) $("kpiHoldingCount").textContent = "等待資產資料";
    ["capitalList", "orderList", "holdingTable", "memberHoldingCards"].forEach(id => $(id)?.replaceChildren());
    renderAllocation(null); renderMemberTrend(null);
    if ($("memberDataStatus")) $("memberDataStatus").textContent = isPremiumMember() ? "資產資料載入中" : "登入進階會員後載入資產";
  }

  function setActionStatus(id, message, error = false) {
    if ($(id)) { $(id).textContent = message; $(id).dataset.state = error ? "error" : "info"; }
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderMemberProfile();
    renderAllocation(null); renderMemberTrend(null);
    document.querySelectorAll("[data-allocation-mode]").forEach(button => button.addEventListener("click", () => {
      allocationMode = button.dataset.allocationMode;
      document.querySelectorAll("[data-allocation-mode]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      renderAllocation(currentPortfolio);
    }));
    document.querySelectorAll("[data-member-days]").forEach(button => button.addEventListener("click", () => {
      trendDays = button.dataset.memberDays;
      document.querySelectorAll("[data-member-days]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      renderMemberTrend(currentPortfolio);
    }));
    document.querySelectorAll(".member-section-nav a").forEach(link => link.addEventListener("click", event => { event.preventDefault(); scrollToMemberSection(link.getAttribute("href").slice(1)); }));
    $("memberRefresh")?.addEventListener("click", async () => {
      if (!isPremiumMember() || refreshPending) return;
      const revision = authRevision;
      refreshPending = true; $("memberRefresh").disabled = true;
      if ($("memberDataStatus")) $("memberDataStatus").textContent = "更新中…";
      try { await refreshData(); }
      catch (error) { if (revision === authRevision && $("memberDataStatus")) $("memberDataStatus").textContent = error.message || "更新失敗，請稍後重試。"; }
      finally { refreshPending = false; renderMemberProfile(); }
    });
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
      if (!requirePremium()) return;
      const amountUsd = Number($("capitalAmount")?.value || 0);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) return alert("請輸入大於 0 的新增資金。");
      const revision = authRevision;
      depositPending = true;
      setActionStatus("memberCapitalStatus", "新增虛擬現金中…");
      const submitButton = $("capitalForm")?.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      request("/api/sim-trade/deposit", {
        method: "POST",
        body: JSON.stringify({
          amount_usd: amountUsd,
          note: $("capitalNote")?.value || ""
        })
      }).then(() => {
        if (revision !== authRevision) return;
        $("capitalAmount").value = "";
        $("capitalNote").value = "";
        setActionStatus("memberCapitalStatus", "已新增資金，帳戶資料更新中。");
        return refreshData();
      }).catch((error) => {
        if (revision !== authRevision) return;
        setActionStatus("memberCapitalStatus", error.message || "新增資金失敗", true);
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
      if (orderPending) return;
      if (!requirePremium()) return;
      const amountUsd = Number($("orderAmount")?.value || 0);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) return alert("請輸入大於 0 的下單金額。");
      const revision = authRevision, button = $("orderForm")?.querySelector('[type="submit"]');
      try {
        orderPending = true;
        if (button) button.disabled = true;
        setActionStatus("memberOrderStatus", "模擬單送出中…");
        await request("/api/sim-trade/order", {
          method: "POST",
          body: JSON.stringify({
            symbol: $("orderSymbol")?.value || "BTC",
            side: $("orderSide")?.value || "buy",
            amount_usd: amountUsd
          })
        });
        if (revision !== authRevision) return;
        $("orderAmount").value = "";
        await refreshData();
        setActionStatus("memberOrderStatus", "模擬單已建立，帳戶與持倉已更新。");
      } catch (error) {
        if (revision !== authRevision) return;
        setActionStatus("memberOrderStatus", error.message || "下單失敗", true);
        alert(error.message || "下單失敗");
      } finally {
        orderPending = false;
        if (button) button.disabled = false;
      }
    });

    $("clearMemberData")?.addEventListener("click", async () => {
      if (!requirePremium()) return;
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
      if (!requirePremium()) return;
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
        renderRealAssetMessage("已點擊預覽同步；目前不會讀取或顯示真實資產。", "info");
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
    clearAccountVisuals();
    if (!isMember()) closeProfileEditor();
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
  window.addEventListener("resize", () => renderMemberTrend(currentPortfolio));
})();

