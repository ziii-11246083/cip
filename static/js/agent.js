(function () {
  const chat = document.getElementById("coachChatMessages");
  const form = document.getElementById("coachChatForm");
  const input = document.getElementById("coachMessageInput");
  const mainAvatar = document.getElementById("coachMainAvatar");
  const sessionHint = document.getElementById("agentSessionHint");

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

  let greeted = false;
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

  function parseOrder(text) {
    const normalized = String(text || "").toUpperCase();
    if (!/(下單|買入|買|賣出|賣|模擬)/.test(text)) return null;

    const symbolMatch = normalized.match(/\b(BTC|ETH|SOL|XRP|BNB|DOGE|USDT|USDC)\b/);
    const amountMatch = normalized.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    if (!symbolMatch || !amountMatch) return null;

    const side = /(賣出|賣|SELL)/i.test(text) ? "sell" : "buy";
    return {
      symbol: symbolMatch[1],
      side,
      amount: Math.max(0, Number(amountMatch[1]))
    };
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

  async function placeSimOrder(order) {
    const amountUsd = Math.max(0.01, Number(order.amount || 0) / USD_TO_TWD);
    const data = await request("/api/sim-trade/order", {
      method: "POST",
      body: JSON.stringify({
        symbol: order.symbol,
        side: order.side,
        amount_usd: amountUsd
      })
    });
    window.dispatchEvent(new CustomEvent("smartinvest:sim-trade-updated", { detail: data }));
    return data;
  }

  async function buildReply(message) {
    const order = parseOrder(message);
    if (order) {
      if (!order.amount) return { text: "我有看出你想模擬下單，但金額需要大於 0。可以像這樣輸入：用 5000 TWD 模擬買入 BTC。", card: false };
      const sideText = order.side === "buy" ? "買入" : "賣出";
      const data = await placeSimOrder(order).catch((error) => ({ error: error.message }));
      if (data?.error) {
        return {
          text: `下單失敗：${data.error}`,
          card: false
        };
      }
      await loadSimData().catch(() => null);
      const trade = data?.trade || {};
      const qtyText = trade.quantity ? Number(trade.quantity).toFixed(6) : "--";
      return {
        text: `已幫你建立一筆模擬下單：${sideText} ${order.symbol}，金額 TWD ${formatMoney(order.amount)}，約 ${qtyText} 顆。這筆紀錄已同步到模擬交易帳戶。`,
        card: true
      };
    }

    if (/資金|投放|會員|紀錄/.test(message)) {
      await loadSimData().catch(() => null);
      const total = Number(cachedPortfolio?.total_value_usd || 0);
      const count = Array.isArray(cachedTrades) ? cachedTrades.length : 0;
      return {
        text: `我已讀取會員中心紀錄。目前模擬資產約 TWD ${formatMoneyTwdFromUsd(total)}，共有 ${count} 筆模擬下單。你可以到會員中心或直接叫我用某筆金額模擬買入指定幣種。`,
        card: true
      };
    }

    if (/組合|配置|分析|持倉/.test(message)) {
      await loadSimData().catch(() => null);
      const positions = Array.isArray(cachedPortfolio?.positions) ? cachedPortfolio.positions : [];
      const top = positions
        .map((pos) => ({ symbol: pos.symbol, value: Number(pos.market_value || 0) }))
        .sort((a, b) => b.value - a.value)[0];
      return {
        text: top
          ? `我幫你看了目前的模擬持倉，${top.symbol} 是最大持倉，約 TWD ${formatMoneyTwdFromUsd(top.value)}。若單一幣種比例太高，建議用小額模擬單逐步分散。`
          : "目前尚未建立模擬持倉。你可以先從小額模擬下單開始。",
        card: true
      };
    }

    return {
      text: "我已收到你的問題，正在根據會員資產、模擬持倉與市場狀況做初步判斷。你也可以直接說：「用 5000 TWD 模擬買入 BTC」，我會幫你建立一筆模擬下單。",
      card: false
    };
  }

  function sendMessage(text) {
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
    if (sessionHint) sessionHint.classList.add("is-hidden");
    setMainAvatar("thinking", "is-thinking");
    if (input) {
      input.value = "";
      resizeInput();
    }

    const typingRow = addTypingMessage();
    window.setTimeout(async () => {
      if (typingRow) typingRow.remove();
      setMainAvatar("happy", "is-talking");

      if (!greeted) {
        greeted = true;
        addAiMessage("嗨！我是你的 AI 投資教練。接下來我可以幫你讀取會員資金紀錄、整理模擬持倉，也可以用一句話幫你建立模擬下單。你可以說：用 5000 TWD 模擬買入 BTC。", "happy");
      } else {
        const reply = await buildReply(message);
        addAiMessage(reply.text, reply.card ? "calm" : "happy");
        if (reply.card) addAnalysisCard();
      }

      scheduleAvatarReset(2600);
    }, 900);
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
  refreshAgentSummary().catch(() => {});
  setMainAvatar("neutral", "is-idle");
  startIdleBlink();
})();
