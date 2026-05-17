(function () {
  const chat = document.getElementById("coachChatMessages");
  const form = document.getElementById("coachChatForm");
  const input = document.getElementById("coachMessageInput");
  const mainAvatar = document.getElementById("coachMainAvatar");

  const aiReply = "我已收到你的問題，正在根據市場狀況與投資組合資料進行初步分析。建議你可以先查看風險比例與資產配置是否過度集中。";
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

  function nowTime() {
    return new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
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
    if (motion) {
      mainAvatar.classList.add(motion);
    } else {
      mainAvatar.classList.add("is-idle");
    }
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

  function addAiMessage(text) {
    if (!chat) return;
    chat.insertAdjacentHTML("beforeend", `
      <div class="chat-row ai">
        ${avatarHtml()}
        <div class="chat-bubble">
          <p>${escapeHtml(text)}</p>
          <time>${nowTime()}</time>
        </div>
      </div>
    `);
    scrollToBottom();
  }

  function addTypingMessage() {
    if (!chat) return null;
    const id = `typing-${Date.now()}`;
    chat.insertAdjacentHTML("beforeend", `
      <div class="chat-row ai" id="${id}">
        ${avatarHtml("thinking")}
        <div class="chat-bubble">
          <p>正在分析中… <span class="typing-dots"><span></span><span></span><span></span></span></p>
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

  function sendMessage(text) {
    if (window.authManager && !window.authManager.isLoggedIn?.()) {
      window.authManager.requireMember?.("AI Agent 巡檢報告");
      return;
    }

    const message = String(text || "").trim();
    if (!message) {
      input?.focus();
      return;
    }

    addUserMessage(message);
    setMainAvatar("thinking", "is-thinking");
    if (input) {
      input.value = "";
      resizeInput();
    }

    const typingRow = addTypingMessage();
    window.setTimeout(() => {
      if (typingRow) typingRow.remove();
      setMainAvatar("happy", "is-talking");
      addAiMessage(aiReply);
      scheduleAvatarReset(2600);
    }, 1000);
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage(input?.value);
    });
  }

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

  setMainAvatar("neutral", "is-idle");
  startIdleBlink();
})();
