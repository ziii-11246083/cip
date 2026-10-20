const registerToast = function(title, msg) {
  const el = document.getElementById("toast");
  const titleEl = document.getElementById("toastT");
  const msgEl = document.getElementById("toastM");

  if (!el || !titleEl || !msgEl) return;

  titleEl.textContent = title;
  msgEl.textContent = msg;
  el.style.display = "block";

  clearTimeout(el._t);
  el._t = setTimeout(function() {
    el.style.display = "none";
  }, 3600);
};

// Only a resumable UI step is stored. Credentials and payment state are never stored here.
const JOIN_FLOW_KEY = "smartinvest_join_step";
let joinFlow = {};
try { joinFlow = JSON.parse(sessionStorage.getItem(JOIN_FLOW_KEY) || "{}") || {}; } catch {}
function saveJoinFlow() {
  try { sessionStorage.setItem(JOIN_FLOW_KEY, JSON.stringify(joinFlow)); } catch {}
}
function updateJoinAccount() {
  const loggedIn = Boolean(window.authManager?.isLoggedIn?.());
  const ready = loggedIn || Boolean(joinFlow.accountCreated);
  const existing = document.getElementById("existingAccountPanel");
  const fresh = document.getElementById("newAccountPanel");
  if (existing) existing.hidden = !ready;
  if (fresh) fresh.hidden = ready;
  const name = document.getElementById("joinAccountName");
  if (name) name.textContent = loggedIn ? (window.authManager?.getProfile?.()?.displayName || "已登入帳號") : "帳號已建立";
  const status = document.getElementById("joinAccountStatus");
  if (status) status.textContent = loggedIn ? "帳號已準備好，可繼續確認付款。" : "請先完成信箱驗證並登入，帳號會保留。";
}
function showJoinPayment(scroll = true, previewOnly = false) {
  const loggedIn = Boolean(window.authManager?.isLoggedIn?.());
  if (!loggedIn && !joinFlow.accountCreated && !previewOnly) return;
  if (previewOnly && !loggedIn && !joinFlow.accountCreated) joinFlow.previewOnly = true;
  else delete joinFlow.previewOnly;
  joinFlow.stage = "payment";
  joinFlow.oauth = false;
  saveJoinFlow();
  const account = document.getElementById("joinAccountStep"), payment = document.getElementById("joinPaymentStep");
  if (account) account.hidden = true;
  if (payment) payment.hidden = false;
  document.getElementById("joinStepAccount")?.removeAttribute("aria-current");
  document.getElementById("joinStepPayment")?.setAttribute("aria-current", "step");
  const note = document.getElementById("paymentAccountNote");
  if (note) note.textContent = loggedIn ? "帳號已登入，方案金額為 99 TWD。" : joinFlow.accountCreated ? "帳號已建立。請先完成信箱驗證並登入；付款服務尚未開放，可先查看流程。" : "尚未建立帳號。目前為付款畫面預覽，未建立帳號、訂單或開通權限。";
  if (scroll) payment?.scrollIntoView({behavior:"smooth",block:"start"});
}
function showJoinAccount() {
  joinFlow.stage = "account"; saveJoinFlow();
  const account = document.getElementById("joinAccountStep"), payment = document.getElementById("joinPaymentStep");
  if (account) account.hidden = false;
  if (payment) payment.hidden = true;
  document.getElementById("joinStepPayment")?.removeAttribute("aria-current");
  document.getElementById("joinStepAccount")?.setAttribute("aria-current", "step");
  updateJoinAccount();
}
function showPaymentPreview(success) {
  const dialog = document.getElementById("checkoutPreviewDialog");
  if (!dialog || dialog.open) return;
  document.getElementById("checkoutResultIcon").textContent = success ? "✓" : "!";
  dialog.classList.toggle("is-failure", !success);
  document.getElementById("checkoutResultTitle").textContent = success ? "會員已開通（畫面預覽）" : "付款未完成（畫面預覽）";
  document.getElementById("checkoutResultText").textContent = success ? "正式付款成功後，這裡會確認開通並顯示有效期間。目前僅預覽，不會開通進階權限。" : "帳號會保留，你可以重新付款或稍後再繼續。未付款時，進階功能保持鎖定。";
  const expiry = new Date();
  // Calendar-month expiry is illustrative only; actual expiry must come from the server.
  const day = expiry.getDate(); expiry.setDate(1); expiry.setMonth(expiry.getMonth()+2); expiry.setDate(0);
  const lastDay = expiry.getDate(); expiry.setDate(Math.min(day,lastDay));
  document.getElementById("checkoutResultExpiry").textContent = success ? `到期日示意：${expiry.toLocaleDateString("zh-TW",{timeZone:"Asia/Taipei"})}（以正式開通資料為準）` : "";
  dialog.showModal();
}

function showMessage(type, text) {
  const box = document.getElementById("messageBox");
  if (!box) return;

  box.className = "message-box show " + type;
  box.textContent = text;
}

function clearMessage() {
  const box = document.getElementById("messageBox");
  if (!box) return;

  box.className = "message-box";
  box.textContent = "";
}

function validatePassword() {
  const password = document.getElementById("registerPassword").value;
  const hintLength = document.getElementById("hintLength");
  const hintLetter = document.getElementById("hintLetter");

  const hasLength = password.length >= 8;
  const hasLetterOrNumber = /[A-Za-z0-9]/.test(password);

  if (hintLength) hintLength.classList.toggle("ok", hasLength);
  if (hintLetter) hintLetter.classList.toggle("ok", hasLetterOrNumber);

  return hasLength && hasLetterOrNumber;
}

async function registerUser(e) {
  e.preventDefault();
  if (document.getElementById("btnRegister")?.disabled) return;
  clearMessage();

  const name = document.getElementById("displayName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  const agree = document.getElementById("agreeTerms").checked;
  const btn = document.getElementById("btnRegister");

  if (!name) {
    showMessage("error", "請先輸入暱稱。");
    return;
  }

  if (!email) {
    showMessage("error", "請先輸入電子信箱。");
    return;
  }

  if (!validatePassword()) {
    showMessage("error", "密碼至少需要 8 個字元，且包含英文或數字。");
    return;
  }

  if (password !== confirmPassword) {
    showMessage("error", "兩次輸入的密碼不一致。");
    return;
  }

  if (!agree) {
    showMessage("error", "請先勾選使用說明。");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 建立中...';

  try {
    if (window.authManager && typeof window.authManager.signUpWithEmail === "function") {
      const success = await window.authManager.signUpWithEmail(email, password, {
        display_name: name
      }, {reload:false, notify:false});
      if (success) {
        joinFlow.accountCreated = true;
        saveJoinFlow();
        document.getElementById("registerPassword").value = "";
        document.getElementById("confirmPassword").value = "";
        showMessage("success", "帳號已建立。請依信箱通知完成驗證；付款後才會開通進階功能。");
        updateJoinAccount();
        showJoinPayment();
      } else {
        showMessage("error", "目前無法建立帳號，請稍後再試；若已有帳號，請直接登入。");
      }
    } else {
      showMessage("error", "註冊服務尚未初始化，請稍後再試。");
    }
  } catch (err) {
    console.error(err);
    showMessage("error", "目前無法建立帳號，請稍後再試；若已有帳號，請直接登入。");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '建立帳號並前往付款 <i class="fas fa-arrow-right" aria-hidden="true"></i>';
  }
}

function initPasswordToggle() {
  document.querySelectorAll(".togglePassword").forEach(function(btn) {
    btn.addEventListener("click", function() {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const icon = btn.querySelector("i");

      if (!input) return;

      if (input.type === "password") {
        input.type = "text";
        if (icon) icon.className = "fas fa-eye-slash";
      } else {
        input.type = "password";
        if (icon) icon.className = "fas fa-eye";
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", function() {
  const passwordInput = document.getElementById("registerPassword");
  const registerForm = document.getElementById("registerForm");
  const btnGoogleRegister = document.getElementById("btnGoogleRegister");

  if (passwordInput) {
    passwordInput.addEventListener("input", validatePassword);
  }

  if (registerForm) {
    registerForm.addEventListener("submit", registerUser);
  }

  if (btnGoogleRegister) {
    btnGoogleRegister.addEventListener("click", function() {
      if (window.authManager && typeof window.authManager.loginWithGoogle === "function") {
        joinFlow.oauth = true; saveJoinFlow();
        window.authManager.loginWithGoogle();
      } else {
        registerToast("尚未串接 Google 註冊", "請確認 auth.js 是否已提供 loginWithGoogle()。");
      }
    });
  }

  initPasswordToggle();
  validatePassword();
  document.getElementById("btnContinuePayment")?.addEventListener("click", () => showJoinPayment());
  document.getElementById("btnViewCheckoutPreview")?.addEventListener("click", () => showJoinPayment(true, true));
  document.getElementById("btnBackAccount")?.addEventListener("click", showJoinAccount);
  document.getElementById("btnPayLater")?.addEventListener("click", () => {
    showJoinAccount(); showMessage("success", window.authManager?.isLoggedIn?.() || joinFlow.accountCreated ? "已保留目前步驟，之後可登入並繼續付款。進階權限未變更。" : "已返回建立帳號。剛才僅為畫面預覽，尚未建立帳號或付款。");
  });
  document.getElementById("btnPreviewPaymentSuccess")?.addEventListener("click", () => showPaymentPreview(true));
  document.getElementById("btnPreviewPaymentFailure")?.addEventListener("click", () => showPaymentPreview(false));
  document.getElementById("checkoutResultClose")?.addEventListener("click", () => document.getElementById("checkoutPreviewDialog")?.close());
  const syncJoin = () => {
    updateJoinAccount();
    if ((joinFlow.oauth || joinFlow.stage === "payment" || new URLSearchParams(location.search).get("step") === "payment") && (window.authManager?.isLoggedIn?.() || joinFlow.accountCreated || joinFlow.previewOnly)) showJoinPayment(false, Boolean(joinFlow.previewOnly));
  };
  window.addEventListener("smartinvest:auth-state", syncJoin);
  window.authManager?.whenReady?.().then(syncJoin);
  syncJoin();
});
