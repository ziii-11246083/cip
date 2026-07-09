document.documentElement.classList.add("js-enabled");
window.__COMMON_UI_ACTIVE__ = true;

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
        const loggedInAfterReady = Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
        if (loggedInAfterReady) {
          window.location.href = link.href;
        } else {
          window.authManager?.requireMember?.(link.dataset.memberRequired || "會員功能");
        }
        return;
      }
      const loggedIn = Boolean(window.authManager?.isLoggedIn?.() || window.smartInvestMembership?.isMember);
      if (loggedIn) return;
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

function applyMemberFeatureGating() {
    const features = document.querySelectorAll("[data-member-feature]");
    if (!features.length) return;

    const loggedIn = Boolean(
      window.authManager?.isLoggedIn?.() ||
      window.smartInvestMembership?.isMember
    );

    features.forEach((el) => {
      if (loggedIn) {
        el.classList.remove("member-feature-locked");
        const overlay = el.querySelector(".member-lock-overlay");
        if (overlay) overlay.remove();
      } else {
        el.classList.add("member-feature-locked");
        if (!el.querySelector(".member-lock-overlay")) {
          const overlay = document.createElement("div");
          overlay.className = "member-lock-overlay";
          overlay.setAttribute("data-open-login", "");
          overlay.innerHTML = '<i class="fas fa-lock"></i><strong>會員限定功能</strong>';
          overlay.addEventListener("click", () => {
            window.authManager?.openLogin?.();
          });
          el.appendChild(overlay);
        }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initCommonUI();
    window.waitForSmartInvestAuth?.().then(applyMemberFeatureGating);
    window.addEventListener("smartinvest:auth-state", applyMemberFeatureGating);
  });
