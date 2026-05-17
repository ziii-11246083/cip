window.__COMMON_UI_ACTIVE__ = true;

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

document.addEventListener("DOMContentLoaded", initCommonUI);
