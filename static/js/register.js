const toast = function(title, msg) {
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
      await window.authManager.signUpWithEmail(email, password, {
        display_name: name
      });
      showMessage("success", "註冊成功，請到信箱收驗證信，或直接登入開始使用。");
    } else {
      showMessage("error", "註冊服務尚未初始化，請稍後再試。");
    }
  } catch (err) {
    console.error(err);
    showMessage("error", "註冊失敗，請確認登入服務或後端設定。");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-plus"></i> 建立帳戶';
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
        window.authManager.loginWithGoogle();
      } else {
        toast("尚未串接 Google 註冊", "請確認 auth.js 是否已提供 loginWithGoogle()。");
      }
    });
  }

  initPasswordToggle();
  validatePassword();
});
