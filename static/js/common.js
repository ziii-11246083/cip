document.documentElement.classList.add("js-enabled");
window.__COMMON_UI_ACTIVE__ = true;

// Separate currency labels from amounts without changing the text, values or forms.
function enhanceCurrencyLabels(root) {
  const skip = 'script,style,textarea,input,select,code,pre,[contenteditable],.money-currency,.money-amount';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest(skip) || !/(?:\bUSD\s*[+−-]?\d|\d\s*TWD\b)/.test(node.nodeValue)) continue;
    nodes.push(node);
  }
  nodes.forEach(node => {
    const pattern = /\b(USD)(\s*)([+−-]?\d[\d,.]*(?:[KMBT])?)|([+−-]?\d[\d,.]*)(\s*)(TWD)\b/g;
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      fragment.append(document.createTextNode(text.slice(last,match.index)));
      const currency = document.createElement('span');currency.className='money-currency';currency.textContent=match[1]||match[6];
      const amount = document.createElement('span');amount.className='money-amount';amount.textContent=match[3]||match[4];
      const space = document.createTextNode(match[1]?match[2]:match[5]);
      fragment.append(...(match[1]?[currency,space,amount]:[amount,space,currency]));
      last=match.index+match[0].length;
    }
    if(last){fragment.append(document.createTextNode(text.slice(last)));node.replaceWith(fragment);}
  });
}
document.addEventListener('DOMContentLoaded',()=>{
  const main = document.querySelector('main');
  if(!main)return;
  enhanceCurrencyLabels(main);
  const pending = new Set();let scheduled=false;
  const observer = new MutationObserver(records=>{
    records.forEach(record=>{
      const target=record.target.nodeType===Node.TEXT_NODE?record.target.parentElement:record.target;
      if(target?.closest?.('.money-currency,.money-amount'))return;
      if(record.type==='characterData')pending.add(target);
      else record.addedNodes.forEach(node=>pending.add(node.nodeType===Node.TEXT_NODE?node.parentElement:node));
    });
    if(scheduled||!pending.size)return;
    scheduled=true;
    requestAnimationFrame(()=>{
      pending.forEach(node=>{if(node?.isConnected)enhanceCurrencyLabels(node);});
      pending.clear();observer.takeRecords();scheduled=false;
    });
  });
  observer.observe(main,{subtree:true,childList:true,characterData:true});
});

// API timestamps without an offset are UTC (the existing service uses utcnow).
window.SIFormat = {
  date(value) {
    if (value === null || value === undefined || value === "") return null;
    let raw = value;
    if (typeof raw === "number") raw *= raw < 1e12 ? 1000 : 1;
    if (typeof raw === "string") {
      raw = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += "Z";
    }
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  },
  dateText(value) {
    const date = this.date(value);
    if (!date) return "--";
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(date);
  },
  dateKey(value) {
    const date = this.date(value);
    if (!date) return "unknown";
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
    const get = key => parts.find(part => part.type === key).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  },
  quantity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    if (number > 0 && number < .005) return "<0.01";
    return number.toLocaleString("zh-TW", {minimumFractionDigits:2,maximumFractionDigits:2});
  },
};

// Keep table labels left aligned and monetary/quantity columns right aligned.
document.addEventListener("DOMContentLoaded", () => {
  const main = document.querySelector("main");
  if (!main) return;
  const alignTables = () => main.querySelectorAll("table").forEach(table => {
    const columns = Array.from(table.querySelectorAll("thead th"));
    const numeric = columns.map(th => /金額|價格|均價|現價|市值|數量|占比|比例|損益|報酬|波動|回撤|分數|熱度|成交量|市占率|漲跌|預計金額/.test(th.textContent));
    columns.forEach((th, index) => th.classList.toggle("numeric", numeric[index]));
    table.querySelectorAll("tbody tr").forEach(row => Array.from(row.children).forEach((td, index) => {
      if (!td.hasAttribute("colspan")) td.classList.toggle("numeric", Boolean(numeric[index]));
    }));
  });
  alignTables();
  new MutationObserver(alignTables).observe(main, {childList:true,subtree:true});
});

function restoreOriginalSiteIcon() {
  const iconUrl = "/static/img/logo.jpg";
  let icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.type = "image/jpeg";
  icon.href = iconUrl;
}

restoreOriginalSiteIcon();

window.waitForSmartInvestAuth = async function waitForSmartInvestAuth(timeoutMs = 5000) {
  if (window.authManager) {
    await window.authManager.ensureReady?.();
    return window.authManager;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const poll = window.setInterval(() => {
      if (window.authManager) finish();
    }, 50);
    window.addEventListener("smartinvest:auth-ready", finish, { once: true });
  });

  await window.authManager?.ensureReady?.();
  return window.authManager || null;
};

function markPageReady() {
  if (document.body) document.body.classList.add("page-ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", markPageReady, { once: true });
} else {
  markPageReady();
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) markPageReady();
});

window.setTimeout(() => {
  if (!document.body?.classList.contains("page-ready")) markPageReady();
}, 900);

function toast(title, msg) {
  const el = document.getElementById("toast");
  if (!el) {
    alert(`${title}\n${msg}`);
    return;
  }

  const t = el.querySelector(".t");
  const m = el.querySelector(".m");
  if (t) t.textContent = title;
  if (m) m.textContent = msg;

  el.style.display = "block";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = "none";
  }, 3400);
}

function initCommonUI() {
  const loginToggle = document.getElementById("loginToggle");
  const accountPopup = document.getElementById("accountPopup");
  const popupClose = document.getElementById("popupClose");
  const emailInput = document.getElementById("emailInput");
  const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");
  const backToTopBtn = document.getElementById("backToTopBtn");
  const path = window.location.pathname;
  const navMore = document.querySelector(".nav-more");
  const userMenu = document.querySelector(".user-menu");

  function closePopup() {
    if (accountPopup) {
      accountPopup.classList.remove("show");
    }
  }

  function openPopup() {
    if (accountPopup) {
      accountPopup.classList.add("show");
    }
  }

  if (loginToggle && accountPopup) {
    loginToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      accountPopup.classList.toggle("show");
    });

    accountPopup.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", closePopup);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopup();
    });
  }

  if (navMore) {
    navMore.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => {
      navMore.removeAttribute("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") navMore.removeAttribute("open");
    });
    navMore.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => navMore.removeAttribute("open"));
    });
  }

  if (userMenu) {
    userMenu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => userMenu.removeAttribute("open"));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") userMenu.removeAttribute("open");
    });
  }

  if (popupClose) {
    popupClose.addEventListener("click", closePopup);
  }

  document.querySelectorAll("[data-open-login]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPopup();
    });
  });

  if (forgotPasswordBtn) {
    forgotPasswordBtn.addEventListener("click", () => {
      const email = emailInput ? emailInput.value.trim() : "";

      if (!email) {
        alert("請先輸入帳號或 Email，再執行忘記密碼。");
        if (emailInput) emailInput.focus();
        return;
      }

      if (window.authManager && typeof window.authManager.resetPassword === "function") {
        window.authManager.resetPassword(email);
      } else {
        alert("忘記密碼功能尚未接上登入服務。");
      }
    });
  }

  if (backToTopBtn) {
    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  document.querySelectorAll(".nav a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const isHome = href === "/" && path === "/";
    const isCurrent = href !== "/" && path.startsWith(href);
    link.classList.toggle("active", isHome || isCurrent);
  });

  document.querySelectorAll("[data-member-required]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      if (!window.authManager || !window.authManager?.isReady?.()) {
        event.preventDefault();
        await window.waitForSmartInvestAuth();
        if (hasFeatureAccess(link.dataset.memberRequired)) {
          window.location.href = link.href;
        } else {
          window.authManager?.requireMember?.(link.dataset.memberRequired || "會員功能");
        }
        return;
      }
      if (hasFeatureAccess(link.dataset.memberRequired)) return;
      event.preventDefault();
      window.authManager?.requireMember?.(link.dataset.memberRequired || "會員功能");
    });
  });

  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
        }
      });
    }, { threshold: 0.14 });

    revealEls.forEach((el) => obs.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }
}

function hasFeatureAccess(featureName) {
  if (featureName === "會員中心") return Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
  return Boolean(window.authManager?.hasPremiumAccess?.() ?? (window.authManager?.getMembershipTier?.() === "premium"));
}

function applyMemberFeatureGating() {
    const features = document.querySelectorAll("[data-member-feature]");
    if (!features.length) return;

    const allowed = hasFeatureAccess();

    features.forEach((el) => {
      if (allowed) {
        el.classList.remove("member-feature-locked");
        const overlay = el.querySelector(".member-lock-overlay");
        if (overlay) overlay.remove();
      } else {
        el.classList.add("member-feature-locked");
        if (!el.querySelector(".member-lock-overlay")) {
          const overlay = document.createElement("div");
          overlay.className = "member-lock-overlay";
          overlay.innerHTML = '<i class="fas fa-lock"></i><strong>進階會員限定</strong><span>付款開通後即可使用</span>';
          overlay.addEventListener("click", () => {
            window.location.assign(window.authManager?.isLoggedIn?.() ? "/register?step=payment" : "/register");
          });
          el.appendChild(overlay);
        }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initCommonUI();
    if (window.Chart) {
      Chart.defaults.font.size = 16;
      Chart.defaults.font.family = 'Arial, "Microsoft JhengHei", sans-serif';
      Chart.defaults.color = '#796b60';
      Chart.defaults.plugins.legend.labels.usePointStyle = true;
      Chart.defaults.plugins.legend.labels.padding = 20;
    }
    window.waitForSmartInvestAuth?.().then(applyMemberFeatureGating);
    window.addEventListener("smartinvest:auth-state", applyMemberFeatureGating);
  });

