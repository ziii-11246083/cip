(function () {
  const $ = (id) => document.getElementById(id);
  const CONVERSATION_KEY = "smartinvest_ai_coach_conversation_id";
  const messageHistory = [];
  const newChatBtn = $("aiCoachNewChatBtn");
  let conversationCache = [];
  let isLocked = false;
  let pageInitialized = false;
  let memberDataLoaded = false;

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

  function buildFeedbackBar(traceId) {
    if (!feedbackVisible(traceId)) return null;
    const bar = document.createElement("div");
    bar.className = "feedback-bar";
    const label = document.createElement("span");
    label.className = "feedback-label";
    label.textContent = "這個回答有幫助嗎？";
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
      <div class="chat-row ai"><div class="avatar">AI</div><div class="bubble"><b>AI 投資教練</b><p>你好，請問你現在最想解決的投資問題是什麼？</p></div></div>
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

  // ── TASK 04：純函式／渲染測試 hooks ─────────────────────────────────
  if (typeof window !== "undefined") {
    window.aiCoachTestHooks = {
      citationLines,
      hintsFor,
      feedbackVisible,
      displayableCitationCount,
      appendChatBubble,
      syncMemberState,
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
    pageInitialized = true;
    syncMemberState(loggedIn);
  });
})();
