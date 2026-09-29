(function () {
  const $ = (id) => document.getElementById(id);

  function renderMembership() {
    const loggedIn = Boolean(window.authManager?.isLoggedIn?.());
    const premium = loggedIn && window.authManager?.getMembershipTier?.() === "premium";
    const status = $("membershipAccountStatus");
    if (status) {
      status.textContent = !loggedIn
        ? "尚未登入。你可以先比較方案，加入進階會員前需登入。"
        : premium
          ? "目前方案：進階會員"
          : "目前方案：免費會員";
    }
    $("membershipFreePlan")?.classList.toggle("is-current", loggedIn && !premium);
    $("membershipPremiumPlan")?.classList.toggle("is-current", premium);
    const freeAction = $("membershipFreeAction");
    if (freeAction) {
      freeAction.href = loggedIn ? "/member" : "/register";
      freeAction.innerHTML = loggedIn
        ? '前往會員中心 <i class="fas fa-arrow-right" aria-hidden="true"></i>'
        : '建立免費帳號 <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    }
    const joinButton = $("joinPremiumBtn");
    if (joinButton) {
      joinButton.innerHTML = premium
        ? '前往會員中心 <i class="fas fa-arrow-right" aria-hidden="true"></i>'
        : loggedIn
          ? '加入進階會員 <i class="fas fa-arrow-right" aria-hidden="true"></i>'
          : '登入後加入進階會員 <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    }
  }

  async function joinPremium() {
    await window.authManager?.ensureReady?.();
    if (!window.authManager?.isLoggedIn?.()) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      window.authManager?.openLogin?.();
      return;
    }
    if (window.authManager?.getMembershipTier?.() === "premium") {
      window.location.assign("/member");
      return;
    }
    const dialog = $("membershipDialog");
    if (typeof dialog?.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("joinPremiumBtn")?.addEventListener("click", joinPremium);
    $("membershipDialogClose")?.addEventListener("click", () => {
      const dialog = $("membershipDialog");
      if (typeof dialog?.close === "function") dialog.close();
      else dialog?.removeAttribute("open");
    });
    window.authManager?.whenReady?.().then(renderMembership);
    window.addEventListener("smartinvest:auth-state", renderMembership);
    renderMembership();
  });
})();
