(function () {
  const $ = (id) => document.getElementById(id);
  const CONVERSATION_KEY = "smartinvest_ai_coach_conversation_id";
  const LEGACY_AGENT_KEY = "smartinvest_ai_agent_conversation_id";
  const messageHistory = [];
  const newChatBtn = $("aiCoachNewChatBtn");
  let conversationCache = [];
  let isLocked = false;
  let pageInitialized = false;
  let memberDataLoaded = false;
  let planAllocation = [];
  let orderPending = false;

  function migrateAgentConversation() {
    if (!localStorage.getItem(CONVERSATION_KEY)) {
      const legacyId = localStorage.getItem(LEGACY_AGENT_KEY);
      if (legacyId) localStorage.setItem(CONVERSATION_KEY, legacyId);
    }
    localStorage.removeItem(LEGACY_AGENT_KEY);
  }

  function setLockedState(locked) {
    isLocked = locked;
    $("memberGate")?.classList.toggle("show", locked);
    $("memberGate")?.classList.toggle("locked", locked);
    const app = $("aiCoachApp");
    if (app) app.classList.toggle("ai-coach-locked", locked);
  }

  function syncMemberState(loggedIn) {
    const isMember = Boolean(loggedIn);
    setLockedState(!isMember);
    if (!isMember) {
      memberDataLoaded = false;
      return;
    }
    if (!pageInitialized || memberDataLoaded) return;
    memberDataLoaded = true;
    migrateAgentConversation();
    loadConversations();
    loadHistory();
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ── TASK 04：純函式（可測試）─────────────────────────────────────
  function citationLines(citation) {
    if (typeof citation === "string") {
      const text = String(citation).trim();
      return text ? [{ label: "來源", text }] : null;
    }
    if (citation && typeof citation === "object" && !Array.isArray(citation)) {
      const lines = [];
      if (citation.source) lines.push({ label: "來源", text: String(citation.source) });
      if (citation.topic) lines.push({ label: "主題", text: String(citation.topic) });
      if (citation.section) lines.push({ label: "章節", text: String(citation.section) });
      if (citation.chunk_id) lines.push({ label: "段落", text: String(citation.chunk_id) });
      return lines.length ? lines : null;
    }
    return null;
  }

  function displayableCitationCount(citations) {
    const items = Array.isArray(citations) ? citations : [];
    let count = 0;
    items.forEach((citation) => {
      if (citationLines(citation)) count += 1;
    });
    return count;
  }

  function hintsFor(confidence, hasCitations) {
    const hints = [];
    if (!hasCitations) hints.push("本回答未取得可引用知識，內容僅供參考。");
    if (confidence === "low") hints.push("目前知識庫中與此問題直接相關的資訊有限，此回答僅供參考。");
    return hints;
  }

  function feedbackVisible(traceId) {
    return typeof traceId === "string" && traceId.length >= 8 && traceId.length <= 128;
  }

  function buildCitationBlock(citations) {
    const items = Array.isArray(citations) ? citations : [];
    const displayable = displayableCitationCount(items);
    if (displayable === 0) return null;
    const details = document.createElement("details");
    details.className = "cite-details";
    const summary = document.createElement("summary");
    summary.textContent = `參考來源（${displayable}）`;
    details.appendChild(summary);
    const list = document.createElement("ul");
    list.className = "cite-list";
    items.forEach((citation) => {
      const lines = citationLines(citation);
      if (!lines) return;
      lines.forEach((line) => {
        const li = document.createElement("li");
        li.className = "cite-item";
        const label = document.createElement("span");
        label.className = "cite-label";
        label.textContent = line.label;
        const text = document.createElement("span");
        text.className = "cite-text";
        text.textContent = line.text; // server data 一律 textContent，不做 innerHTML
        li.appendChild(label);
        li.appendChild(text);
        list.appendChild(li);
      });
    });
    details.appendChild(list);
    return details;
  }

  function nextStepsFor(meta) {
    if (!meta || typeof meta !== "object") return [];
    const citations = Array.isArray(meta.citations) ? meta.citations : [];
    const hasCitations = displayableCitationCount(citations) > 0;
    const steps = [];
    if (hasCitations) {
      steps.push("先展開參考來源，確認這次回答引用的資料是否符合你的問題。");
    } else {
      steps.push("補充目前持倉、現金比例或投資期限後再問一次，AI 才能給更貼近情境的建議。");
    }
    if (meta.confidence === "low") {
      steps.push("此回答信心較低，建議先用模擬交易或壓力測試交叉檢查，不要直接當成操作依據。");
    } else {
      steps.push("把建議轉成一筆小額模擬單，或到模擬交易頁跑黑天鵝壓力測試。");
    }
    if (feedbackVisible(meta.trace_id)) {
      steps.push("如果回答不準，請用下方 👍／👎 回饋，這會用來檢查 RAG 回答品質。");
    }
    return steps;
  }

  function buildNextStepsBlock(meta) {
    const steps = nextStepsFor(meta);
    if (!steps.length) return null;
    const block = document.createElement("div");
    block.className = "next-step-box";
    const title = document.createElement("strong");
    title.textContent = "下一步建議";
    const list = document.createElement("ul");
    steps.forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      list.appendChild(item);
    });
    block.appendChild(title);
    block.appendChild(list);
    return block;
  }

  function buildFeedbackBar(traceId) {
    if (!feedbackVisible(traceId)) return null;
    const bar = document.createElement("div");
    bar.className = "feedback-bar";
    const label = document.createElement("span");
    label.className = "feedback-label";
    label.textContent = "RAG 回饋：這個回答有幫助嗎？";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "feedback-btn";
    up.textContent = "👍 有幫助";
    const down = document.createElement("button");
    down.type = "button";
    down.className = "feedback-btn";
    down.textContent = "👎 沒幫助";
    const errorEl = document.createElement("span");
    errorEl.className = "feedback-error";
    errorEl.setAttribute("role", "status");

    let inFlight = false;
    const setLocked = (locked) => {
      up.disabled = locked;
      down.disabled = locked;
      bar.classList.toggle("is-pending", locked);
      if (locked) {
        up.setAttribute("aria-busy", "true");
        down.setAttribute("aria-busy", "true");
      } else {
        up.removeAttribute("aria-busy");
        down.removeAttribute("aria-busy");
      }
    };
    const setActive = (btn) => {
      up.classList.toggle("active", btn === up);
      down.classList.toggle("active", btn === down);
      up.setAttribute("aria-pressed", String(btn === up));
      down.setAttribute("aria-pressed", String(btn === down));
    };
    const submit = async (vote, btn) => {
      if (inFlight) return; // pending 期間忽略額外提交：同時最多一個 in-flight request
      inFlight = true;      // 必須在任何 await 之前上鎖，避免競態視窗
      setLocked(true);
      errorEl.textContent = "";
      const token = await getAuthToken();
      if (!token) {
        errorEl.textContent = "請先登入會員。";
        inFlight = false;
        setLocked(false);
        return;
      }
      try {
        const res = await fetch("/api/rag-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ trace_id: traceId, vote }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setActive(btn);
        } else {
          errorEl.textContent = (typeof data.message === "string" && data.message)
            ? data.message : "回饋送出失敗，請稍後再試。";
        }
      } catch {
        errorEl.textContent = "連線不穩，回饋未送出，請稍後重試。";
      } finally {
        inFlight = false;
        setLocked(false); // 完成（成功或失敗）後解除鎖定，可改票／重試
      }
    };
    up.addEventListener("click", () => submit("up", up));
    down.addEventListener("click", () => submit("down", down));
    bar.appendChild(label);
    bar.appendChild(up);
    bar.appendChild(down);
    bar.appendChild(errorEl);
    return bar;
  }

  function appendChatBubble(speaker, text, isUser = false, meta = null) {
    const stream = $("chatStream");
    if (!stream) return;

    const row = document.createElement("div");
    row.className = `chat-row ${isUser ? "user" : "ai"}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = isUser ? "你" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const nameEl = document.createElement("b");
    nameEl.textContent = speaker;
    const textEl = document.createElement("p");
    textEl.textContent = text;
    bubble.appendChild(nameEl);
    bubble.appendChild(textEl);

    // ── TASK 04：本次回答的來源／信心／feedback（舊 history 無 meta → 不顯示）──
    if (!isUser && meta) {
      const citations = Array.isArray(meta.citations) ? meta.citations : [];
      // hasCitations 依「可顯示來源」判定：invalid-only citations 等同無來源
      const hasCitations = displayableCitationCount(citations) > 0;
      hintsFor(meta.confidence, hasCitations).forEach((hint) => {
        const note = document.createElement("p");
        note.className = "confidence-note";
        note.textContent = hint;
        bubble.appendChild(note);
      });
      const citeBlock = buildCitationBlock(citations);
      if (citeBlock) bubble.appendChild(citeBlock);
      const nextStepBlock = buildNextStepsBlock(meta);
      if (nextStepBlock) bubble.appendChild(nextStepBlock);
      const feedbackBar = buildFeedbackBar(meta.trace_id);
      if (feedbackBar) bubble.appendChild(feedbackBar);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    stream.appendChild(row);
    stream.scrollTop = stream.scrollHeight;
  }

  function recordMessage(role, content) {
    if (!content) return;
    messageHistory.push({ role, content });
  }

  function renderHistory(rows) {
    const stream = $("chatStream");
    if (!stream) return;

    stream.innerHTML = "";
    messageHistory.length = 0;

    rows.forEach((row) => {
      const type = (row.message_type || "").toLowerCase();
      const content = row.content || "";
      if (!content) return;
      if (type === "user") {
        appendChatBubble("你", content, true);
        recordMessage("user", content);
      } else if (type === "assistant") {
        appendChatBubble("Smart Invest AI 教練", content, false);
        recordMessage("assistant", content);
      }
    });
  }

  function renderDefaultWelcome() {
    const stream = $("chatStream");
    if (!stream) return;
    stream.innerHTML = `
      <div class="chat-row ai"><div class="avatar">AI</div><div class="bubble"><b>AI 投資教練</b><p>你好，請問你現在最想解決的投資問題是什麼？例如「BTC 目前占比太高怎麼辦？」或「買入前該檢查哪些風險？」</p></div></div>
    `;
  }

  function setActiveConversation(conversationId) {
    const listEl = document.getElementById("aiCoachConversationList");
    if (!listEl) return;
    listEl.querySelectorAll(".conversation-item").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.id === conversationId);
    });
  }

  function renderConversationList(items) {
    const listEl = document.getElementById("aiCoachConversationList");
    if (!listEl) return;
    conversationCache = Array.isArray(items) ? items : [];
    const activeId = localStorage.getItem(CONVERSATION_KEY) || "";

    if (!conversationCache.length) {
      listEl.innerHTML = '<div class="conversation-empty">尚無對話紀錄</div>';
      return;
    }

    listEl.innerHTML = conversationCache.map((item) => {
      const id = escapeHTML(item.id || "");
      const title = escapeHTML(item.title || "Chat");
      return `
        <button class="conversation-item" type="button" data-id="${id}">
          <span>${title}</span>
        </button>
      `;
    }).join("");

    listEl.querySelectorAll(".conversation-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id || "";
        selectConversation(id);
      });
    });

    setActiveConversation(activeId);
  }

  async function loadConversations() {
    const listEl = document.getElementById("aiCoachConversationList");
    if (!listEl) return;

    const token = await getAuthToken();
    if (!token) {
      renderConversationList([]);
      return;
    }

    const headers = { Authorization: `Bearer ${token}` };

    try {
      const res = await fetch("/api/ai-chat/conversations?limit=50", { headers });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem(CONVERSATION_KEY);
        renderConversationList([]);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.conversations)) {
        renderConversationList(data.conversations);
      } else {
        renderConversationList([]);
      }
    } catch {
      renderConversationList([]);
    }
  }

  async function selectConversation(conversationId) {
    if (!conversationId) return;
    if (isLocked) {
      window.authManager?.requireMember?.("AI 投資教練");
      return;
    }
    await window.waitForSmartInvestAuth?.();
    if (window.authManager && !window.authManager.isLoggedIn?.()) {
      window.authManager.requireMember?.("AI 投資教練");
      return;
    }

    localStorage.setItem(CONVERSATION_KEY, conversationId);
    renderHistory([]);
    setActiveConversation(conversationId);
    await loadHistory(conversationId);
  }

  function resetChat(showWelcome = true) {
    messageHistory.length = 0;
    if (showWelcome) {
      renderDefaultWelcome();
    } else {
      const stream = $("chatStream");
      if (stream) stream.innerHTML = "";
    }
    setActiveConversation("");
  }

  function showTypingBubble() {
    const stream = $("chatStream");
    if (!stream || $("typingRow")) return;

    const row = document.createElement("div");
    row.className = "chat-row ai";
    row.id = "typingRow";
    row.innerHTML = `
      <div class="avatar">AI</div>
      <div class="typingBubble">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;

    stream.appendChild(row);
    stream.scrollTop = stream.scrollHeight;
  }

  function removeTypingBubble() {
    $("typingRow")?.remove();
  }

  function setSendLoading(isLoading) {
    const inputEl = $("chatInput");
    const btnSend = $("btnSend");
    if (!inputEl || !btnSend) return;

    inputEl.disabled = isLoading;
    btnSend.disabled = isLoading;
    btnSend.classList.toggle("is-loading", isLoading);
    btnSend.innerHTML = isLoading
      ? '<i class="fas fa-spinner fa-spin"></i> 思考中'
      : '<i class="fas fa-paper-plane"></i> 傳送';
  }

  function initPageMotion() {
    const targets = [...document.querySelectorAll(".reveal-on-scroll, .reveal")];
    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    targets.forEach((el, idx) => {
      if (!el.style.getPropertyValue("--reveal-delay")) {
        el.style.setProperty("--reveal-delay", `${Math.min(idx * 80, 260)}ms`);
      }
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
    );

    targets.forEach((el) => observer.observe(el));
  }

  function initRiskCards() {
    const riskInput = $("riskProfile");
    document.querySelectorAll(".risk-card").forEach((card) => {
      card.addEventListener("click", () => {
        document.querySelectorAll(".risk-card").forEach((item) => item.classList.remove("active"));
        card.classList.add("active");
        if (riskInput) riskInput.value = card.dataset.risk || "穩健型";
      });
    });
  }

  function initQuickAsk() {
    const input = $("chatInput");
    document.querySelectorAll(".quick-list [data-question], .quick-prompts [data-question], .chat-suggestions [data-question]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!input) return;
        input.value = btn.dataset.question || "";
        input.focus();
      });
    });
  }

  async function getAuthToken() {
    try {
      return window.authManager ? await window.authManager.getToken() : null;
    } catch {
      return null;
    }
  }

  async function loadHistory(conversationId) {
    const activeId = conversationId || localStorage.getItem(CONVERSATION_KEY) || "";
    if (!activeId) return;

    const token = await getAuthToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(`/api/ai-chat/history?conversation_id=${encodeURIComponent(activeId)}`, { headers });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem(CONVERSATION_KEY);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.messages)) {
        renderHistory(data.messages);
      }
    } catch {
      // ignore history load errors
    }
  }

  async function sendMessage() {
    if (isLocked) {
      window.authManager?.requireMember?.("AI 投資教練");
      return;
    }
    await window.waitForSmartInvestAuth?.();
    if (window.authManager && !window.authManager.isLoggedIn?.()) {
      window.authManager.requireMember?.("AI 投資教練");
      return;
    }

    const inputEl = $("chatInput");
    const btnSend = $("btnSend");
    if (!inputEl || !btnSend || btnSend.disabled) return;

    const text = inputEl.value.trim();
    const riskProfile = $("riskProfile")?.value || "穩健型";
    if (!text) {
      inputEl.focus();
      return;
    }

    appendChatBubble("你", text, true);
    recordMessage("user", text);
    inputEl.value = "";
    setSendLoading(true);
    showTypingBubble();

    try {
      const token = await getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const conversationId = localStorage.getItem(CONVERSATION_KEY) || "";
      const payload = { message: text, risk_profile: riskProfile, messages: messageHistory };
      if (conversationId) payload.conversation_id = conversationId;

      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      removeTypingBubble();

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem(CONVERSATION_KEY);
        window.authManager?.requireMember?.("AI 投資教練");
        return;
      }

      if (!res.ok) {
        appendChatBubble("系統提醒", data.reply || "目前 AI 教練暫時無法回覆，請稍後再試。");
        return;
      }

      if (data.conversation_id) {
        localStorage.setItem(CONVERSATION_KEY, data.conversation_id);
        loadConversations();
        setActiveConversation(data.conversation_id);
      }
      const replyText = data.reply || "我收到你的問題了，但目前沒有取得完整回覆。";
      appendChatBubble("Smart Invest AI 教練", replyText, false, {
        citations: data.citations,
        confidence: data.confidence,
        trace_id: data.trace_id,
      });
      recordMessage("assistant", replyText);
    } catch {
      removeTypingBubble();
      appendChatBubble("系統提醒", "連線暫時不穩，請稍後再送出一次。");
    } finally {
      setSendLoading(false);
      inputEl.focus();
    }
  }

  function initChatEvents() {
    $("btnSend")?.addEventListener("click", sendMessage);
    $("chatInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      sendMessage();
    });
    newChatBtn?.addEventListener("click", () => {
      if (isLocked) {
        window.authManager?.requireMember?.("AI 投資教練");
        return;
      }
      localStorage.removeItem(CONVERSATION_KEY);
      resetChat(true);
      loadConversations();
    });
  }

  function makeElement(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }

  function formatUsd(value) {
    return new Intl.NumberFormat("zh-TW", {
      style: "currency", currency: "USD", maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  }

  function setToolStatus(id, message, isError = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-error", isError);
  }

  async function memberRequest(url, options = {}) {
    const token = await getAuthToken();
    if (!token) throw new Error("請先登入會員。");
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || "請求失敗，請稍後再試。");
    return data;
  }

  function activateView(view) {
    for (const name of ["chat", "plan", "portfolio"]) {
      const selected = name === view;
      const tab = $({ chat: "coachTabChat", plan: "coachTabPlan", portfolio: "coachTabPortfolio" }[name]);
      const panel = $({ chat: "coachChatView", plan: "coachPlanView", portfolio: "coachPortfolioView" }[name]);
      tab?.classList.toggle("active", selected);
      tab?.setAttribute("aria-selected", String(selected));
      if (panel) panel.hidden = !selected;
    }
    if (view === "portfolio") refreshPortfolio();
  }

  function addTextList(parent, title, items, tag) {
    if (!Array.isArray(items) || !items.length) return;
    parent.appendChild(makeElement("h3", title));
    const list = document.createElement(tag);
    items.forEach((item) => {
      if (typeof item === "string" && item.trim()) list.appendChild(makeElement("li", item));
    });
    parent.appendChild(list);
  }

  function addTable(parent, className, headers, rows) {
    const table = makeElement("table", undefined, className);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((label) => headRow.appendChild(makeElement("th", label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    rows.forEach((values) => {
      const row = document.createElement("tr");
      values.forEach((value) => row.appendChild(makeElement("td", value)));
      body.appendChild(row);
    });
    table.appendChild(body);
    parent.appendChild(table);
  }

  function renderPlan(data, budget) {
    const container = $("coachPlanResult");
    if (!container) return;
    container.innerHTML = "";
    container.hidden = false;
    container.className = "coach-plan-result";
    container.appendChild(makeElement("h2", data.summary || "投資任務計畫"));
    addTextList(container, "執行步驟", data.steps, "ol");
    addTextList(container, "需要留意的風險", data.risks, "ul");
    if (data.next_action) {
      container.appendChild(makeElement("h3", "建議下一步"));
      container.appendChild(makeElement("p", data.next_action));
    }

    const raw = Array.isArray(data.allocation) ? data.allocation : [];
    planAllocation = raw.map((item) => ({
      symbol: String(item?.symbol || "").toUpperCase().trim(),
      amount_usd: Number(item?.amount_usd),
    })).filter((item) => /^[A-Z0-9]{2,12}$/.test(item.symbol)
      && Number.isFinite(item.amount_usd) && item.amount_usd > 0);
    const total = planAllocation.reduce((sum, item) => sum + item.amount_usd, 0);
    if (total > budget) {
      const scale = budget / total;
      planAllocation = planAllocation.map((item) => ({
        ...item, amount_usd: Math.floor(item.amount_usd * scale * 100) / 100,
      })).filter((item) => item.amount_usd > 0);
    }
    if (!planAllocation.length) return;

    container.appendChild(makeElement("h3", "模擬配置預覽"));
    addTable(container, "coach-allocation-table", ["幣種", "預計金額"], planAllocation.map((item) => [
      item.symbol, formatUsd(item.amount_usd),
    ]));
    const confirmArea = makeElement("div", undefined, "coach-confirm-area");
    confirmArea.appendChild(makeElement("p", "教練不會在你確認前下單。確認後會批次建立模擬買單；若帳戶現金不足，系統會按比例縮小金額。"));
    const label = makeElement("label", undefined, "coach-confirm-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    label.appendChild(checkbox);
    label.appendChild(makeElement("span", "我已核對幣種與金額"));
    confirmArea.appendChild(label);
    const button = makeElement("button", "確認建立模擬單", "button primary");
    button.type = "button";
    button.disabled = true;
    checkbox.addEventListener("change", () => { button.disabled = !checkbox.checked || orderPending; });
    button.addEventListener("click", async () => {
      if (!checkbox.checked || orderPending) return;
      orderPending = true;
      button.disabled = true;
      setToolStatus("coachPlanStatus", "模擬單送出中...");
      try {
        const result = await memberRequest("/api/agent-auto-order", {
          method: "POST", body: JSON.stringify({ allocation: planAllocation }),
        });
        checkbox.checked = false;
        button.disabled = true;
        const count = Array.isArray(result.trades) ? result.trades.length : 0;
        setToolStatus("coachPlanStatus", `已建立 ${count} 筆模擬單${result.scaled ? "，金額已依可用現金按比例調整" : ""}。請至模擬資產確認結果。`);
        window.dispatchEvent?.(new Event("smartinvest:sim-trade-updated"));
      } catch (error) {
        setToolStatus("coachPlanStatus", `${error.message || "模擬下單狀態不明。"} 請至模擬資產確認紀錄後再重試。`, true);
        checkbox.checked = false;
      } finally {
        orderPending = false;
      }
    });
    confirmArea.appendChild(button);
    container.appendChild(confirmArea);
  }

  async function submitPlan(event) {
    event.preventDefault();
    const goal = $("coachGoal")?.value.trim() || "";
    const budget = Number($("coachBudget")?.value);
    if (!goal || !Number.isFinite(budget) || budget <= 0) {
      setToolStatus("coachPlanStatus", "請輸入投資任務與大於 0 的 USD 預算。", true);
      return;
    }
    const button = $("coachPlanSubmit");
    if (button?.disabled) return;
    button.disabled = true;
    planAllocation = [];
    const resultEl = $("coachPlanResult");
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
    setToolStatus("coachPlanStatus", "正在整理計畫...");
    try {
      const data = await memberRequest("/api/agent-plan", {
        method: "POST",
        body: JSON.stringify({ goal, profile: $("riskProfile")?.value || "穩健型", budget: String(budget) }),
      });
      renderPlan(data, budget);
      setToolStatus("coachPlanStatus", "請檢查計畫與金額；建議僅供參考。");
    } catch (error) {
      setToolStatus("coachPlanStatus", error.message || "產生計畫失敗。", true);
    } finally {
      button.disabled = false;
    }
  }

  async function refreshPortfolio() {
    const container = $("coachPortfolioContent");
    if (!container) return;
    setToolStatus("coachPortfolioStatus", "正在讀取模擬帳本...");
    try {
      const [portfolioData, tradeData] = await Promise.all([
        memberRequest("/api/sim-trade/portfolio"),
        memberRequest("/api/sim-trade/history?limit=20"),
      ]);
      const portfolio = portfolioData.portfolio || {};
      const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
      const trades = Array.isArray(tradeData.trades) ? tradeData.trades : [];
      container.innerHTML = "";
      const metrics = makeElement("div", undefined, "coach-portfolio-metrics");
      [
        ["總資產", formatUsd(portfolio.total_value_usd)],
        ["可用現金", formatUsd(portfolio.cash)],
        ["模擬損益", formatUsd(portfolio.unrealized_pnl)],
      ].forEach(([label, value]) => {
        const item = document.createElement("div");
        item.appendChild(makeElement("span", label));
        item.appendChild(makeElement("strong", value));
        metrics.appendChild(item);
      });
      container.appendChild(metrics);
      container.appendChild(makeElement("h3", "目前持倉"));
      if (positions.length) {
        addTable(container, "coach-allocation-table", ["幣種", "數量", "市值"], positions.map((item) => [
          item.symbol || "", Number(item.quantity || 0).toLocaleString("zh-TW", { maximumFractionDigits: 8 }), formatUsd(item.market_value),
        ]));
      } else {
        container.appendChild(makeElement("p", "尚無模擬持倉。"));
      }
      container.appendChild(makeElement("h3", "最近模擬交易"));
      if (trades.length) {
        addTable(container, "coach-recent-table", ["方向", "幣種", "金額"], trades.slice(0, 5).map((item) => [
          item.side === "sell" ? "賣出" : "買入", item.symbol || "", formatUsd(item.amount_usd),
        ]));
      } else {
        container.appendChild(makeElement("p", "尚無模擬交易紀錄。"));
      }
      setToolStatus("coachPortfolioStatus", "");
    } catch (error) {
      setToolStatus("coachPortfolioStatus", error.message || "無法讀取模擬帳本。", true);
    }
  }

  function initAgentTools() {
    document.querySelectorAll("[data-coach-view]").forEach((tab) => {
      tab.addEventListener("click", () => activateView(tab.dataset.coachView));
    });
    document.querySelectorAll("[data-plan-example]").forEach((button) => {
      button.addEventListener("click", () => selectPlanExample(button.dataset));
    });
    $("coachPlanForm")?.addEventListener("submit", submitPlan);
    $("coachPortfolioRefresh")?.addEventListener("click", refreshPortfolio);
    window.addEventListener("smartinvest:sim-trade-updated", () => {
      if ($("coachPortfolioView") && !$("coachPortfolioView").hidden) refreshPortfolio();
    });
  }

  function selectPlanExample(example) {
    const goal = $("coachGoal");
    const budget = $("coachBudget");
    if (!goal || !budget) return;
    goal.value = example.planExample || "";
    budget.value = example.planBudget || budget.value;
    activateView("plan");
    goal.focus();
  }

  // ── TASK 04：純函式／渲染測試 hooks ─────────────────────────────────
  if (typeof window !== "undefined") {
    window.aiCoachTestHooks = {
      citationLines,
      hintsFor,
      feedbackVisible,
      nextStepsFor,
      displayableCitationCount,
      appendChatBubble,
      syncMemberState,
      migrateAgentConversation,
      renderPlan,
      refreshPortfolio,
      selectPlanExample,
    };
    window.addEventListener("smartinvest:auth-state", (event) => {
      syncMemberState(Boolean(event?.detail?.isMember));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await window.waitForSmartInvestAuth?.();
    const loggedIn = Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
    if (!loggedIn) {
      setLockedState(true);
    } else {
      setLockedState(false);
    }
    initPageMotion();
    initRiskCards();
    initQuickAsk();
    initChatEvents();
    initAgentTools();
    pageInitialized = true;
    syncMemberState(loggedIn);
  });
})();
