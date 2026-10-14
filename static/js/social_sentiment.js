const socialTools = window.ResearchTools;
let socialData = null, socialTab = "signals", socialPending = false;
function socialPosts() { return ["signals","noises"].flatMap(key => Array.isArray(socialData?.[key]) ? socialData[key] : []); }

function renderSocialFeed() {
  const stream = document.getElementById("socialFeed"); if (!stream) return;
  const search = document.getElementById("socialSearch").value.trim().toLowerCase(), source = document.getElementById("socialSource").value;
  const posts = (Array.isArray(socialData?.[socialTab]) ? socialData[socialTab] : []).filter(post =>
    (source === "all" || post.source === source) && `${post.title || ""} ${post.author || ""}`.toLowerCase().includes(search));
  socialTools.text("socialVisibleCount", `${posts.length} 篇符合篩選`);
  stream.innerHTML = posts.length ? posts.map(post => {
    const link = socialTools.url(post.link), title = socialTools.escape(post.title || "未命名內容");
    return `<article class="research-post"><div class="research-post-meta"><span class="tools-tag">${socialTools.escape(post.source || "未標示來源")}</span><time>${socialTools.escape(post.date || "日期未提供")}</time></div>
      ${link ? `<a class="research-post-title" href="${socialTools.escape(link)}" target="_blank" rel="noopener noreferrer">${title}<i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : `<strong class="research-post-title">${title}</strong>`}
      <div class="research-post-foot"><span>${socialTools.escape(post.author || "來源未署名")}</span><small>${socialTab === "signals" ? "依來源與關鍵字規則收錄" : "其他討論內容"}</small></div></article>`;
  }).join("") : '<div class="tools-empty"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><strong>目前沒有符合的內容</strong><span>可切換來源或清除關鍵字。</span></div>';
}

function renderSocialOverview(data) {
  socialData = data;
  const posts = socialPosts();
  const signals = Math.max(0, socialTools.number(data.signal_count) ?? (Array.isArray(data.signals) ? data.signals.length : 0));
  const noises = Math.max(0, socialTools.number(data.noise_count) ?? (Array.isArray(data.noises) ? data.noises.length : 0));
  const total = signals + noises;
  socialTools.text("socialTotal", total); socialTools.text("signal-count-badge", signals); socialTools.text("noise-count-badge", noises);
  const sources = [...new Set(posts.map(post => post.source).filter(Boolean))]; socialTools.text("socialSources", sources.length);
  const rawScore = socialTools.number(data.sentiment_score), score = posts.length && rawScore !== null && rawScore >= 0 && rawScore <= 100 ? rawScore : null;
  socialTools.text("sentiment-score",score === null ? "--" : `${score}/100`);
  document.getElementById("sentimentFill").style.width = `${score ?? 0}%`;
  const donut = document.getElementById("socialCollectionRing");
  donut.style.setProperty("--signal-share", total ? `${signals / total * 100}%` : "0%");
  donut.classList.toggle("is-empty", !total); donut.setAttribute("aria-label", `收錄 ${total} 篇，優先閱讀 ${signals} 篇，其他內容 ${noises} 篇`);
  const keywords = (Array.isArray(data.hot_keywords) ? data.hot_keywords : []).filter(item =>
    Array.isArray(item) && item[0] && socialTools.number(item[1]) > 0).sort((a,b) => Number(b[1])-Number(a[1])).slice(0,6);
  socialTools.text("socialFocus", keywords[0]?.[0] || "暫無明顯焦點");
  const peak = Math.max(1,...keywords.map(item => Number(item[1])));
  document.getElementById("socialKeywords").innerHTML = keywords.length ? keywords.map(([word,count],index) =>
    `<button class="tools-heat-row" data-keyword="${socialTools.escape(word)}" type="button"><span class="tools-rank">${String(index+1).padStart(2,"0")}</span><span class="tools-heat-label">${socialTools.escape(word)}<span class="tools-bar"><i style="width:${Number(count)/peak*100}%"></i></span></span><strong>${Number(count)}<small> 次</small></strong></button>`).join("")
    : '<div class="tools-empty compact"><span>本次資料沒有可顯示的關鍵字。</span></div>';
  socialTools.text("sentiment-reason", socialTools.plain(data.sentiment_reason) || "本次沒有提供來源摘要。");
  const filter = document.getElementById("socialSource"), previous = filter.value;
  filter.replaceChildren(new Option("全部來源","all")); sources.forEach(source => filter.add(new Option(source,source)));
  if (sources.includes(previous)) filter.value = previous;
  renderSocialFeed();
}

async function loadSocialSentiment() {
  if (socialPending) return;
  socialPending = true; const button = document.getElementById("toolsReload"); button.disabled = true;
  socialTools.text("toolsStatus","整理中");
  try { renderSocialOverview(await socialTools.json("/api/social-data")); socialTools.updated(socialPosts().length ? "已取得資料" : "本次沒有內容"); }
  catch {
    renderSocialOverview({signals:[],noises:[]}); socialTools.text("toolsStatus","資料暫不可用"); socialTools.text("toolsUpdatedAt","請稍後重新取得");
    socialTools.text("socialTotal","--"); socialTools.text("socialSources","--"); socialTools.text("socialFocus","資料暫缺");
    socialTools.text("signal-count-badge","--"); socialTools.text("noise-count-badge","--");
    document.getElementById("socialCollectionRing").setAttribute("aria-label","收錄資料暫不可用");
    document.getElementById("socialFeed").innerHTML = '<div class="tools-empty"><i class="fas fa-rotate" aria-hidden="true"></i><strong>目前無法取得內容</strong><span>請稍後按更新資料重試。</span></div>';
  } finally { socialPending = false; button.disabled = false; }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("toolsReload").addEventListener("click",loadSocialSentiment);
  ["socialSearch","socialSource"].forEach(id => document.getElementById(id).addEventListener(id === "socialSearch" ? "input" : "change",renderSocialFeed));
  document.querySelectorAll("[data-social-tab]").forEach(button => button.addEventListener("click", () => {
    socialTab = button.dataset.socialTab;
    document.querySelectorAll("[data-social-tab]").forEach(item => item.setAttribute("aria-pressed",String(item === button))); renderSocialFeed();
  }));
  document.getElementById("socialKeywords").addEventListener("click",event => {
    const button = event.target.closest("[data-keyword]"); if (!button) return;
    document.getElementById("socialSearch").value = button.dataset.keyword; renderSocialFeed();
    document.getElementById("socialReading").scrollIntoView({behavior:"smooth",block:"start"});
  });
  document.getElementById("socialClear").addEventListener("click", () => {
    document.getElementById("socialSearch").value = ""; document.getElementById("socialSource").value = "all"; renderSocialFeed();
  });
  loadSocialSentiment(); setInterval(() => { if (!document.hidden) loadSocialSentiment(); },60000);
});
