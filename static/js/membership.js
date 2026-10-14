(function () {
  const $ = (id) => document.getElementById(id);

  function renderMembership() {
    const loggedIn = Boolean(window.authManager?.isLoggedIn?.());
    const premium = loggedIn && window.authManager?.getMembershipTier?.() === "premium";
    const status = $("membershipAccountStatus");
    if (status) {
      status.textContent = !loggedIn
        ? "公開功能免登入；加入進階會員需建立帳號並完成付款。"
        : premium
          ? "目前方案：進階會員"
          : "帳號已建立，尚未開通進階會員。";
    }
    $("membershipFreePlan")?.classList.remove("is-current");
    $("membershipPremiumPlan")?.classList.toggle("is-current", premium);
    const freeAction = $("membershipFreeAction");
    if (freeAction) {
      freeAction.href = "/market";
      freeAction.innerHTML = '開始看市場 <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    }
    const joinButton = $("joinPremiumBtn");
    if (joinButton) {
      joinButton.innerHTML = premium
        ? '前往會員中心 <i class="fas fa-arrow-right" aria-hidden="true"></i>'
        : loggedIn
          ? '繼續付款開通 <i class="fas fa-arrow-right" aria-hidden="true"></i>'
          : '建立帳號並加入進階會員 <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    }
  }

  async function joinPremium() {
    await window.authManager?.ensureReady?.();
    if (window.authManager?.getMembershipTier?.() === "premium") {
      window.location.assign("/member");
      return;
    }
    window.location.assign(window.authManager?.isLoggedIn?.() ? "/register?step=payment" : "/register");
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
