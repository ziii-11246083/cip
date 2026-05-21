(function () {
  const chat = document.getElementById("coachChatMessages");
  const form = document.getElementById("coachChatForm");
  const input = document.getElementById("coachMessageInput");
  const mainAvatar = document.getElementById("coachMainAvatar");
  const sessionHint = document.getElementById("agentSessionHint");

  const STORAGE = {
    capital: "smartinvest_member_capital_records",
    orders: "smartinvest_member_mock_orders",
    holdings: "smartinvest_member_mock_holdings"
  };

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

  const coinPricesTwd = {
    BTC: 3200000,
    ETH: 160000,
    SOL: 7200,
    XRP: 28,
    BNB: 28500,
    DOGE: 5.2,
    USDT: 32,
    USDC: 32
  };

  let greeted = false;
  let idleTimer = null;
  let avatarResetTimer = null;

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "");
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

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
    const holdings = readJson(STORAGE.holdings, {});
    const orders = readJson(STORAGE.orders, []);
    const symbols = Object.keys(holdings);
    const top = symbols
      .map((symbol) => ({ symbol, value: holdings[symbol].amount || 0 }))
      .sort((a, b) => b.value - a.value)[0];

    chat.insertAdjacentHTML("beforeend", `
      <article class="coach-analysis-card">
        <div>
          <h2><i class="fas fa-magnifying-glass-chart"></i> 組合重點摘要</h2>
          <ul>
            <li>${top ? `${top.symbol} 目前是最大持倉，約 TWD ${formatMoney(top.value)}` : "目前尚未建立持倉，適合先從小額模擬開始"}</li>
            <li>已記錄 ${orders.length} 筆模擬下單，可到會員中心查看完整紀錄</li>
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

  function saveMockOrder(order) {
    const price = coinPricesTwd[order.symbol] || 100;
    const quantity = order.amount / price;
    const orders = readJson(STORAGE.orders, []);
    const holdings = readJson(STORAGE.holdings, {});
    const current = holdings[order.symbol] || { symbol: order.symbol, quantity: 0, amount: 0 };

    if (order.side === "buy") {
      current.quantity += quantity;
      current.amount += order.amount;
    } else {
      current.quantity = Math.max(0, current.quantity - quantity);
      current.amount = Math.max(0, current.amount - order.amount);
    }

    if (current.amount <= 0 || current.quantity <= 0) {
      delete holdings[order.symbol];
    } else {
      holdings[order.symbol] = current;
    }

    const saved = {
      id: `order-${Date.now()}`,
      time: new Date().toISOString(),
      symbol: order.symbol,
      side: order.side,
      amount: order.amount,
      price,
      quantity
    };
    orders.unshift(saved);
    writeJson(STORAGE.orders, orders.slice(0, 30));
    writeJson(STORAGE.holdings, holdings);
    renderAgentSummary();
    return saved;
  }

  async function syncOrderToSimTrade(order) {
    const token = await window.authManager?.getToken?.().catch(() => null);
    if (!token) return { synced: false, error: "尚未取得會員 token" };

    const amountUsd = Math.max(0.01, Number(order.amount || 0) / 32);
    const res = await fetch("/api/sim-trade/order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        symbol: order.symbol,
        side: order.side,
        amount_usd: amountUsd
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { synced: false, error: data.error || "同步模擬交易失敗" };
    window.dispatchEvent(new CustomEvent("smartinvest:sim-trade-updated", { detail: data }));
    return { synced: true, data };
  }

  async function buildReply(message) {
    const order = parseOrder(message);
    if (order) {
      if (!order.amount) return { text: "我有看出你想模擬下單，但金額需要大於 0。可以像這樣輸入：用 5000 TWD 模擬買入 BTC。", card: false };
      const saved = saveMockOrder(order);
      const sideText = saved.side === "buy" ? "買入" : "賣出";
      const sync = await syncOrderToSimTrade(saved).catch((error) => ({ synced: false, error: error.message }));
      const syncText = sync.synced ? "也已同步到模擬交易帳戶。" : `已先存到會員中心，但模擬交易同步失敗：${sync.error}`;
      return {
        text: `已幫你建立一筆模擬下單：${sideText} ${saved.symbol}，金額 TWD ${formatMoney(saved.amount)}，約 ${saved.quantity.toFixed(6)} 顆。這筆紀錄已同步到會員中心，${syncText}`,
        card: true
      };
    }

    if (/資金|投放|會員|紀錄/.test(message)) {
      const capital = readJson(STORAGE.capital, []);
      const total = capital.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      return {
        text: `我已讀取會員中心紀錄。目前資金投放合計 TWD ${formatMoney(total)}，共有 ${capital.length} 筆資金紀錄。你可以到會員中心新增資金，或直接叫我用某筆金額模擬買入指定幣種。`,
        card: true
      };
    }

    if (/組合|配置|分析|持倉/.test(message)) {
      return {
        text: "我幫你看了目前的模擬持倉。若單一幣種比例太高，建議用小額模擬單逐步分散，並把每次資金投放與下單理由記在會員中心。",
        card: true
      };
    }

    return {
      text: "我已收到你的問題，正在根據會員資金紀錄、模擬持倉與市場狀況做初步判斷。你也可以直接說：「用 5000 TWD 模擬買入 BTC」，我會幫你建立一筆前端模擬下單紀錄。",
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
    const capital = readJson(STORAGE.capital, []);
    const orders = readJson(STORAGE.orders, []);
    const holdings = readJson(STORAGE.holdings, {});
    const totalCapital = capital.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalHolding = Object.values(holdings).reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const totalEl = document.getElementById("agentTotalCapital");
    const changeEl = document.getElementById("agentCapitalChange");
    if (totalEl) totalEl.childNodes[0].nodeValue = `${formatMoney(totalCapital || totalHolding)} `;
    if (changeEl) changeEl.textContent = totalCapital ? `已投放 ${capital.length} 筆` : "等待紀錄";

    const list = document.getElementById("agentAllocationList");
    if (list) {
      const entries = Object.values(holdings);
      const total = entries.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      if (!entries.length || !total) {
        list.innerHTML = '<li><span style="--dot:#d8b596"></span>尚未下單 <b>0%</b></li>';
      } else {
        const colors = ["#fb6a10", "#f58a33", "#f7ad74", "#7C9A6D", "#d8b596"];
        list.innerHTML = entries.map((item, index) => {
          const pct = Math.round(Number(item.amount || 0) / total * 100);
          return `<li><span style="--dot:${colors[index % colors.length]}"></span>${item.symbol} <b>${pct}%</b></li>`;
        }).join("");
      }
    }

    const recent = document.getElementById("agentRecentOrders");
    if (recent) {
      if (!orders.length) {
        recent.innerHTML = '<div class="member-record-empty">尚未有模擬下單紀錄。</div>';
      } else {
        recent.innerHTML = orders.slice(0, 4).map((order) => `
          <div class="agent-order-item">
            <strong>${order.side === "buy" ? "買入" : "賣出"} ${order.symbol}</strong>
            <span>TWD ${formatMoney(order.amount)}</span>
          </div>
        `).join("");
      }
    }
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

  window.addEventListener("storage", renderAgentSummary);
  renderAgentSummary();
  setMainAvatar("neutral", "is-idle");
  startIdleBlink();
})();
