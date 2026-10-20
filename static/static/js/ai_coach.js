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
  const COACH_AVATAR_SRC = "/static/images/agent-cat-happy.png";

  function createCoachAvatar(isUser = false) {
    const avatar = makeElement("div", undefined, isUser ? "avatar" : "avatar coach-cat");
    if (isUser) avatar.textContent = "你";
    else {
      const image = document.createElement("img");
      image.src = COACH_AVATAR_SRC;
      image.alt = "貓咪投資教練";
      image.width = 52;
      image.height = 52;
      image.decoding = "async";
      avatar.appendChild(image);
    }
    return avatar;
  }

  const MARKET_UP_WORDS = new Set(["上漲", "漲幅", "獲利", "盈利", "停利", "止盈"]);
  const MARKET_DOWN_WORDS = new Set(["下跌", "跌幅", "虧損", "損失", "停損", "止損", "回撤"]);
  const PERCENT_CONTEXT = /上漲|下跌|漲幅|跌幅|獲利|虧損|盈利|損失|停利|停損|止盈|止損|回撤|配置|占比|佔比|比例|部位|預算|資金|權重|倉位|機率|概率|信心|勝率|波動率|年化波動|風險/g;

  function percentageDirection(token, source, offset) {
    if (Number(token.replace(/[%％\s+＋−－]/g, "").replace(/^-/, "")) === 0) return null;
    // Only use the nearest cue in this clause. Allocation and risk percentages
    // stay neutral even when a preceding sentence mentions a gain or loss.
    const prefix = source.slice(0, offset).replace(/`[^`\n]*`/g, "").split(/[，,。；;！？!?\n]/).pop().slice(-48);
    const cues = [...prefix.matchAll(PERCENT_CONTEXT)];
    const cue = cues.length ? cues[cues.length - 1][0] : null;
    const direction = MARKET_UP_WORDS.has(cue) ? "up" : MARKET_DOWN_WORDS.has(cue) ? "down" : null;
    if (cue && !direction) return null;
    const sign = token.trim()[0];
    // A hyphen between percentages is a range separator, not a loss sign.
    const rangeSeparator = /[%％]\s*[*_]*\s*$/.test(prefix) && /[-−－]/.test(sign);
    if (!rangeSeparator && /[-−－]/.test(sign)) return "down";
    if (/[+＋]/.test(sign)) return "up";
    return direction;
  }

  function formatReplyInline(value, contextPrefix = "") {
    const raw = String(value ?? "");
    const source = contextPrefix + raw;
    const highlight = (chunk, offset) => {
      const tokens = /漲跌|上漲|下跌|漲幅|跌幅|獲利|虧損|盈利|損失|停利|停損|止盈|止損|回撤|[+＋\-−－]?\s*\d+(?:\.\d+)?[%％]/g;
      let result = "", cursor = 0;
      for (const match of chunk.matchAll(tokens)) {
        result += escapeHTML(chunk.slice(cursor, match.index));
        const token = match[0];
        const isPercent = /[%％]$/.test(token);
        const direction = isPercent ? percentageDirection(token, source, contextPrefix.length + offset + match.index)
          : token === "漲跌" ? null : MARKET_UP_WORDS.has(token) ? "up" : "down";
        const escaped = escapeHTML(token);
        result += direction ? `<span class="coach-market-${direction}${isPercent ? " coach-market-number" : ""}">${escaped}</span>` : escaped;
        cursor = match.index + token.length;
      }
      return result + escapeHTML(chunk.slice(cursor));
    };
    // Tokenize Markdown before adding spans, so code and untrusted HTML remain
    // literal text and emphasis cannot break the generated markup.
    let result = "", cursor = 0;
    for (const match of raw.matchAll(/`[^`\n]+`|\*\*[^*\n]+\*\*/g)) {
      result += highlight(raw.slice(cursor, match.index), cursor);
      if (match[0].startsWith("`")) result += `<code>${escapeHTML(match[0].slice(1, -1))}</code>`;
      else result += `<strong>${highlight(match[0].slice(2, -2), match.index + 2)}</strong>`;
      cursor = match.index + match[0].length;
    }
    return result + highlight(raw.slice(cursor), cursor);
  }

  function renderFormattedReply(text) {
    const block = makeElement("div", undefined, "coach-reply-content");
    const inline = value => formatReplyInline(value);
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [], list = null, code = null;
    const flush = () => {
      if (paragraph.length) {
        const p = document.createElement("p");
        p.innerHTML = paragraph.map(inline).join("<br>");
        block.appendChild(p);
        paragraph = [];
      }
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("```")) {
        flush();
        if (code) { block.appendChild(code); code = null; }
        else code = makeElement("pre", "");
        continue;
      }
      if (code) { code.textContent += lines[i] + "\n"; continue; }
      if (!line) { flush(); continue; }
      if (/^\|?.+\|/.test(line) && /^\|?\s*:?-{3,}/.test((lines[i+1] || "").trim())) {
        flush();
        const cells = raw => raw.trim().replace(/^\||\|$/g, "").split("|").map(value => value.trim());
        const headers = cells(line), rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        i--;
        const wrap = makeElement("div", undefined, "table-wrap");
        addTable(wrap, "coach-reply-table", headers, rows, (value, column) => formatReplyInline(value, `${headers[column] || ""}：`));
        block.appendChild(wrap);
        continue;
      }
      if (/^#{1,6}\s+/.test(line) || /^\*\*[^*]+\*\*[:：]?$/.test(line)) {
        flush();
        const heading = document.createElement("h3");
        heading.innerHTML = inline(line.replace(/^#{1,6}\s+/, ""));
        block.appendChild(heading);
        continue;
      }
      const item = line.match(/^(?:[-*•]\s+|\d+[.)、]\s*)(.+)$/);
      if (item) {
        if (paragraph.length) flush();
        const tag = /^\d/.test(line) ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag); block.appendChild(list);
        }
        const li = document.createElement("li"); li.innerHTML = inline(item[1]); list.appendChild(li);
      } else {
        if (list) flush();
        paragraph.push(line);
      }
    }
    flush();
    if (code) block.appendChild(code);
    return block;
  }

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
    const isMember = Boolean(loggedIn) && Boolean(window.authManager?.hasPremiumAccess?.() ?? (window.authManager?.getMembershipTier?.() === "premium"));
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
      steps.push("使用下方回饋，告訴教練這次回答是否有幫助。");
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

    const avatar = createCoachAvatar(isUser);
    if ($("coachStartGuide")) $("coachStartGuide").hidden = true;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const nameEl = document.createElement("b");
    nameEl.textContent = speaker;
    const textEl = isUser ? makeElement("p", text) : renderFormattedReply(text);
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
    if (!rows.length) { renderDefaultWelcome(); return; }

    rows.forEach((row) => {
      const type = (row.message_type || "").toLowerCase();
      const content = row.content || "";
      if (!content) return;
      if (type === "user") {
        appendChatBubble("你", content, true);
        recordMessage("user", content);
      } else if (type === "assistant") {
        appendChatBubble("AI 投資教練", content, false);
        recordMessage("assistant", content);
      }
    });
  }

  function renderDefaultWelcome() {
    const stream = $("chatStream");
    if (!stream) return;
    stream.innerHTML = `
      <div class="chat-row ai welcome-row"><div class="avatar coach-cat"><img src="${COACH_AVATAR_SRC}" alt="貓咪投資教練" width="52" height="52"></div><div class="bubble"><b>AI 投資教練</b><p>你好，請問你現在最想解決的投資問題是什麼？例如「BTC 目前占比太高怎麼辦？」或「買入前該檢查哪些風險？」</p></div></div>
    `;
    if ($("coachStartGuide")) $("coachStartGuide").hidden = false;
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
      <div class="avatar coach-cat"><img src="${COACH_AVATAR_SRC}" alt="貓咪投資教練" width="52" height="52"></div>
      <div class="typingBubble" role="status" aria-label="教練正在整理回覆">
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
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
    if (newChatBtn) newChatBtn.disabled = isLoading;
    document.querySelectorAll(".risk-card, #coachMobileRisk, [data-question]").forEach(el => { el.disabled = isLoading; });
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
    const cards = Array.from(document.querySelectorAll(".risk-card"));
    const update = value => {
      if ($("riskProfile")) $("riskProfile").value = value;
      if ($("coachRiskLabel")) $("coachRiskLabel").textContent = value;
      if ($("coachMobileRisk")) $("coachMobileRisk").value = value;
      cards.forEach(card => {
        const selected = card.dataset.risk === value;
        card.classList.toggle("active", selected);
        card.setAttribute("aria-checked", String(selected));
        card.tabIndex = selected ? 0 : -1;
      });
    };
    cards.forEach((card, index) => {
      card.addEventListener("click", () => {
        update(card.dataset.risk || "穩健型");
      });
      card.addEventListener("keydown", event => {
        let next = index;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % cards.length;
        else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + cards.length) % cards.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = cards.length - 1;
        else return;
        event.preventDefault();
        update(cards[next].dataset.risk);
        cards[next].focus();
      });
    });
    $("coachMobileRisk")?.addEventListener("change", event => update(event.target.value));
    update($("riskProfile")?.value || "穩健型");
  }

  function initQuickAsk() {
    const input = $("chatInput");
    document.querySelectorAll(".quick-list [data-question], .quick-prompts [data-question], .chat-suggestions [data-question]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!input || $("btnSend")?.disabled) return;
        activateView("chat");
        input.value = btn.dataset.question || "";
        input.focus();
      });
    });
  }

  async function getAuthToken() {
    try {
      if (window.authManager?.getMembershipTier?.() !== "premium") return null;
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
        appendChatBubble("系統提醒", data.reply || "目前 AI 投資教練暫時無法回覆，請稍後再試。");
        return;
      }

      if (data.conversation_id) {
        localStorage.setItem(CONVERSATION_KEY, data.conversation_id);
        loadConversations();
        setActiveConversation(data.conversation_id);
      }
      const replyText = data.reply || "我收到你的問題了，但目前沒有取得完整回覆。";
      appendChatBubble("AI 投資教練", replyText, false, {
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
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
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
    return "USD " + (Number(value) || 0).toLocaleString("zh-TW", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  function coachPurchaseKey() {
    const user = window.authManager?.getUserId?.() || window.smartInvestMembership?.userId;
    return user ? `smartinvest_coach_purchases:${user}` : null;
  }

  function readCoachPurchases(key = coachPurchaseKey()) {
    if (!key) return [];
    try {
      const data = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(data) ? data.filter(item => item.side === "buy" && item.quantity > 0 && item.price > 0 && item.amount_usd > 0 && /^[A-Z0-9]{2,12}$/.test(item.symbol)) : [];
    } catch { return []; }
  }

  function saveCoachPurchases(trades, key) {
    if (!key) return false;
    const rows = trades.filter(item => item.side === "buy" && Number(item.quantity) > 0 && Number(item.price) > 0 && /^[A-Z0-9]{2,12}$/.test(String(item.symbol || ""))).map(item => ({
      timestamp: item.timestamp || item.executed_at || new Date().toISOString(),
      symbol: item.symbol, side:"buy", price:Number(item.price), quantity:Number(item.quantity),
      amount_usd:Number(item.amount_usd) || Number(item.quantity) * Number(item.price),
    }));
    if (!rows.length) return false;
    const existing = readCoachPurchases(key);
    const signature = item => `${item.timestamp}|${item.symbol}|${item.price}|${item.quantity}`;
    const records = new Map(existing.map(item => [signature(item), item]));
    rows.forEach(item => records.set(signature(item), item));
    try { localStorage.setItem(key, JSON.stringify(Array.from(records.values()))); return true; }
    catch { return false; }
  }

  function showPurchaseSuccess(trades, tracked) {
    $("coachPurchaseSuccess")?.remove();
    const dialog = makeElement("dialog", undefined, "coach-success-dialog");
    dialog.id = "coachPurchaseSuccess";
    dialog.setAttribute("aria-labelledby", "coachSuccessTitle");
    dialog.appendChild(makeElement("span", "✓", "coach-success-icon"));
    const title = makeElement("h2", "模擬買入成功"); title.id = "coachSuccessTitle"; dialog.appendChild(title);
    const total = trades.reduce((sum, item) => sum + (Number(item.amount_usd) || Number(item.quantity) * Number(item.price)), 0);
    dialog.appendChild(makeElement("p", `已成交 ${trades.length} 筆 · ${formatUsd(total)}`));
    const actions = makeElement("div", undefined, "coach-success-actions");
    const review = makeElement("button", tracked ? "查看教練成效" : "查看模擬持倉", "button primary");
    review.type = "button";
    review.addEventListener("click", () => { dialog.close(); activateView(tracked ? "performance" : "portfolio"); });
    const done = makeElement("button", "完成", "button"); done.type = "button";
    done.addEventListener("click", () => dialog.close());
    actions.append(review, done); dialog.appendChild(actions);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }

  let performanceRequestVersion = 0;
  async function refreshCoachPerformance() {
    const container = $("coachPerformanceContent");
    if (!container) return;
    const version = ++performanceRequestVersion;
    const key = coachPurchaseKey();
    const records = readCoachPurchases(key).sort((a,b) => (window.SIFormat.date(b.timestamp)?.getTime() || 0) - (window.SIFormat.date(a.timestamp)?.getTime() || 0));
    container.replaceChildren();
    if (!records.length) {
      setToolStatus("coachPerformanceStatus", "尚無教練買入紀錄。透過「規劃買入」確認成交後，即可開始追蹤。");
      return;
    }
    setToolStatus("coachPerformanceStatus", "正在更新報價…");
    const symbols = Array.from(new Set(records.map(item => item.symbol)));
    const quotes = await Promise.all(symbols.map(async symbol => {
      try {
        const response = await fetch(`/crypto/quote?symbol=${encodeURIComponent(symbol)}`);
        const data = await response.json();
        const price = Number(data.current_price);
        return [symbol, response.ok && Number.isFinite(price) && price > 0 ? price : null];
      } catch { return [symbol,null]; }
    }));
    if (version !== performanceRequestVersion || key !== coachPurchaseKey()) return;
    const prices = new Map(quotes), unavailable = quotes.some(([,price]) => price === null);
    const cost = records.reduce((sum, item) => sum + Number(item.amount_usd), 0);
    const value = records.reduce((sum, item) => sum + Number(item.quantity) * (prices.get(item.symbol) || 0), 0);
    const difference = value - cost, pct = cost ? difference / cost * 100 : 0;
    const metrics = makeElement("div", undefined, "coach-performance-metrics");
    [["已確認買入", `${records.length} 筆`], ["買入成本", formatUsd(cost)], ["按原數量估值", unavailable ? "--" : formatUsd(value)], ["價格表現", unavailable ? "--" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`]].forEach(([label,number]) => {
      const item = makeElement("div"); item.append(makeElement("span", label), makeElement("strong", number, "numeric")); metrics.appendChild(item);
    });
    container.appendChild(metrics);
    const banner = makeElement("div", undefined, "coach-performance-total");
    banner.append(makeElement("span", "按原數量估算價差"), makeElement("strong", unavailable ? "暫無完整報價" : `${difference >= 0 ? "+" : ""}${formatUsd(difference)}`, "numeric")); container.appendChild(banner);
    container.appendChild(makeElement("p", "即使後續賣出，此處仍按原買入數量追蹤價格變化；不含後續交易、手續費或已實現損益。", "section-copy"));
    const wrap = makeElement("div", undefined, "table-wrap");
    addTable(wrap, "coach-performance-table", ["買入時間（台北）", "幣種", "數量", "買入價格（USD）", "目前價格（USD）", "漲跌幅"], records.map(item => {
      const price = prices.get(item.symbol), change = (price / item.price - 1) * 100;
      return [window.SIFormat.dateText(item.timestamp), item.symbol, window.SIFormat.quantity(item.quantity), formatUsd(item.price), price === null ? "--" : formatUsd(price), price === null ? "--" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`];
    }));
    container.appendChild(wrap);
    setToolStatus("coachPerformanceStatus", unavailable ? "部分幣種暫無報價，總估值與價格表現暫不計算。" : `報價更新：${window.SIFormat.dateText(new Date().toISOString())}`);
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
    for (const name of ["chat", "plan", "portfolio", "performance"]) {
      const selected = name === view;
      const tab = $({ chat: "coachTabChat", plan: "coachTabPlan", portfolio: "coachTabPortfolio", performance:"coachTabPerformance" }[name]);
      const panel = $({ chat: "coachChatView", plan: "coachPlanView", portfolio: "coachPortfolioView", performance:"coachPerformanceView" }[name]);
      tab?.classList.toggle("active", selected);
      tab?.setAttribute("aria-selected", String(selected));
      if (tab) tab.tabIndex = selected ? 0 : -1;
      if (panel) panel.hidden = !selected;
    }
    if (view === "portfolio") refreshPortfolio();
    if (view === "performance") refreshCoachPerformance();
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

  function addTable(parent, className, headers, rows, formatCell = null) {
    const table = makeElement("table", undefined, className);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((label) => headRow.appendChild(makeElement("th", label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    rows.forEach((values) => {
      const row = document.createElement("tr");
      values.forEach((value, column) => {
        const cell = makeElement("td", value);
        if (formatCell) cell.innerHTML = formatCell(value, column);
        row.appendChild(cell);
      });
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
    container.appendChild(makeElement("h2", "配置預覽"));
    const explanation = makeElement("details", undefined, "coach-plan-details");
    explanation.appendChild(makeElement("summary", "完整解說與明細"));
    if (data.summary) explanation.appendChild(renderFormattedReply(data.summary));
    addTextList(explanation, "執行步驟", data.steps, "ol");
    if (data.next_action) {
      explanation.appendChild(makeElement("h3", "建議下一步"));
      explanation.appendChild(makeElement("p", data.next_action));
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
    if (!planAllocation.length) {
      container.appendChild(makeElement("p", "目前沒有有效的模擬配置，請調整目標或預算。"));
      explanation.open = true;
      container.appendChild(explanation);
      addTextList(container, "風險提醒", data.risks, "ul");
      return;
    }

    const plannedTotal = planAllocation.reduce((sum,item)=>sum+item.amount_usd,0);
    const colors = ["#ef7d2d", "#4b8278", "#b5bf8a", "#dfb360", "#bd7d59"];
    const graphic = makeElement("section", undefined, "coach-allocation-visual");
    const graphicHeading = makeElement("div", undefined, "coach-allocation-heading");
    graphicHeading.appendChild(makeElement("strong", "計畫內配置比例"));
    graphicHeading.appendChild(makeElement("small", "合計 " + formatUsd(plannedTotal)));
    graphic.appendChild(graphicHeading);
    const stack = makeElement("div", undefined, "coach-allocation-stack");
    stack.setAttribute("role", "img");
    stack.setAttribute("aria-label", "計畫內各幣種比例，完整比例與金額列於下方");
    const allocationRows = makeElement("div", undefined, "coach-allocation-rows");
    planAllocation.forEach((item,index)=>{
      const ratio = item.amount_usd/plannedTotal*100;
      const color = colors[index%colors.length];
      const segment = makeElement("div");
      segment.style.width = ratio + "%";
      segment.style.backgroundColor = color;
      stack.appendChild(segment);
      const row = makeElement("div", undefined, "coach-allocation-row");
      const label = makeElement("div");
      const dot = makeElement("i", undefined, "coach-allocation-dot");
      dot.style.backgroundColor = color;
      dot.setAttribute("aria-hidden", "true");
      label.appendChild(dot);
      label.appendChild(makeElement("b", item.symbol));
      row.appendChild(label);
      row.appendChild(makeElement("b", ratio.toFixed(1) + "%"));
      row.appendChild(makeElement("strong", formatUsd(item.amount_usd)));
      allocationRows.appendChild(row);
    });
    graphic.appendChild(stack);
    graphic.appendChild(allocationRows);
    graphic.appendChild(makeElement("small", `以計畫內金額為 100% · 預算餘額 ${formatUsd(Math.max(0,budget-plannedTotal))}`, "coach-allocation-note"));
    container.appendChild(graphic);
    addTextList(container, "風險提醒", data.risks, "ul");
    addTable(explanation, "coach-allocation-table", ["幣種", "預計金額"], planAllocation.map((item) => [
      item.symbol, formatUsd(item.amount_usd),
    ]));
    container.appendChild(explanation);
    const confirmArea = makeElement("div", undefined, "coach-confirm-area");
    confirmArea.appendChild(makeElement("p", "確認後才會模擬買入；現金不足時，金額會按比例縮小。"));
    const label = makeElement("label", undefined, "coach-confirm-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    label.appendChild(checkbox);
    label.appendChild(makeElement("span", "我已核對幣種與金額"));
    confirmArea.appendChild(label);
    let completed = false;
    const button = makeElement("button", "確認模擬買入", "button primary");
    button.type = "button";
    button.disabled = true;
    checkbox.addEventListener("change", () => { button.disabled = completed || !checkbox.checked || orderPending; });
    button.addEventListener("click", async () => {
      if (completed || !checkbox.checked || orderPending) return;
      const trackingKey = coachPurchaseKey();
      orderPending = true;
      button.disabled = true;
      setToolStatus("coachPlanStatus", "模擬單送出中...");
      try {
        const result = await memberRequest("/api/agent-auto-order", {
          method: "POST", body: JSON.stringify({ allocation: planAllocation }),
        });
        if (!result.success || !Array.isArray(result.trades) || !result.trades.length) throw new Error("未取得成交確認。");
        completed = true;
        checkbox.checked = false;
        checkbox.disabled = true;
        button.disabled = true;
        button.textContent = "已模擬買入";
        const count = Array.isArray(result.trades) ? result.trades.length : 0;
        const tracked = saveCoachPurchases(result.trades, trackingKey);
        if (trackingKey !== coachPurchaseKey()) return;
        setToolStatus("coachPlanStatus", `已模擬買入 ${count} 筆${result.scaled ? "，金額已依可用現金調整" : ""}。${tracked ? "已加入教練成效。" : "此瀏覽器未能保存成效紀錄，成交結果仍可在交易紀錄查看。"}`);
        showPurchaseSuccess(result.trades, tracked);
        window.dispatchEvent?.(new Event("smartinvest:sim-trade-updated"));
      } catch (error) {
        setToolStatus("coachPlanStatus", `${error.message || "模擬下單狀態不明。"} 請至模擬持倉確認紀錄後再重試。`, true);
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
      setToolStatus("coachPlanStatus", "配置已產生，請核對比例與金額。");
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
      const holdingHead = makeElement("div", undefined, "coach-holding-head");
      holdingHead.appendChild(makeElement("h3", "目前持倉與損益"));
      holdingHead.appendChild(makeElement("span", "選擇比例即可準備賣單"));
      container.appendChild(holdingHead);
      if (positions.length) {
        const grid = makeElement("div", undefined, "coach-position-grid");
        positions.forEach((item) => {
          const symbol = String(item.symbol || "").toUpperCase();
          const quantity = Number(item.quantity || 0);
          const avgPrice = Number(item.avg_price || 0);
          const currentPrice = Number(item.current_price || 0);
          const priceAvailable = currentPrice > 0 && !portfolio.price_unavailable_symbols?.includes(symbol);
          const pnl = Number(item.unrealized_pnl || 0);
          const changePct = avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
          const card = makeElement("article", undefined, `coach-position-card ${priceAvailable ? (changePct >= 0 ? "gain" : "loss") : "unavailable"}`);
          const top = makeElement("div", undefined, "coach-position-top");
          top.innerHTML = `<span class="coach-coin-mark">${escapeHTML(symbol.slice(0, 1))}</span><span><strong>${escapeHTML(symbol)}</strong><small>${window.SIFormat.quantity(quantity)} 顆</small></span><em class="numeric">${priceAvailable ? `<i class="fas fa-arrow-${changePct >= 0 ? "trend-up" : "trend-down"}"></i> ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "暫無報價"}</em>`;
          card.appendChild(top);
          const values = makeElement("div", undefined, "coach-position-values");
          values.innerHTML = `<span><small>買入均價</small><strong>${escapeHTML(formatUsd(avgPrice))}</strong></span><span><small>目前價格</small><strong>${priceAvailable ? escapeHTML(formatUsd(currentPrice)) : "--"}</strong></span><span><small>未實現損益</small><strong>${priceAvailable ? `${pnl >= 0 ? "+" : ""}${escapeHTML(formatUsd(pnl))}` : "--"}</strong></span>`;
          card.appendChild(values);
          const actions = makeElement("div", undefined, "coach-sell-actions");
          actions.appendChild(makeElement("span", "準備賣出"));
          [25, 50, 100].forEach((percent) => {
            const action = makeElement("button", percent === 100 ? "全部" : `${percent}%`);
            action.type = "button";
            action.disabled = !priceAvailable;
            if (!priceAvailable) action.title = "取得目前報價後才可準備賣單";
            action.addEventListener("click", () => showSellTicket(card, item, percent));
            actions.appendChild(action);
          });
          card.appendChild(actions);
          grid.appendChild(card);
        });
        container.appendChild(grid);
      } else {
        const empty = makeElement("div", undefined, "coach-position-empty");
        empty.innerHTML = '<i class="fas fa-wallet"></i><strong>尚無模擬持倉</strong><span>先建立模擬買單，這裡就能查看漲跌並賣出。</span>';
        container.appendChild(empty);
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

  function showSellTicket(card, position, percent) {
    document.querySelectorAll(".coach-sell-ticket").forEach((item) => item.remove());
    const symbol = String(position?.symbol || "").toUpperCase();
    const holdingQty = Number(position?.quantity || 0);
    const quantity = percent === 100 ? holdingQty : holdingQty * percent / 100;
    const currentPrice = Number(position?.current_price || 0);
    if (!symbol || quantity <= 0) return;

    const ticket = makeElement("div", undefined, "coach-sell-ticket");
    const title = makeElement("div", undefined, "coach-sell-ticket-head");
    title.innerHTML = `<span><i class="fas fa-arrow-up-from-bracket"></i> 賣出 ${escapeHTML(symbol)}</span><strong>${percent === 100 ? "全部持倉" : `${percent}% 持倉`}</strong>`;
    ticket.appendChild(title);
    const summary = makeElement("div", undefined, "coach-sell-summary");
    summary.innerHTML = `<span><small>賣出數量</small><strong>${window.SIFormat.quantity(quantity)}</strong></span><span><small>預估回收</small><strong>${escapeHTML(formatUsd(quantity * currentPrice))}</strong></span>`;
    ticket.appendChild(summary);
    const checkLabel = makeElement("label", undefined, "coach-confirm-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkLabel.appendChild(checkbox);
    checkLabel.appendChild(makeElement("span", "我已確認幣種、數量與模擬市價"));
    ticket.appendChild(checkLabel);
    const controls = makeElement("div", undefined, "coach-sell-ticket-controls");
    const cancel = makeElement("button", "取消", "button");
    cancel.type = "button";
    cancel.addEventListener("click", () => ticket.remove());
    const submit = makeElement("button", `確認賣出 ${symbol}`, "button primary");
    submit.type = "button";
    submit.disabled = true;
    checkbox.addEventListener("change", () => { submit.disabled = !checkbox.checked || orderPending; });
    submit.addEventListener("click", async () => {
      if (!checkbox.checked || orderPending) return;
      orderPending = true;
      submit.disabled = true;
      setToolStatus("coachPortfolioStatus", `正在建立 ${symbol} 模擬賣單...`);
      try {
        await memberRequest("/api/sim-trade/order", {
          method: "POST",
          body: JSON.stringify({ symbol, side: "sell", quantity, amount_usd: null }),
        });
        setToolStatus("coachPortfolioStatus", `${symbol} 已完成模擬賣出，持倉與現金已更新。`);
        window.dispatchEvent?.(new Event("smartinvest:sim-trade-updated"));
        await refreshPortfolio();
      } catch (error) {
        setToolStatus("coachPortfolioStatus", error.message || "模擬賣出失敗。", true);
        submit.disabled = false;
      } finally {
        orderPending = false;
      }
    });
    controls.appendChild(cancel);
    controls.appendChild(submit);
    ticket.appendChild(controls);
    card.appendChild(ticket);
    ticket.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function initAgentTools() {
    window.addEventListener("smartinvest:auth-state", () => {
      performanceRequestVersion++;
      $("coachPerformanceContent")?.replaceChildren();
      $("coachPurchaseSuccess")?.remove();
      if (!$("coachPerformanceView")?.hidden) refreshCoachPerformance();
    });
    document.querySelectorAll("[data-coach-view]").forEach((tab) => {
      tab.addEventListener("click", () => activateView(tab.dataset.coachView));
      tab.tabIndex = tab.classList.contains("active") ? 0 : -1;
      tab.addEventListener("keydown", event => {
        const tabs = Array.from(document.querySelectorAll("[data-coach-view]"));
        const index = tabs.indexOf(tab);
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        activateView(tabs[next].dataset.coachView);
        tabs[next].focus();
      });
    });
    document.querySelectorAll("[data-plan-example]").forEach((button) => {
      button.addEventListener("click", () => selectPlanExample(button.dataset));
    });
    document.querySelectorAll("[data-coach-view-target]").forEach((button) => {
      button.addEventListener("click", () => activateView(button.dataset.coachViewTarget));
    });
    $("coachPlanForm")?.addEventListener("submit", submitPlan);
    $("coachPortfolioRefresh")?.addEventListener("click", refreshPortfolio);
    $("coachPerformanceRefresh")?.addEventListener("click", refreshCoachPerformance);
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
      formatReplyInline,
      renderFormattedReply,
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
