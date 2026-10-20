function scoreTone(score){
  if(score > 65) return "var(--bad)";
  if(score > 40) return "var(--warn)";
  return "var(--good)";
}

async function loadHomeSfiPreview(){
  const tbody = document.getElementById("homeSfiBody");
  if(!tbody) return;

  try{
    const res = await fetch("/api/coingecko");
    const data = await res.json();
    const rows = (data.data || []).slice(0, 6);

    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="5" class="sfi-loading">目前沒有可顯示的風險資料。</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function(coin){
      const risk = coin.risk || {};
      const hasScore = risk.level !== "base" && risk.score != null && Number.isFinite(Number(risk.score));
      const score = hasScore ? Number(risk.score) : 0;
      const change = Number(coin.change || 0);
      const price = Number(coin.price_usd || 0);
      return `
        <tr>
          <td>${coin.rank || "--"}</td>
          <td>
            <div class="sfi-coin">
              <strong>${coin.cn_name || coin.name || coin.symbol || "--"}</strong>
              <span>${coin.symbol || "--"}</span>
            </div>
          </td>
          <td>$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
          <td style="color:${change >= 0 ? "var(--good)" : "var(--bad)"};">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</td>
          <td>
            <div class="sfi-score">
              <div class="sfi-score-head">
                <span style="color:${scoreTone(score)};">${risk.msg || "風險觀察中"}</span>
                <b>${hasScore ? `${score}/100` : risk.msg === "市場基準" ? "基準" : "--"}</b>
              </div>
              ${hasScore ? `<div class="sfi-bar">
                <div class="sfi-bar-fill"></div>
                <div class="sfi-bar-pointer" style="left:${Math.max(0, Math.min(100, score))}%"></div>
              </div>` : ""}
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }catch(error){
    tbody.innerHTML = '<tr><td colspan="5" class="sfi-loading">風險資料載入失敗，請稍後再試。</td></tr>';
  }
}

document.addEventListener("DOMContentLoaded", loadHomeSfiPreview);

document.addEventListener("DOMContentLoaded", () => {
  const explorer = document.getElementById('features');
  if (!explorer) return;
  const tabs = Array.from(explorer.querySelectorAll('[role=tab]'));
  const navigation = explorer.querySelector('.feature-carousel-navigation');
  const stage = explorer.querySelector('.feature-carousel-stage');
  const arrows = Array.from(stage.querySelectorAll('[data-carousel-direction]'));
  const pages = explorer.querySelector('.carousel-pages');
  const position = explorer.querySelector('.carousel-position');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const categories = {
    coreFeaturesPanel: {name:'核心功能',copy:'掌握行情、檢查風險，再透過 AI 投資教練與模擬交易練習決策。'},
    observationToolsPanel: {name:'進階觀察工具',copy:'追蹤社群情緒與市場敘事，深入查看個別幣種的價格與風險。'}
  };
  let activeTrack = explorer.querySelector('#featureCarousel');
  let activeCategory = categories.coreFeaturesPanel;
  let targetIndex = null;
  let scrollTimer;
  const metrics = () => {
    const width = activeTrack.firstElementChild.getBoundingClientRect().width;
    const step = width + parseFloat(getComputedStyle(activeTrack).gap || 0);
    const visible = Math.max(1, Math.round((activeTrack.clientWidth+18)/step));
    const maxIndex = Math.max(0, activeTrack.children.length-visible);
    const index = Math.min(maxIndex, Math.max(0, Math.round(activeTrack.scrollLeft/step)));
    return {step,visible,maxIndex,index};
  };
  const update = () => {
    const {index,maxIndex,visible} = metrics();
    arrows[0].disabled = index===0;
    arrows[1].disabled = index===maxIndex;
    if (pages.children.length!==maxIndex+1) {
      pages.replaceChildren(...Array.from({length:maxIndex+1},(_,i) => {
        const button = document.createElement('button');
        button.type='button';button.className='carousel-page';
        button.addEventListener('click',()=>goTo(i));
        return button;
      }));
    }
    Array.from(pages.children).forEach((button,i) => {
      button.setAttribute('aria-controls',activeTrack.id);
      button.setAttribute('aria-label',`${activeCategory.name}：從第 ${i+1} 張開始`);
      button.setAttribute('aria-current',String(index===i));
    });
    position.textContent=`${activeCategory.name} · ${index+1}–${Math.min(index+visible,activeTrack.children.length)} / ${activeTrack.children.length}`;
  };
  const goTo = index => {
    const {step,maxIndex} = metrics();
    targetIndex = Math.min(maxIndex,Math.max(0,index));
    activeTrack.scrollTo({left:targetIndex*step,behavior:reducedMotion.matches?'instant':'smooth'});
  };
  const move = direction => goTo((targetIndex??metrics().index)+direction);
  const selectTab = tab => {
    tabs.forEach(item => {
      const selected = item===tab;
      item.setAttribute('aria-selected',String(selected));
      item.tabIndex=selected?0:-1;
      document.getElementById(item.getAttribute('aria-controls')).hidden=!selected;
    });
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    activeTrack = panel.querySelector('[data-card-carousel]');
    activeCategory = categories[panel.id];
    targetIndex=null;clearTimeout(scrollTimer);
    explorer.querySelector('#featureCategoryCopy').textContent=activeCategory.copy;
    navigation.setAttribute('aria-label',`${activeCategory.name}卡片切換`);
    stage.setAttribute('aria-label',`${activeCategory.name}卡片切換`);
    arrows.forEach(button => {
      button.setAttribute('aria-controls',activeTrack.id);
      button.setAttribute('aria-label',`${Number(button.dataset.carouselDirection)<0?'上一張':'下一張'}${activeCategory.name}`);
    });
    update();
  };
  tabs.forEach((tab,i) => {
    tab.addEventListener('click',()=>selectTab(tab));
    tab.addEventListener('keydown',event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      tabs[next].focus();selectTab(tabs[next]);
    });
  });
  arrows.forEach(button => button.addEventListener('click',()=>move(Number(button.dataset.carouselDirection))));
  explorer.querySelectorAll('[data-card-carousel]').forEach(track => {
    // Keep anchors as the only interactive element in each card.
    Array.from(track.children).forEach(card => {
      const action = document.createElement('em');action.className='card-action';
      const label = document.createElement('b');
      label.textContent=`前往${card.querySelector('h3').firstChild.textContent.trim()}`;
      const icon = document.createElement('i');icon.className='fas fa-arrow-right';icon.setAttribute('aria-hidden','true');
      action.append(label,icon);(card.querySelector(':scope > div')||card).append(action);
    });
    track.addEventListener('scroll',()=>{
      if(track!==activeTrack)return;
      update();clearTimeout(scrollTimer);
      scrollTimer=setTimeout(()=>{targetIndex=null;},160);
    },{passive:true});
    track.addEventListener('pointerdown',()=>{targetIndex=null;},{passive:true});
    track.addEventListener('keydown',event=>{
      if(event.target!==track||!['ArrowLeft','ArrowRight'].includes(event.key))return;
      event.preventDefault();move(event.key==='ArrowLeft'?-1:1);
    });
  });
  new ResizeObserver(()=>{
    targetIndex=null;
    // Maintain a whole-card position when the visible card count changes.
    const {step,index} = metrics();
    activeTrack.scrollTo({left:index*step,behavior:'instant'});update();
  }).observe(explorer);
  selectTab(tabs[0]);
});
