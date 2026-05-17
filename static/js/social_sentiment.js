function escapeHTML(value){
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setText(id, value){
  const el = document.getElementById(id);
  if(el) el.textContent = value;
}

function renderPosts(containerId, posts, className){
  const container = document.getElementById(containerId);
  if(!container) return;

  const list = Array.isArray(posts) ? posts : [];
  if(!list.length){
    container.innerHTML = '<div class="empty-state">目前沒有資料。</div>';
    return;
  }

  container.innerHTML = list.map((post) => {
    const sentiment = post.sentiment === "BULLISH" ? "看多" : post.sentiment === "BEARISH" ? "看空" : "中性";
    const link = post.link || "#";
    return `
      <article class="post-card ${className}">
        <div class="post-meta"><span class="tag">${escapeHTML(post.source || "Social")}</span><span>${escapeHTML(sentiment)}</span></div>
        <a class="post-title" href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer">${escapeHTML(post.title || "未命名討論")}</a>
        <div class="post-foot"><span>${escapeHTML(post.author || "匿名來源")}</span><span><i class="fas fa-fire"></i> ${escapeHTML(post.push ?? 0)} 熱度</span></div>
      </article>
    `;
  }).join("");
}

async function loadSocialSentiment(){
  try{
    const res = await fetch("/api/social-data");
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const score = Number(data.sentiment_score || 0);

    setText("sentiment-score", Number.isFinite(score) ? String(score) : "--");
    setText("sentiment-summary", score > 20 ? "偏多" : score < -20 ? "偏空" : "中性");
    setText("signal-count-badge", String(data.signal_count ?? (data.signals || []).length ?? 0));
    setText("noise-count-badge", String(data.noise_count ?? (data.noises || []).length ?? 0));

    const status = document.getElementById("sentiment-status");
    if(status){
      status.textContent = score > 20 ? "Greed / 偏多" : score < -20 ? "Fear / 偏空" : "Neutral / 中性";
      status.style.color = score > 20 ? "var(--good)" : score < -20 ? "var(--bad)" : "var(--brand)";
    }

    const reason = document.getElementById("sentiment-reason");
    if(reason) reason.innerHTML = data.sentiment_reason || "尚未取得 AI 摘要。";

    renderPosts("signal-stream", data.signals, "signal-post");
    renderPosts("noise-stream", data.noises, "noise-post");
  }catch(error){
    setText("sentiment-status", "載入失敗");
    setText("sentiment-reason", "目前無法取得社群資料，請稍後再試。");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadSocialSentiment();
  setInterval(loadSocialSentiment, 15000);
});
