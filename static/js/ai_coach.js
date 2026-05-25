(function () {
  const $ = (id) => document.getElementById(id);
  const CONVERSATION_KEY = "smartinvest_ai_coach_conversation_id";
  const messageHistory = [];
  const conversationList = $("aiCoachConversationList");
  const newChatBtn = $("aiCoachNewChatBtn");
  let conversationCache = [];

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function appendChatBubble(speaker, text, isUser = false) {
    const stream = $("chatStream");
    if (!stream) return;

    const row = document.createElement("div");
    row.className = `chat-row ${isUser ? "user" : "ai"}`;

    row.innerHTML = `
      <div class="avatar">${isUser ? "你" : "AI"}</div>
      <div class="bubble">
        <b>${escapeHTML(speaker)}</b>
        <p>${escapeHTML(text)}</p>
      </div>
    `;

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
    if (!conversationList) return;
    conversationList.querySelectorAll(".conversation-item").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.id === conversationId);
    });
  }

  function renderConversationList(items) {
    if (!conversationList) return;
    conversationCache = Array.isArray(items) ? items : [];
    const activeId = localStorage.getItem(CONVERSATION_KEY) || "";

    if (!conversationCache.length) {
      conversationList.innerHTML = '<div class="conversation-empty">尚無對話紀錄</div>';
      return;
    }

    conversationList.innerHTML = conversationCache.map((item) => {
      const id = escapeHTML(item.id || "");
      const title = escapeHTML(item.title || "Chat");
      return `
        <button class="conversation-item" type="button" data-id="${id}">
          <span>${title}</span>
        </button>
      `;
    }).join("");

    conversationList.querySelectorAll(".conversation-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id || "";
        selectConversation(id);
      });
    });

    setActiveConversation(activeId);
  }

  async function loadConversations() {
    if (!conversationList) return;
    if (window.authManager && !window.authManager.isLoggedIn?.()) {
      renderConversationList([]);
      return;
    }

    const token = await getAuthToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

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
      appendChatBubble("Smart Invest AI 教練", replyText);
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
      localStorage.removeItem(CONVERSATION_KEY);
      resetChat(true);
      loadConversations();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initPageMotion();
    initRiskCards();
    initQuickAsk();
    initChatEvents();
    loadConversations();
    loadHistory();
  });
})();
