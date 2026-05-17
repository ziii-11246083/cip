import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseConfig = window.__SUPABASE_CONFIG__ || {};
const supabaseUrl = supabaseConfig.url || "";
const supabaseAnonKey = supabaseConfig.anonKey || "";
const GUEST_MODE_KEY = "si_guest_mode";
const DEMO_SESSION_KEY = "smartinvest_demo_member_session";
const DEMO_MEMBER = {
  email: "test@smartinvest.local",
  password: "Test123456",
  token: "smartinvest-demo-member-token"
};
const MEMBER_ONLY_PATHS = ["/health", "/ai-coach", "/agent", "/sim-trade", "/member"];
const MEMBER_ONLY_HINT = "登入後即可使用此功能";

const supabase = supabaseUrl && supabaseAnonKey && !supabaseUrl.includes("dummy")
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

function getDemoSession() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function setDemoSession(email = DEMO_MEMBER.email) {
  localStorage.removeItem(GUEST_MODE_KEY);
  localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify({
    email,
    token: DEMO_MEMBER.token,
    createdAt: Date.now()
  }));
}

function clearDemoSession() {
  localStorage.removeItem(DEMO_SESSION_KEY);
}

function isLoggedIn() {
  return Boolean(getDemoSession());
}

function openLogin() {
  const popup = document.getElementById("accountPopup");
  if (popup) popup.classList.add("show");
  const email = document.getElementById("emailInput");
  if (email) email.focus();
}

function showToast(title, message) {
  const toast = document.getElementById("toast");
  const toastT = document.getElementById("toastT");
  const toastM = document.getElementById("toastM");
  if (!toast || !toastT || !toastM) {
    alert(message || title);
    return;
  }
  toastT.textContent = title;
  toastM.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function setAuthUi() {
  const loginToggle = document.getElementById("loginToggle");
  const userSection = document.getElementById("user-section");
  const userEmail = document.getElementById("user-email");
  const session = getDemoSession();
  const guest = localStorage.getItem(GUEST_MODE_KEY) === "1";

  document.body.classList.toggle("is-logged-in", Boolean(session));
  document.body.classList.toggle("is-guest", !session);

  if (loginToggle) {
    loginToggle.style.display = session ? "none" : "inline-flex";
    loginToggle.onclick = openLogin;
  }
  if (userSection) userSection.style.display = session ? "flex" : "none";
  if (userEmail) userEmail.textContent = session?.email || (guest ? "訪客" : "");

  applyMemberLocks(Boolean(session));
  applyCurrentNavState();
}

function applyMemberLocks(member) {
  document.querySelectorAll("a.member-nav").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const shouldLock = MEMBER_ONLY_PATHS.some((path) => href.startsWith(path));
    link.classList.toggle("member-locked", shouldLock && !member);
    link.classList.toggle("member-unlocked", shouldLock && member);
    link.title = shouldLock && !member ? MEMBER_ONLY_HINT : "";
    const icon = link.querySelector("i");
    if (icon && shouldLock) icon.className = member ? "fas fa-unlock" : "fas fa-lock";

    if (shouldLock && !link.dataset.memberLockBound) {
      link.dataset.memberLockBound = "1";
      link.addEventListener("click", (event) => {
        if (isLoggedIn()) return;
        event.preventDefault();
        requireMember(link.textContent.trim() || "會員功能");
      });
    }
  });

  document.querySelectorAll("[data-member-feature]").forEach((el) => {
    el.classList.toggle("member-feature-locked", !member);
    el.classList.toggle("member-feature-unlocked", member);
    el.title = member ? "" : MEMBER_ONLY_HINT;
  });
}

function applyCurrentNavState() {
  const path = window.location.pathname;
  document.querySelectorAll(".nav a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const active = href === "/" ? path === "/" : path.startsWith(href);
    link.classList.toggle("active", active);
  });
}

function requireMember(featureName = "會員功能") {
  if (isLoggedIn()) return true;
  showToast("請先登入會員", `${featureName}：${MEMBER_ONLY_HINT}`);
  openLogin();
  return false;
}

window.authManager = {
  loginWithEmail: async (email, password) => {
    const cleanEmail = String(email || "").trim();
    const cleanPassword = String(password || "");
    if (!cleanEmail || !cleanPassword) {
      showToast("登入失敗", "請輸入 Email 與密碼。");
      return;
    }

    if (cleanEmail === DEMO_MEMBER.email && cleanPassword === DEMO_MEMBER.password) {
      setDemoSession(cleanEmail);
      showToast("登入成功", "已使用測試會員登入。");
      window.setTimeout(() => window.location.reload(), 450);
      return;
    }

    if (!supabase) {
      showToast("登入失敗", "目前沒有 Supabase 設定，請使用測試會員帳號。");
      return;
    }

    const { error, data } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword
    });
    if (error) {
      showToast("登入失敗", error.message);
      return;
    }
    setDemoSession(data?.user?.email || cleanEmail);
    window.setTimeout(() => window.location.reload(), 450);
  },

  registerWithEmail: async (email, password, profile = {}) => {
    const cleanEmail = String(email || "").trim();
    if (!cleanEmail || !password) {
      showToast("註冊失敗", "請輸入 Email 與密碼。");
      return;
    }
    if (supabase) {
      const { error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: { data: profile }
      });
      if (error) {
        showToast("註冊失敗", error.message);
        return;
      }
    }
    setDemoSession(cleanEmail);
    showToast("會員建立完成", "已先用前端模擬會員登入。");
    window.setTimeout(() => window.location.href = "/member", 650);
  },

  signUpWithEmail: async (email, password) => window.authManager.registerWithEmail(email, password),

  loginWithGoogle: async () => {
    if (!supabase) {
      showToast("Google 登入尚未啟用", "目前沒有 Supabase 設定，請使用測試會員帳號。");
      return;
    }
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href }
    });
  },

  logoutUser: async () => {
    clearDemoSession();
    localStorage.removeItem(GUEST_MODE_KEY);
    if (supabase) await supabase.auth.signOut().catch(() => {});
    showToast("已登出", "會員狀態已清除。");
    window.setTimeout(() => window.location.reload(), 450);
  },

  continueAsGuest: () => {
    clearDemoSession();
    localStorage.setItem(GUEST_MODE_KEY, "1");
    setAuthUi();
    showToast("訪客模式", "會員功能仍需登入後才能使用。");
  },

  resetPassword: async (email) => {
    if (!email) return showToast("請輸入 Email", "填入 Email 後才能寄送重設信。");
    if (!supabase) return showToast("尚未啟用", "目前沒有 Supabase 設定。");
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/register" });
    showToast("已送出", "如果 Email 存在，系統會寄出重設密碼信。");
  },

  isGuestMode: () => localStorage.getItem(GUEST_MODE_KEY) === "1",
  isLoggedIn,
  requireMember,
  openLogin,
  getToken: async () => {
    const demo = getDemoSession();
    if (demo?.token) return demo.token;
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }
};

window.smartInvestMembership = {
  get isLoggedIn() { return isLoggedIn(); },
  get isMember() { return isLoggedIn(); },
  get isGuest() { return !isLoggedIn(); },
  get email() { return getDemoSession()?.email || ""; },
  lockedHint: MEMBER_ONLY_HINT
};

document.addEventListener("DOMContentLoaded", setAuthUi);
