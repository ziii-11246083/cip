/**
 * Podcast Page Logic - Fixed Version
 * 修正重點：
 * 1. 生成後會自動把 audio_url 放進 <audio> 播放器
 * 2. 補上「更新幣種」按鈕
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

let popularCoinsCache = [];
let selectedSymbols = ["BTC", "ETH", "SOL"];
let podcastLines = [];
let bubbleTimer = null;
let bubbleIndex = 0;
let bubbleTimeline = [];
let renderedLineCount = 0;
let hasAudioSync = false;
let latestScript = "";
let latestAudioUrl = "";

const player = $("player");

async function hasMemberSession() {
    try {
        const token = await window.authManager?.getToken?.();
        return Boolean(token);
    } catch (_) {
        return false;
    }
}

async function ensurePodcastAccess() {
    const isGuest = Boolean(window.authManager?.isGuestMode?.());
    const isMember = await hasMemberSession();
    if (isGuest || isMember) return true;

    if (window.authManager?.continueAsGuest) {
        await window.authManager.continueAsGuest();
        updatePodcastAccessState();
        showPodcastToast("已切換訪客模式", "Podcast 已開放使用，現在開始生成內容。");
        return true;
    }

    showPodcastToast("請先啟用訪客模式", "按下「訪客使用」後即可生成 Podcast。");
    return false;
}

function updatePodcastAccessState() {
    const gate = $("podcastGuestGate");
    const btn = $("btnEnablePodcastGuest");
    const isGuest = Boolean(window.authManager?.isGuestMode?.());
    if (gate) gate.classList.toggle("is-active", isGuest);
    if (btn) {
        btn.innerHTML = isGuest
            ? '<i class="fas fa-circle-check"></i> 已啟用訪客模式'
            : '<i class="fas fa-user-check"></i> 啟用訪客模式';
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
    const s = String(speaker || "").trim();
    if (["主持人", "Host", "host", "nova", "Nova"].includes(s)) return "主持人";
    if (["分析師", "Analyst", "analyst", "onyx", "Onyx"].includes(s)) return "分析師";
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
    return script.split("\n").map((line, index) => {
        const clean = line.trim();
        const match = clean.match(/^(主持人|分析師|Host|Analyst)[:：]\s*(.+)$/i);
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
        <div class="chatBubble">
            <div class="chatSpeaker">
                <i class="fas ${isHost ? "fa-microphone-lines" : "fa-chart-line"}"></i>
                ${normalizedSpeaker}
            </div>
            <div class="chatText">${escapeHTML(text)}</div>
        </div>
    `;
    stream.appendChild(row);
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
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
    if (!bubbleTimeline.length) buildBubbleTimeline(player.duration || 0);

    const current = player.currentTime || 0;
    const count = bubbleTimeline.filter(segment => current + 0.12 >= segment.start).length;
    renderBubblesUntil(count);

    const active = [...bubbleTimeline].reverse().find(segment => current >= segment.start && current < segment.end);
    updateSpeakingState(active ? active.speaker : "");
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
    const duration = player.duration || 0;
    const current = player.currentTime || 0;
    const pct = duration ? (current / duration) * 100 : 0;
    fill.style.width = pct + "%";
    timeText.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
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

function setPlayerSource(url) {
    latestAudioUrl = url || "";
    if (!player) return;

    if (!latestAudioUrl) {
        hasAudioSync = false;
        player.removeAttribute("src");
        player.load();
        updateProgress();
        setAudioStatus("已生成文字稿，但後端沒有回傳語音檔。請確認 /podcast/generate 有回傳 audio_url。");
        return;
    }

    player.src = latestAudioUrl;
    player.load();
    player.playbackRate = parseFloat($("speed")?.value || "1") || 1;
    hasAudioSync = true;
    bubbleTimeline = [];
    resetChatStream("語音已生成。按下播放後，泡泡會依照音訊時間同步出現。");
    setAudioStatus("語音已生成，可以播放。");
}

async function buildDialogueAudio(lines, speed) {
    if (!Array.isArray(lines) || !lines.length) return "";

    const payload = {
        text: lines.map(line => `${normalizeSpeaker(line.speaker)}：${line.text}`).join("\n"),
        speed: speed
    };

    const hostVoice = $("hostVoice")?.value || "nova";
    const analystVoice = $("analystVoice")?.value || "onyx";
    payload.voice = hostVoice || analystVoice || "nova";

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
        const canUse = await ensurePodcastAccess();
        if (!canUse) return;

        setButtonLoading(btn, '<i class="fas fa-wand-magic-sparkles fa-spin"></i> 生成中...');
        clearInterval(bubbleTimer);
        if (stream) stream.innerHTML = '<div class="chat-empty">正在生成對話內容...</div>';
        setAudioStatus("正在生成 Podcast...");

        const speed = parseFloat($("speed")?.value || $("speedRange")?.value || "1") || 1;
        const payload = {
            market: $("podMarket")?.value || "CRYPTO",
            watchlist: selectedSymbols,
            symbols: selectedSymbols,
            hostVoice: $("hostVoice")?.value || "nova",
            analystVoice: $("analystVoice")?.value || "onyx",
            voice: $("hostVoice")?.value || "nova",
            speed: speed
        };

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
        latestScript = podcastLines.length
            ? podcastLines.map(line => `${line.speaker}：${line.text}`).join("\n")
            : (data.script || "");

        if (titleEl) titleEl.textContent = data.title || "Smart Invest 雙人市場快報";
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
                setAudioStatus("已生成文字對話，但語音產生失敗。請確認 OpenAI API Key 與 TTS 端點。");
            }
        }
        if (!latestAudioUrl) {
            startIntervalBubblePlayback();
        }

        showPodcastToast("生成成功", latestAudioUrl ? "雙人語音與聊天內容已完成" : "聊天內容已完成，語音暫時無法產生");
    } catch (err) {
        console.error(err);
        if (stream) stream.innerHTML = '<div class="chat-empty">生成失敗，請確認後端 API 是否正常。</div>';
        setAudioStatus("生成失敗，請檢查 /podcast/generate 後端回傳格式。");
        showPodcastToast("錯誤", err.message || "生成失敗，請稍後再試");
    } finally {
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

function initPlayerButtons() {
    bindClick("btnPodcastPlay", async () => {
        if (!player || !player.src) {
            showPodcastToast("尚未有語音", "請先生成 Podcast，或確認後端有回傳 audio_url");
            return;
        }

        try {
            hasAudioSync = true;
            if (!bubbleTimeline.length) buildBubbleTimeline(player.duration || 0);
            syncBubblesToAudioTime();
            await player.play();
        } catch (e) {
            showPodcastToast("播放失敗", "瀏覽器阻擋播放，請直接點播放器播放");
        }
    });

    bindClick("btnPodcastPause", () => {
        if (player) player.pause();
        clearInterval(bubbleTimer);
        bubbleTimer = null;
        syncBubblesToAudioTime();
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
            startIntervalBubblePlayback();
        }
    });

    if (player) {
        player.addEventListener("timeupdate", () => {
            updateProgress();
            syncBubblesToAudioTime();
        });
        player.addEventListener("loadedmetadata", () => {
            updateProgress();
            buildBubbleTimeline(player.duration || 0);
            syncBubblesToAudioTime();
        });
        player.addEventListener("seeked", syncBubblesToAudioTime);
        player.addEventListener("play", () => {
            hasAudioSync = true;
            syncBubblesToAudioTime();
            setAudioStatus("播放中，對話泡泡已同步音訊時間。");
        });
        player.addEventListener("pause", () => setAudioStatus("已暫停"));
        player.addEventListener("ended", () => {
            setAudioStatus("播放完畢");
            clearInterval(bubbleTimer);
            bubbleTimer = null;
            renderBubblesUntil(podcastLines.length);
            updateSpeakingState("");
        });
        player.addEventListener("error", () => {
            setAudioStatus("音訊載入失敗，請檢查 audio_url 路徑是否正確。");
        });
    }
}

function initPodcastPage() {
    loadPopularCoins();
    renderSelectedWatchlist();
    updatePodcastAccessState();

    bindClick("btnEnablePodcastGuest", async function() {
        if (window.authManager?.continueAsGuest) {
            setButtonLoading(this, '<i class="fas fa-spinner fa-spin"></i> 啟用中...');
            await window.authManager.continueAsGuest();
            updatePodcastAccessState();
            resetButtonLoading(this);
        }
    });

    bindClick("btnGenPodcast", function() {
        generatePodcast(this);
    });

    bindClick("btnRefreshCoins", function() {
        loadPopularCoins(this);
    });

    bindClick("btnCopyScript", copyScript);

    initVoiceCards();
    initSpeedControl();
    initPlayerButtons();
    updateSpeakingState("主持人");
    window.addEventListener("smartinvest:guest-mode", updatePodcastAccessState);
}

document.addEventListener("DOMContentLoaded", initPodcastPage);
