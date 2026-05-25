(function () {
  const chat = document.getElementById("coachChatMessages");
  const form = document.getElementById("coachChatForm");
  const input = document.getElementById("coachMessageInput");
  const mainAvatar = document.getElementById("coachMainAvatar");
  const sessionHint = document.getElementById("agentSessionHint");
  const CONVERSATION_KEY = "smartinvest_ai_agent_conversation_id";
  const messageHistory = [];
  const conversationList = document.getElementById("aiCoachConversationList");
  const newChatBtn = document.getElementById("aiCoachNewChatBtn");
  let conversationCache = [];

  const USD_TO_TWD = 32;

  const avatarStates = {
    neutral: "/static/images/agent-cat-neutral.png",
    happy: "/static/images/agent-cat-happy.png",
    thinking: "/static/images/agent-cat-thinking.png",
    surprised: "/static/images/agent-cat-surprised.png",
    calm: "/static/images/agent-cat-calm.png",
    wink: "/static/images/agent-cat-wink.png",
    sad: "/static/images/agent-cat-sad.png",
    focus: "/static/images/agent-cat-focus.png"
  };

  let idleTimer = null;
  let avatarResetTimer = null;
  let cachedPortfolio = null;
  let cachedTrades = [];

  function nowTime() {
    return new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("zh-TW", {
      maximumFractionDigits: 0
    });
  }

  function formatMoneyTwdFromUsd(valueUsd) {
    return formatMoney(Number(valueUsd || 0) * USD_TO_TWD);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function scrollToBottom() {
    if (!chat) return;
    chat.scrollTop = chat.scrollHeight;
  }

  function setMainAvatar(state, motion) {
    if (!mainAvatar || !avatarStates[state]) return;
    const image = mainAvatar.querySelector("[data-coach-avatar]");
    if (image) image.src = avatarStates[state];

    mainAvatar.classList.remove("is-idle", "is-thinking", "is-talking", "is-pop");
    mainAvatar.classList.add(motion || "is-idle");
  }

  function scheduleAvatarReset(delay = 2400) {
    window.clearTimeout(avatarResetTimer);
    avatarResetTimer = window.setTimeout(() => {
      setMainAvatar("neutral", "is-idle");
    }, delay);
  }

  function startIdleBlink() {
    window.clearInterval(idleTimer);
    idleTimer = window.setInterval(() => {
      if (!mainAvatar || mainAvatar.classList.contains("is-thinking") || mainAvatar.classList.contains("is-talking")) return;
      setMainAvatar("wink", "is-pop");
      scheduleAvatarReset(700);
    }, 7600);
  }

  function avatarHtml(state = "neutral") {
    const src = avatarStates[state] || avatarStates.neutral;
    return `
      <div class="coach-avatar has-image">
        <img data-coach-avatar src="${src}" alt="" onerror="this.style.display='none';">
      </div>
    `;
  }

  function addUserMessage(text) {
    if (!chat) return;
    chat.classList.remove("is-empty");
    chat.insertAdjacentHTML("beforeend", `
      <div class="chat-row user">
        <div class="chat-bubble">
          <p>${escapeHtml(text)}</p>
          <time>${nowTime()}</time>
        </div>
      </div>
    `);
    scrollToBottom();
  }

  function addAiMessage(text, state = "happy") {
    if (!chat) return;
    chat.classList.remove("is-empty");
    chat.insertAdjacentHTML("beforeend", `
      <div class="chat-row ai">
        ${avatarHtml(state)}
        <div class="chat-bubble">
          <p>${escapeHtml(text)}</p>
          <time>${nowTime()}</time>
        </div>
      </div>
    `);
    scrollToBottom();
  }

  function recordMessage(role, content) {
    if (!content) return;
    messageHistory.push({ role, content });
  }

  function renderHistory(rows) {
    if (!chat) return;
    chat.innerHTML = "";
    messageHistory.length = 0;

    rows.forEach((row) => {
      const type = (row.message_type || "").toLowerCase();
      const content = row.content || "";
      if (!content) return;
      if (type === "user") {
        addUserMessage(content);
        recordMessage("user", content);
      } else if (type === "assistant") {
        addAiMessage(content, "calm");
        recordMessage("assistant", content);
      }
    });

    if (rows.length) {
      chat.classList.remove("is-empty");
      if (sessionHint) sessionHint.classList.add("is-hidden");
    }
  }

  function resetChat(showHint = true) {
    if (chat) {
      chat.innerHTML = "";
      chat.classList.add("is-empty");
    }
    messageHistory.length = 0;
    if (sessionHint) {
      sessionHint.classList.toggle("is-hidden", !showHint);
    }
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
      const id = escapeHtml(item.id || "");
      const title = escapeHtml(item.title || "Chat");
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

    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
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
      window.authManager.requireMember?.("AI Agent");
      return;
    }

    localStorage.setItem(CONVERSATION_KEY, conversationId);
    resetChat(false);
    setActiveConversation(conversationId);
    await loadHistory(conversationId);
  }

  function addAnalysisCard() {
    if (!chat) return;
    const positions = Array.isArray(cachedPortfolio?.positions) ? cachedPortfolio.positions : [];
    const trades = Array.isArray(cachedTrades) ? cachedTrades : [];
    const top = positions
      .map((pos) => ({ symbol: pos.symbol, value: Number(pos.market_value || 0) }))
      .sort((a, b) => b.value - a.value)[0];

    chat.insertAdjacentHTML("beforeend", `
      <article class="coach-analysis-card">
        <div>
          <h2><i class="fas fa-magnifying-glass-chart"></i> 組合重點摘要</h2>
          <ul>
            <li>${top ? `${top.symbol} 目前是最大持倉，約 TWD ${formatMoneyTwdFromUsd(top.value)}` : "目前尚未建立持倉，適合先從小額模擬開始"}</li>
            <li>已記錄 ${trades.length} 筆模擬下單，可到會員中心查看完整紀錄</li>
            <li>建議每次下單後觀察資產是否過度集中</li>
          </ul>
          <button class="analysis-link" type="button" onclick="location.href='/member'">查看會員中心 <i class="fas fa-arrow-right"></i></button>
        </div>
        <div class="coach-mini-donut" aria-label="模擬配置圖"></div>
      </article>
    `);
    scrollToBottom();
  }

  function addTypingMessage() {
    if (!chat) return null;
    const id = `typing-${Date.now()}`;
    chat.classList.remove("is-empty");
    chat.insertAdjacentHTML("beforeend", `
      <div class="chat-row ai" id="${id}">
        ${avatarHtml("thinking")}
        <div class="chat-bubble">
          <p>正在分析中<span class="typing-dots"><span></span><span></span><span></span></span></p>
        </div>
      </div>
    `);
    scrollToBottom();
    return document.getElementById(id);
  }

  function resizeInput() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  async function request(url, options) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error(data.error || "請先登入會員。");
    }
    if (!res.ok) throw new Error(data.error || data.detail || "請求失敗");
    return data;
  }

  async function loadHistory(conversationId) {
    const activeId = conversationId || localStorage.getItem(CONVERSATION_KEY) || "";
    if (!activeId) return;

    const token = window.authManager ? await window.authManager.getToken().catch(() => null) : null;
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

  async function loadSimData() {
    if (!window.authManager?.isLoggedIn?.()) {
      cachedPortfolio = null;
      cachedTrades = [];
      return { portfolio: null, trades: [] };
    }
    const [portfolioData, tradeData] = await Promise.all([
      request("/api/sim-trade/portfolio"),
      request("/api/sim-trade/history?limit=50")
    ]);
    cachedPortfolio = portfolioData.portfolio || null;
    cachedTrades = tradeData.trades || [];
    return { portfolio: cachedPortfolio, trades: cachedTrades };
  }
  async function sendMessage(text) {
    if (window.authManager && !window.authManager.isLoggedIn?.()) {
      window.authManager.requireMember?.("AI Agent");
      return;
    }

    const message = String(text || "").trim();
    if (!message) {
      input?.focus();
      return;
    }

    addUserMessage(message);
    recordMessage("user", message);
    if (sessionHint) sessionHint.classList.add("is-hidden");
    setMainAvatar("thinking", "is-thinking");
    if (input) {
      input.value = "";
      resizeInput();
    }

    const typingRow = addTypingMessage();
    try {
      const conversationId = localStorage.getItem(CONVERSATION_KEY) || "";
      const payload = { message, messages: messageHistory };
      if (conversationId) payload.conversation_id = conversationId;

      const data = await request("/api/ai-chat", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (typingRow) typingRow.remove();
      setMainAvatar("happy", "is-talking");

      if (data.conversation_id) {
        localStorage.setItem(CONVERSATION_KEY, data.conversation_id);
        loadConversations();
        setActiveConversation(data.conversation_id);
      }

      const replyText = data.reply || "我收到你的問題了，但目前沒有取得完整回覆。";
      addAiMessage(replyText, "happy");
      recordMessage("assistant", replyText);
    } catch (error) {
      if (typingRow) typingRow.remove();
      setMainAvatar("sad", "is-pop");
      addAiMessage(error?.message || "連線暫時不穩，請稍後再送出一次。", "sad");
    } finally {
      scheduleAvatarReset(2600);
    }
  }

  function renderAgentSummary() {
    const portfolio = cachedPortfolio || {};
    const trades = Array.isArray(cachedTrades) ? cachedTrades : [];
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const totalValueUsd = Number(portfolio.total_value_usd || 0);

    const totalEl = document.getElementById("agentTotalCapital");
    const changeEl = document.getElementById("agentCapitalChange");
    if (totalEl) totalEl.childNodes[0].nodeValue = `${formatMoneyTwdFromUsd(totalValueUsd)} `;
    if (changeEl) changeEl.textContent = trades.length ? `已記錄 ${trades.length} 筆` : "等待紀錄";

    const list = document.getElementById("agentAllocationList");
    if (list) {
      const total = positions.reduce((sum, item) => sum + Number(item.market_value || 0), 0);
      if (!positions.length || !total) {
        list.innerHTML = '<li><span style="--dot:#d8b596"></span>尚未下單 <b>0%</b></li>';
      } else {
        const colors = ["#fb6a10", "#f58a33", "#f7ad74", "#7C9A6D", "#d8b596"];
        list.innerHTML = positions.map((item, index) => {
          const pct = Math.round(Number(item.market_value || 0) / total * 100);
          return `<li><span style="--dot:${colors[index % colors.length]}"></span>${item.symbol} <b>${pct}%</b></li>`;
        }).join("");
      }
    }

    const recent = document.getElementById("agentRecentOrders");
    if (recent) {
      if (!trades.length) {
        recent.innerHTML = '<div class="member-record-empty">尚未有模擬下單紀錄。</div>';
      } else {
        recent.innerHTML = trades.slice(0, 4).map((order) => `
          <div class="agent-order-item">
            <strong>${order.side === "buy" ? "買入" : "賣出"} ${order.symbol}</strong>
            <span>TWD ${formatMoneyTwdFromUsd(order.amount_usd)}</span>
          </div>
        `).join("");
      }
    }
  }

  async function refreshAgentSummary() {
    await loadSimData().catch(() => null);
    renderAgentSummary();
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage(input?.value);
    });
  }

  newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem(CONVERSATION_KEY);
    resetChat(true);
    loadConversations();
  });

  if (input) {
    input.addEventListener("input", resizeInput);
    input.addEventListener("focus", () => {
      setMainAvatar("focus", "is-pop");
      scheduleAvatarReset(1800);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(input.value);
      }
    });
    resizeInput();
  }

  document.querySelectorAll("[data-coach-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-coach-prompt") || "";
      if (input) {
        input.value = prompt;
        resizeInput();
      }
      setMainAvatar("surprised", "is-pop");
      sendMessage(prompt);
    });
  });

  window.addEventListener("smartinvest:sim-trade-updated", () => {
    refreshAgentSummary().catch(() => {});
  });
  loadConversations().catch(() => {});
  loadHistory().catch(() => {});
  refreshAgentSummary().catch(() => {});
  setMainAvatar("neutral", "is-idle");
  startIdleBlink();
})();
