/**
 * Podcast Page Logic - Fixed Version
 * 修正重點：
 * 1. 生成後會自動把 audio_url 放進 <audio> 播放器
 * 2. 固定 Nova / Onyx / 1.0x，使用者只需要選節目主題
 * 3. 補上「複製文字稿」按鈕
 * 4. payload 會送 hostVoice、analystVoice、speed
 * 5. 避免 API 失敗時整頁沒有反應
 */
const showPodcastToast = function(title, msg) {
    if (typeof window.toast === "function") {
        window.toast(title, msg);
        return;
    }
    const el = document.getElementById("toast");
    const titleEl = document.getElementById("toastT");
    const msgEl = document.getElementById("toastM");
    if (!el || !titleEl || !msgEl) return;
    titleEl.textContent = title;
    msgEl.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = "none"; }, 3600);
};

function $(id) {
    return document.getElementById(id);
}

function setButtonLoading(btn, loadingText) {
    if (!btn) return;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = loadingText || '<i class="fas fa-spinner fa-spin"></i> 處理中...';
    btn.classList.add("loading");
}

function resetButtonLoading(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    btn.classList.remove("loading");
}

function setStudioGenerating(isGenerating) {
    const card = $("podcastStudioCard");
    const market = $("podMarket");
    if (card) card.classList.toggle("is-generating", Boolean(isGenerating));
    if (market) market.disabled = Boolean(isGenerating);
    document.querySelectorAll("[data-podcast-topic]").forEach(button => { button.disabled = Boolean(isGenerating); });
}

let popularCoinsCache = [];
const TOPIC_WATCHLISTS = {
    PERSONAL: ["BTC", "ETH", "SOL"],
    CRYPTO: ["BTC", "ETH", "SOL"],
    ALT: ["SOL", "XRP", "DOGE", "BNB"],
    BTC: ["BTC", "ETH"],
    RISK: ["BTC", "ETH", "USDT"]
};
let selectedSymbols = TOPIC_WATCHLISTS.CRYPTO.slice();
let podcastLines = [];
let bubbleTimer = null;
let bubbleIndex = 0;
let bubbleTimeline = [];
let renderedLineCount = 0;
let hasAudioSync = false;
let latestScript = "";
let latestAudioUrl = "";
let browserVoiceActive = false;
let browserVoicePaused = false;
let browserVoiceRun = 0;
let browserVoiceContinuation = null;
let browserVoiceStatus = "正在使用瀏覽器朗讀。";
let podcastState = "idle";

const player = $("player");

function setPodcastState(state) {
    podcastState = state;
    document.body.dataset.podcastState = state;
    const labels = {idle:"等待生成",generating:"正在製作",ready:"可以播放",playing:"播放中",paused:"已暫停",ended:"播放完畢",error:"請重新生成"};
    if ($("podcastState")) $("podcastState").textContent = labels[state] || labels.idle;
    if ($("podcastDialogueStatus")) $("podcastDialogueStatus").textContent = state === "idle" ? "等待你的第一集" : labels[state];
    const ready = Boolean(podcastLines.length || latestScript);
    const playing = state === "playing";
    const generating = state === "generating";
    if ($("btnPodcastPlay")) $("btnPodcastPlay").disabled = !ready || generating || playing;
    if ($("btnPodcastPause")) $("btnPodcastPause").disabled = !playing;
    if ($("btnCopyScript")) $("btnCopyScript").disabled = !ready || generating;
    const dock = $("btnPodcastDockPlay");
    if (dock) {
        dock.disabled = !ready || generating;
        dock.setAttribute("aria-label", playing ? "暫停節目" : "播放節目");
        dock.innerHTML = `<i class="fas fa-${playing ? "pause" : "play"}" aria-hidden="true"></i>`;
    }
    const seekable = !generating && Number.isFinite(player?.duration) && player.duration > 0 && Boolean(player?.getAttribute("src"));
    ["podcastSeek", "btnPodcastBack", "btnPodcastForward"].forEach(id => { if ($(id)) $(id).disabled = !seekable; });
}

async function fetchPersonalPortfolioSummary() {
    const token = await window.authManager?.getToken?.().catch(() => null);
    if (!token) return null;

    try {
        const res = await fetch("/api/sim-trade/portfolio", {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const snapshot = (await res.json()).portfolio || null;
        if (!snapshot) return null;
        return {
            total_value_usd: Number(snapshot.total_value_usd || 0),
            cash: Number(snapshot.cash || 0),
            positions: (snapshot.positions || []).slice(0, 6).map((pos) => ({
                symbol: pos.symbol,
                quantity: Number(pos.quantity || 0),
                market_value: Number(pos.market_value || 0)
            }))
        };
    } catch (error) {
        console.warn("portfolio summary unavailable", error);
        return null;
    }
}

function coinAvatar(symbol) {
    const map = {
        BTC: "₿", ETH: "Ξ", SOL: "S", XRP: "X", DOGE: "Ð", BNB: "B",
        ADA: "A", TRX: "T", AVAX: "A", LINK: "L", DOT: "D", MATIC: "M", USDC: "U"
    };
    return map[symbol] || symbol.slice(0, 1);
}

function normalizeCoinList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(c => ({
            symbol: String(c.symbol || c.ticker || "").toUpperCase(),
            name: c.name || c.id || ""
        }))
        .filter(c => c.symbol);
}

async function fetchPopularCoins(perPage = 18) {
    try {
        const res = await fetch(`/crypto/popular?vs_currency=usd&per_page=${perPage}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return normalizeCoinList(await res.json());
    } catch (e) {
        console.warn("fetchPopularCoins failed:", e);
        return [];
    }
}

async function loadPopularCoins(btn = null) {
    try {
        if (btn) setButtonLoading(btn, '<i class="fas fa-rotate-right fa-spin"></i> 更新中');
        const coins = await fetchPopularCoins(18);
        popularCoinsCache = coins;
        renderCoinBubbles();
        if (btn) showPodcastToast("已更新", "熱門幣種清單已重新整理");
    } finally {
        if (btn) resetButtonLoading(btn);
    }
}

function renderCoinBubbles() {
    const wrap = $("coinBubbleOptions");
    if (!wrap) return;

    const fallback = [
        { symbol: "BTC", name: "Bitcoin" },
        { symbol: "ETH", name: "Ethereum" },
        { symbol: "SOL", name: "Solana" },
        { symbol: "XRP", name: "Ripple" },
        { symbol: "DOGE", name: "Dogecoin" },
        { symbol: "BNB", name: "BNB" }
    ];
    const coins = popularCoinsCache.length ? popularCoinsCache.slice(0, 12) : fallback;

    wrap.innerHTML = coins.map(coin => {
        const symbol = coin.symbol.toUpperCase();
        const active = selectedSymbols.includes(symbol) ? "active" : "";
        return `<button class="coin-bubble ${active}" type="button" data-symbol="${symbol}" title="${coin.name || symbol}">${coinAvatar(symbol)} ${symbol}</button>`;
    }).join("");

    wrap.querySelectorAll("[data-symbol]").forEach(btn => {
        btn.addEventListener("click", () => {
            const symbol = btn.getAttribute("data-symbol");
            if (selectedSymbols.includes(symbol)) {
                selectedSymbols = selectedSymbols.filter(s => s !== symbol);
            } else {
                selectedSymbols.push(symbol);
            }
            if (!selectedSymbols.length) selectedSymbols = ["BTC"];
            renderCoinBubbles();
            renderSelectedWatchlist();
        });
    });
    renderSelectedWatchlist();
}

function renderSelectedWatchlist() {
    const wrap = $("selectedWatchlist");
    if (!wrap) return;
    wrap.innerHTML = selectedSymbols.map(symbol => `
        <span class="selectedChip">
            ${coinAvatar(symbol)} ${symbol}
            <button type="button" data-remove="${symbol}" aria-label="移除 ${symbol}">×</button>
        </span>
    `).join("");

    wrap.querySelectorAll("[data-remove]").forEach(btn => {
        btn.addEventListener("click", () => {
            const symbol = btn.getAttribute("data-remove");
            selectedSymbols = selectedSymbols.filter(s => s !== symbol);
            if (!selectedSymbols.length) selectedSymbols = ["BTC"];
            renderCoinBubbles();
            renderSelectedWatchlist();
        });
    });
}

function escapeHTML(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function normalizeSpeaker(speaker, index = 0) {
    const s = String(speaker || "").trim().toLowerCase();
    if (["主持人", "主持", "host", "nova"].includes(s)) return "主持人";
    if (["分析師", "分析", "analyst", "onyx"].includes(s)) return "分析師";
    return index % 2 === 0 ? "主持人" : "分析師";
}

function normalizeLines(data) {
    const raw = data.lines || data.dialogue || data.segments || [];
    if (Array.isArray(raw) && raw.length) {
        return raw.map((line, index) => ({
            speaker: normalizeSpeaker(line.speaker || line.role || line.name, index),
            text: line.text || line.content || line.message || ""
        })).filter(line => line.text);
    }

    const script = data.script || "";
    return script.split("\n").filter(line => line.trim()).map((line, index) => {
        const clean = line.trim();
        const match = clean.match(/^(主持人|分析師|Host|Analyst|Nova|Onyx)[:：]\s*(.+)$/i);
        return {
            speaker: match ? normalizeSpeaker(match[1], index) : normalizeSpeaker("", index),
            text: match ? match[2] : clean
        };
    }).filter(line => line.text);
}

function appendChatBubble(speaker, text) {
    const stream = $("chatStream");
    if (!stream) return;
    const empty = stream.querySelector(".chat-empty");
    if (empty) empty.remove();

    const normalizedSpeaker = normalizeSpeaker(speaker);
    updateSpeakingState(normalizedSpeaker);

    const row = document.createElement("div");
    const isHost = normalizedSpeaker === "主持人";
    row.className = `chatRow ${isHost ? "host" : "analyst"}`;
    row.innerHTML = `
        <div class="chatAvatar"><img src="/static/images/${isHost ? "podcast-nova.png" : "podcast-onyx.png"}" alt="" onerror="this.style.display='none';"></div>
        <div class="chatBubble">
            <div class="chatSpeaker">
                <i class="fas ${isHost ? "fa-microphone-lines" : "fa-chart-line"}"></i>
                ${isHost ? "Nova" : "Onyx"}
            </div>
            <div class="chatText">${escapeHTML(text)}</div>
        </div>
    `;
    stream.appendChild(row);
    row.dataset.lineIndex = stream.querySelectorAll(".chatRow").length - 1;
    stream.querySelectorAll(".chatRow.is-current").forEach(item => item.classList.remove("is-current"));
    row.classList.add("is-current");
    stream.scrollTo({ top: stream.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

function syncWatchlistFromTopic() {
    const topic = $("podMarket")?.value || "CRYPTO";
    selectedSymbols = (TOPIC_WATCHLISTS[topic] || TOPIC_WATCHLISTS.CRYPTO).slice();
    const hints = {PERSONAL:"結合市場重點與已登入帳戶的配置。",CRYPTO:"一起掌握主流幣與整體市場動向。",ALT:"追蹤新興幣種與熱門話題。",BTC:"專注比特幣的價格走勢與市場訊號。",RISK:"聚焦市場波動、集中度與風險提醒。"};
    if ($("podTopicHint")) $("podTopicHint").textContent = hints[topic] || hints.CRYPTO;
    document.querySelectorAll("[data-podcast-topic]").forEach(button => {
        const selected = button.dataset.podcastTopic === topic;
        button.setAttribute("aria-checked", String(selected));
        button.tabIndex = selected ? 0 : -1;
    });
}

function initPodcastTopics() {
    const select = $("podMarket");
    if (!select) return;
    const buttons = Array.from(document.querySelectorAll("[data-podcast-topic]"));
    const choose = button => {
        if (button.disabled || select.disabled) return;
        select.value = button.dataset.podcastTopic;
        select.dispatchEvent(new Event("change", {bubbles:true}));
    };
    buttons.forEach((button, index) => {
        button.addEventListener("click", () => choose(button));
        button.addEventListener("keydown", event => {
            if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
            if (!buttons[next].disabled) { buttons[next].focus(); choose(buttons[next]); }
        });
    });
}

function resetChatStream(message = "按下播放後，對話泡泡會跟著語音同步出現。") {
    const stream = $("chatStream");
    if (!stream) return;
    stream.innerHTML = `
        <div class="chat-empty">
            <i class="fas fa-comments"></i>
            <strong>Podcast 已準備好</strong>
            <span>${escapeHTML(message)}</span>
        </div>
    `;
    renderedLineCount = 0;
    bubbleIndex = 0;
    updateSpeakingState("");
}

function updateSpeakingState(speaker) {
    document.querySelectorAll(".cast-card[data-speaker]").forEach(card => {
        const isActive = card.getAttribute("data-speaker") === speaker;
        card.classList.toggle("is-speaking", isActive);
    });

    const stage = document.querySelector(".podcast-visual-stage");
    if (stage) {
        stage.classList.toggle("host-speaking", speaker === "主持人");
        stage.classList.toggle("analyst-speaking", speaker === "分析師");
    }
    const status = $("podcastDialogueStatus");
    if (status && speaker && podcastState === "playing") status.textContent = `${speaker === "主持人" ? "Nova" : "Onyx"} 正在說話`;
}

function estimateLineWeight(line) {
    const text = String(line?.text || "");
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = Math.max(0, text.length - chineseChars);
    return Math.max(2.2, chineseChars * 0.19 + otherChars * 0.08 + 0.9);
}

function buildBubbleTimeline(duration = 0) {
    bubbleTimeline = [];
    if (!podcastLines.length) return bubbleTimeline;

    const safeDuration = Number.isFinite(duration) && duration > 1
        ? duration
        : Math.max(12, podcastLines.reduce((sum, line) => sum + estimateLineWeight(line), 0));

    const weights = podcastLines.map(estimateLineWeight);
    const totalWeight = weights.reduce((sum, n) => sum + n, 0) || 1;
    let cursor = 0;

    podcastLines.forEach((line, index) => {
        const segmentDuration = index === podcastLines.length - 1
            ? Math.max(1.2, safeDuration - cursor)
            : Math.max(1.4, safeDuration * (weights[index] / totalWeight));

        bubbleTimeline.push({
            index,
            start: Math.min(cursor, Math.max(0, safeDuration - 0.8)),
            end: Math.min(safeDuration, cursor + segmentDuration),
            speaker: normalizeSpeaker(line.speaker, index),
            text: line.text
        });
        cursor += segmentDuration;
    });

    return bubbleTimeline;
}

function renderBubblesUntil(lineCount) {
    const stream = $("chatStream");
    if (!stream) return;

    const safeCount = Math.max(0, Math.min(lineCount, podcastLines.length));
    if (safeCount < renderedLineCount) {
        stream.innerHTML = "";
        renderedLineCount = 0;
    }

    const empty = stream.querySelector(".chat-empty, .chatEmpty");
    if (empty && safeCount > 0) empty.remove();

    while (renderedLineCount < safeCount) {
        const line = podcastLines[renderedLineCount];
        appendChatBubble(line.speaker, line.text);
        renderedLineCount++;
    }

    if (safeCount === 0) {
        updateSpeakingState("");
    }
}

function syncBubblesToAudioTime() {
    if (!player || !podcastLines.length || !hasAudioSync) return;
    if (player.paused && player.currentTime === 0 && renderedLineCount === 0) return;
    if (!bubbleTimeline.length) buildBubbleTimeline(player.duration || 0);

    const current = player.currentTime || 0;
    const count = bubbleTimeline.filter(segment => current + 0.12 >= segment.start).length;
    renderBubblesUntil(count);

    const active = [...bubbleTimeline].reverse().find(segment => current >= segment.start && current < segment.end);
    updateSpeakingState(active ? active.speaker : "");
    $("chatStream")?.querySelectorAll(".chatRow").forEach(row => row.classList.toggle("is-current", Number(row.dataset.lineIndex) === active?.index));
}

function startIntervalBubblePlayback(interval = 2600) {
    clearInterval(bubbleTimer);
    const stream = $("chatStream");
    if (stream) stream.innerHTML = "";
    bubbleIndex = 0;
    renderedLineCount = 0;
    if (!podcastLines.length) return;

    const playNext = () => {
        if (bubbleIndex >= podcastLines.length) {
            clearInterval(bubbleTimer);
            updateSpeakingState("");
            return;
        }
        const line = podcastLines[bubbleIndex];
        appendChatBubble(line.speaker, line.text);
        bubbleIndex++;
    };

    playNext();
    bubbleTimer = setInterval(playNext, interval);
}

function updateProgress() {
    const fill = $("progressFill");
    const timeText = $("timeText");
    if (!player || !fill || !timeText) return;
    const duration = Number.isFinite(player.duration) ? Math.max(0, player.duration) : 0;
    const current = Math.max(0, Math.min(player.currentTime || 0, duration));
    const pct = duration ? (current / duration) * 100 : 0;
    fill.style.width = pct + "%";
    timeText.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    if ($("podcastDockTime")) $("podcastDockTime").textContent = timeText.textContent;
    const seek = $("podcastSeek");
    if (seek) {
        seek.value = Math.round(pct * 10);
        seek.setAttribute("aria-valuetext", duration ? `${formatTime(current)}，共 ${formatTime(duration)}` : "尚未取得音訊時長");
    }
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function setAudioStatus(text) {
    const statusEl = $("audioStatus");
    if (statusEl) statusEl.textContent = text;
}

function formatAudioError(error) {
    return "語音服務暫時無法使用，文字稿已保留。按下播放，可使用瀏覽器朗讀。";
}

function stopBrowserVoice() {
    browserVoiceRun += 1;
    browserVoiceContinuation = null;
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
    browserVoiceActive = false;
    browserVoicePaused = false;
}

function selectBrowserDialogueVoices(voices = []) {
    const chinese = voices.filter(voice => /^(zh|cmn)(-|_|$)/i.test(voice.lang || ""));
    const localePriority = voice => /TW|Hant/i.test(voice.lang) ? 0 : /CN|Hans/i.test(voice.lang) ? 1 : 2;
    chinese.sort((a, b) => localePriority(a) - localePriority(b));
    const female = /hsiao.?chen|hsiao.?yu|xiaoxiao|xiaoyi|huihui|yaoyao|hanhan|ting.?ting|mei.?jia|female|曉|慧慧/i;
    const male = /yun.?jhe|yun.?jian|yun.?xi|yun.?yang|kang.?kang|zhi.?wei|\bmale\b|雲哲|云健|康康/i;
    const host = chinese.find(voice => female.test(voice.name)) || chinese.find(voice => !male.test(voice.name)) || chinese[0] || null;
    const different = chinese.filter(voice => voice !== host && (voice.voiceURI || voice.name) !== (host?.voiceURI || host?.name));
    const analyst = different.find(voice => male.test(voice.name)) || different[0] || host;
    return { host, analyst, distinct: Boolean(host && analyst && host !== analyst) };
}

function loadBrowserVoices() {
    const synth = window.speechSynthesis;
    if (typeof synth.getVoices !== "function") return Promise.resolve([]);
    const initial = synth.getVoices();
    if (initial.length) return Promise.resolve(initial);
    return new Promise(resolve => {
        let timeout;
        const finish = () => {
            const voices = synth.getVoices();
            synth.removeEventListener?.("voiceschanged", onVoices);
            clearTimeout(timeout);
            resolve(voices);
        };
        const onVoices = () => { if (synth.getVoices().length) finish(); };
        synth.addEventListener?.("voiceschanged", onVoices);
        timeout = setTimeout(finish, 1200);
        onVoices();
    });
}

function resumeBrowserVoice() {
    window.speechSynthesis.resume();
    browserVoicePaused = false;
    setPodcastState("playing");
    setAudioStatus(browserVoiceStatus);
    const continuation = browserVoiceContinuation;
    browserVoiceContinuation = null;
    continuation?.();
}

async function speakPodcastWithBrowser() {
    if (!("speechSynthesis" in window)) {
        showPodcastToast("沒有可用語音", "這個瀏覽器不支援內建朗讀。文字稿仍可閱讀或複製。");
        return;
    }

    const lines = podcastLines.length
        ? podcastLines
        : normalizeLines({ script: latestScript });

    if (!lines.length) {
        showPodcastToast("尚未有文字稿", "請先生成 Podcast。");
        return;
    }

    stopBrowserVoice();
    const run = browserVoiceRun;
    resetChatStream("正在使用瀏覽器朗讀備援，泡泡會依序出現。");
    browserVoiceActive = true;
    setPodcastState("playing");
    setAudioStatus("正在準備瀏覽器語音...");
    const voices = selectBrowserDialogueVoices(await loadBrowserVoices());
    if (run !== browserVoiceRun) return;
    browserVoiceStatus = voices.distinct
        ? "瀏覽器雙人朗讀：Nova 主持 · Onyx 分析。"
        : "瀏覽器沒有兩種可用的中文音色；請使用雲端語音聆聽雙人聲音。";
    if (!browserVoicePaused) setAudioStatus(browserVoiceStatus);

    let index = 0;
    const speakNext = () => {
        if (run !== browserVoiceRun) return;
        if (browserVoicePaused) { browserVoiceContinuation = speakNext; return; }
        if (!browserVoiceActive || index >= lines.length) {
            browserVoiceActive = false;
            updateSpeakingState("");
            setAudioStatus(index >= lines.length ? "瀏覽器朗讀完畢" : "瀏覽器朗讀已停止");
            setPodcastState(index >= lines.length ? "ended" : "ready");
            return;
        }

        const line = lines[index];
        appendChatBubble(line.speaker, line.text);
        if ($("timeText")) $("timeText").textContent = "瀏覽器朗讀";
        if ($("podcastDockTime")) $("podcastDockTime").textContent = `${index + 1} / ${lines.length} 段`;
        const utterance = new SpeechSynthesisUtterance(line.text);
        utterance.lang = "zh-TW";
        utterance.rate = 1;
        const isHost = normalizeSpeaker(line.speaker, index) === "主持人";
        const voice = isHost ? voices.host : voices.analyst;
        if (voice) utterance.voice = voice;
        utterance.pitch = voices.distinct ? 1 : (isHost ? 1.04 : .92);
        utterance.onend = () => {
            if (run !== browserVoiceRun) return;
            index += 1;
            speakNext();
        };
        utterance.onerror = () => {
            if (run !== browserVoiceRun) return;
            index += 1;
            speakNext();
        };
        window.speechSynthesis.speak(utterance);
    };

    speakNext();
}

function setPlayerSource(url) {
    if (latestAudioUrl.startsWith("blob:") && latestAudioUrl !== url) URL.revokeObjectURL(latestAudioUrl);
    latestAudioUrl = url || "";
    if (!player) return;

    if (!latestAudioUrl) {
        hasAudioSync = false;
        player.removeAttribute("src");
        player.load();
        updateProgress();
        setAudioStatus("已生成文字稿，但尚未取得雲端語音。可按播放使用瀏覽器朗讀備援。");
        return;
    }

    player.src = latestAudioUrl;
    player.load();
    player.playbackRate = parseFloat($("speed")?.value || "1") || 1;
    hasAudioSync = true;
    bubbleTimeline = [];
    resetChatStream("語音已生成。按下播放後，泡泡會依照音訊時間同步出現。");
    setAudioStatus("AI 雙人語音已生成，可以播放。");
}

async function buildDialogueAudio(lines, speed) {
    if (!Array.isArray(lines) || !lines.length) return "";

    const payload = {
        text: lines.map(line => `${normalizeSpeaker(line.speaker)}：${line.text}`).join("\n"),
        lines: lines.map((line, index) => ({
            speaker: normalizeSpeaker(line.speaker, index),
            text: line.text
        })),
        speed: speed
    };

    payload.voice = "nova";

    const res = await fetch("/podcast/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        let detail = "";
        try {
            detail = (await res.json()).detail || "";
        } catch (_) {}
        throw new Error(detail || `Dialogue TTS failed: HTTP ${res.status}`);
    }

    return URL.createObjectURL(await res.blob());
}

async function generatePodcast(btn) {
    const titleEl = $("podcastTitleText");
    const bulletEl = $("podcastBulletText");
    const scriptBox = $("scriptBox");
    const stream = $("chatStream");

    try {
        if (player) player.pause();
        stopBrowserVoice();
        clearInterval(bubbleTimer);
        bubbleTimer = null;
        podcastLines = [];
        latestScript = "";
        bubbleTimeline = [];
        if (scriptBox) scriptBox.textContent = "";
        setPlayerSource("");
        setButtonLoading(btn, '<i class="fas fa-wand-magic-sparkles fa-spin"></i> 生成中...');
        setStudioGenerating(true);
        setPodcastState("generating");
        clearInterval(bubbleTimer);
        if (stream) stream.innerHTML = '<div class="chat-empty">正在生成對話內容...</div>';
        setAudioStatus("正在生成 Podcast...");

        syncWatchlistFromTopic();
        const speed = 1;
        const topic = $("podMarket")?.value || "PERSONAL";
        const portfolioSummary = topic === "PERSONAL"
            ? await fetchPersonalPortfolioSummary()
            : null;
        const payload = {
            market: topic,
            watchlist: selectedSymbols,
            symbols: selectedSymbols,
            hostVoice: "nova",
            analystVoice: "onyx",
            voice: "nova",
            speed: speed
        };
        if (portfolioSummary) payload.portfolio_summary = portfolioSummary;

        const res = await fetch("/podcast/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        let data = {};
        try {
            data = await res.json();
        } catch (_) {
            data = {};
        }

        if (!res.ok) {
            throw new Error(data.error || data.message || `Generate failed: HTTP ${res.status}`);
        }

        podcastLines = normalizeLines(data);
        if (new Set(podcastLines.map(line => line.speaker)).size !== 2) {
            throw new Error("Podcast requires two speakers");
        }
        latestScript = podcastLines.length
            ? podcastLines.map(line => `${line.speaker}：${line.text}`).join("\n")
            : (data.script || "");
        if (!latestScript.trim()) throw new Error("Empty podcast content");

        if (titleEl) titleEl.textContent = data.title || "Smart Invest Crypto 雙人市場快報";
        if (bulletEl) {
            const bullets = Array.isArray(data.bullets) ? data.bullets : [];
            bulletEl.textContent = bullets.length ? bullets.join(" · ") : "已生成本集摘要與聊天內容。";
        }
        if (scriptBox) scriptBox.textContent = latestScript || "目前沒有文字稿。";

        const audioUrl = data.audio_url || data.audioUrl || data.audio || data.url || "";
        if (audioUrl) {
            setPlayerSource(audioUrl);
        } else {
            setAudioStatus("正在產生雙人語音...");
            try {
                const dialogueAudioUrl = await buildDialogueAudio(podcastLines, speed);
                setPlayerSource(dialogueAudioUrl);
            } catch (audioErr) {
                console.warn(audioErr);
                setPlayerSource("");
                setAudioStatus(`已生成文字對話，但語音產生失敗：${formatAudioError(audioErr)}`);
            }
        }
        if (!latestAudioUrl) {
            resetChatStream("文字稿已備妥，按播放即可使用瀏覽器朗讀。");
        }
        setPodcastState("ready");

        showPodcastToast("生成成功", latestAudioUrl ? "雙人語音與聊天內容已完成" : "聊天內容已完成，語音暫時無法產生");
    } catch (err) {
        console.error(err);
        const hint = err.message === "Podcast requires two speakers" ? "這次未形成雙人對話，請重新生成。" : "請稍後重新生成。";
        if (stream) stream.innerHTML = `<div class="chat-empty"><i class="fas fa-rotate-right" aria-hidden="true"></i><strong>這次未能完成節目</strong><span>${hint}</span></div>`;
        podcastLines = []; latestScript = "";
        if (scriptBox) scriptBox.textContent = "";
        setPlayerSource("");
        setAudioStatus("節目生成失敗，請稍後再試。");
        setPodcastState("error");
        showPodcastToast("生成失敗", "請稍後再試，或換個主題重新生成。");
    } finally {
        setStudioGenerating(false);
        resetButtonLoading(btn);
    }
}

async function copyScript() {
    const script = latestScript || $("scriptBox")?.textContent || "";
    if (!script || script.includes("生成 Podcast 後")) {
        showPodcastToast("尚未生成", "目前沒有可以複製的文字稿");
        return;
    }

    try {
        await navigator.clipboard.writeText(script);
        showPodcastToast("已複製", "完整文字稿已複製到剪貼簿");
    } catch (e) {
        const box = $("scriptBox");
        if (box) {
            const range = document.createRange();
            range.selectNodeContents(box);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
        showPodcastToast("請手動複製", "瀏覽器不允許自動複製，已幫你選取文字");
    }
}

function bindClick(id, handler) {
    const el = $(id);
    if (el) el.addEventListener("click", handler);
}

function initVoiceCards() {
    document.querySelectorAll(".voicePill").forEach(btn => {
        btn.addEventListener("click", () => {
            const role = btn.dataset.role;
            document.querySelectorAll(`.voicePill[data-role="${role}"]`).forEach(b => b.classList.remove("active"));
            btn.classList.add("active");

            const inputId = role === "host" ? "hostVoice" : "analystVoice";
            const input = $(inputId);
            if (input) input.value = btn.dataset.voice;

            const castSelector = role === "host" ? ".cast-card.host .cast-meta strong" : ".cast-card.analyst .cast-meta strong";
            const castName = document.querySelector(castSelector);
            if (castName) castName.textContent = `${role === "host" ? "主持人" : "分析師"} ${btn.dataset.voice}`;
        });
    });
}

function initSpeedControl() {
    const speedRange = $("speedRange");
    const speedValue = $("speedValue");
    const speedInput = $("speed");
    if (!speedRange) return;

    const syncSpeed = () => {
        const val = parseFloat(speedRange.value || "1").toFixed(2);
        if (speedValue) speedValue.textContent = val + "x";
        if (speedInput) speedInput.value = val;
        if (player) player.playbackRate = parseFloat(val);
    };

    speedRange.addEventListener("input", syncSpeed);
    syncSpeed();
}

function scrollToPodcastDialogue() {
    const dialogue = $("podcastDialogueSection") || document.querySelector(".podcast-dialogue-fullscreen");
    if (!dialogue) return;
    window.setTimeout(() => {
        const header = document.querySelector(".site-header");
        dialogue.style.scrollMarginTop = `${(header?.getBoundingClientRect().height || 0) + 16}px`;
        dialogue.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    }, 120);
}

function initPlayerButtons() {
    bindClick("btnPodcastPlay", async () => {
        if (browserVoicePaused) {
            resumeBrowserVoice();
            scrollToPodcastDialogue();
            return;
        }
        if (!player || !player.src) {
            if (latestScript || podcastLines.length) {
                speakPodcastWithBrowser();
                scrollToPodcastDialogue();
                showPodcastToast("使用瀏覽器朗讀", "未取得雲端音檔，已改用瀏覽器內建語音。");
                return;
            }
            showPodcastToast("尚未有語音", "選擇主題並生成節目，即可開始聆聽。");
            return;
        }

        try {
            hasAudioSync = true;
            if (!bubbleTimeline.length) buildBubbleTimeline(player.duration || 0);
            syncBubblesToAudioTime();
            await player.play();
            scrollToPodcastDialogue();
        } catch (e) {
            showPodcastToast("播放未開始", "請再按一次播放，或稍後重新生成節目。");
        }
    });

    bindClick("btnPodcastPause", () => {
        if (browserVoiceActive) {
            window.speechSynthesis.pause();
            browserVoicePaused = true;
            setPodcastState("paused");
            setAudioStatus("已暫停瀏覽器朗讀。");
            updateSpeakingState("");
            return;
        }
        if (player) player.pause();
        stopBrowserVoice();
        clearInterval(bubbleTimer);
        bubbleTimer = null;
        syncBubblesToAudioTime();
        updateSpeakingState("");
    });

    bindClick("btnPodcastRestart", async () => {
        if (player && player.src) {
            player.currentTime = 0;
            resetChatStream("正在從頭播放，對話會重新同步。");
            buildBubbleTimeline(player.duration || 0);
            syncBubblesToAudioTime();
            try {
                await player.play();
            } catch (_) {}
        } else {
            speakPodcastWithBrowser();
        }
    });

    bindClick("btnPodcastDockPlay", () => $(podcastState === "playing" ? "btnPodcastPause" : "btnPodcastPlay")?.click());
    const seek = seconds => {
        if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return;
        player.currentTime = Math.max(0, Math.min(seconds, player.duration));
        updateProgress();
        syncBubblesToAudioTime();
    };
    $("podcastSeek")?.addEventListener("input", event => seek(Number(event.target.value) / 1000 * player.duration));
    bindClick("btnPodcastBack", () => seek(player.currentTime - 15));
    bindClick("btnPodcastForward", () => seek(player.currentTime + 15));

    if (player) {
        player.addEventListener("timeupdate", () => {
            updateProgress();
            syncBubblesToAudioTime();
        });
        player.addEventListener("loadedmetadata", () => {
            updateProgress();
            buildBubbleTimeline(player.duration || 0);
            syncBubblesToAudioTime();
            if (podcastState !== "generating" && latestScript) setPodcastState(player.paused ? "ready" : "playing");
        });
        player.addEventListener("seeked", syncBubblesToAudioTime);
        player.addEventListener("play", () => {
            hasAudioSync = true;
            setPodcastState("playing");
            syncBubblesToAudioTime();
            setAudioStatus("播放中，對話泡泡已同步音訊時間。");
        });
        player.addEventListener("pause", () => {
            if (podcastState !== "generating" && latestScript) {
                setPodcastState("paused");
                setAudioStatus("已暫停");
                updateSpeakingState("");
            }
        });
        player.addEventListener("ended", () => {
            setPodcastState("ended");
            setAudioStatus("播放完畢");
            clearInterval(bubbleTimer);
            bubbleTimer = null;
            renderBubblesUntil(podcastLines.length);
            updateSpeakingState("");
        });
        player.addEventListener("error", () => {
            setPlayerSource("");
            setPodcastState(latestScript ? "ready" : "error");
            setAudioStatus("音訊暫時無法載入。文字稿已保留，按播放可使用瀏覽器朗讀。");
        });
    }
}

function initImmersiveReading() {
    const dialogue = $("podcastDialogueSection"), button = $("btnPodcastFocus");
    if (!dialogue || !button) return;
    let background = [];
    const toggle = active => {
        document.body.classList.toggle("podcast-focus", active);
        button.setAttribute("aria-pressed", String(active));
        button.innerHTML = `<i class="fas fa-${active ? "compress" : "expand"}" aria-hidden="true"></i> ${active ? "離開沉浸" : "沉浸閱讀"}`;
        if (active) {
            background = Array.from(document.querySelectorAll(".site-header,.footer,.float-actions,.podcast-player-section,#toast")).map(el => ({el,inert:el.inert}));
            background.forEach(({el}) => { el.inert = true; });
            dialogue.setAttribute("role", "dialog");
            dialogue.setAttribute("aria-modal", "true");
            dialogue.setAttribute("aria-labelledby", "podcastDialogueTitle");
        } else {
            background.forEach(({el,inert}) => { el.inert = inert; });
            background = [];
            dialogue.removeAttribute("role");
            dialogue.removeAttribute("aria-modal");
            dialogue.removeAttribute("aria-labelledby");
        }
        button.focus({preventScroll:true});
    };
    button.addEventListener("click", () => toggle(!document.body.classList.contains("podcast-focus")));
    dialogue.addEventListener("keydown", event => {
        if (!document.body.classList.contains("podcast-focus")) return;
        if (event.key === "Escape") { event.preventDefault(); toggle(false); return; }
        if (event.key !== "Tab") return;
        const focusable = Array.from(dialogue.querySelectorAll("button:not(:disabled),a[href],[tabindex='0']")).filter(el => el.offsetParent !== null);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
}

function initPodcastPage() {
    window.speechSynthesis?.getVoices?.();
    syncWatchlistFromTopic();

    bindClick("btnGenPodcast", function() {
        generatePodcast(this);
    });

    const marketSelect = $("podMarket");
    if (marketSelect) {
        marketSelect.addEventListener("change", syncWatchlistFromTopic);
    }
    initPodcastTopics();

    bindClick("btnCopyScript", copyScript);

    initSpeedControl();
    initPlayerButtons();
    initImmersiveReading();
    updateSpeakingState("");
    setPodcastState("idle");
}

document.addEventListener("DOMContentLoaded", initPodcastPage);
