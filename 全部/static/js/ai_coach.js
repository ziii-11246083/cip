(function () {
  const $ = (id) => document.getElementById(id);

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
    inputEl.value = "";
    setSendLoading(true);
    showTypingBubble();

    try {
      const token = await getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text, risk_profile: riskProfile }),
      });

      const data = await res.json().catch(() => ({}));
      removeTypingBubble();

      if (!res.ok) {
        appendChatBubble("系統提醒", data.reply || "目前 AI 教練暫時無法回覆，請稍後再試。");
        return;
      }

      appendChatBubble("Smart Invest AI 教練", data.reply || "我收到你的問題了，但目前沒有取得完整回覆。");
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
  }

  document.addEventListener("DOMContentLoaded", () => {
    initPageMotion();
    initRiskCards();
    initQuickAsk();
    initChatEvents();
  });
})();
