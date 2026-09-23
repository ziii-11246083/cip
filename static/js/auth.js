import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseConfig = window.__SUPABASE_CONFIG__ || {};
const supabaseUrl = supabaseConfig.url || "";
const supabaseAnonKey = supabaseConfig.anonKey || "";
const GUEST_MODE_KEY = "si_guest_mode";
const DEMO_MEMBER_KEY = "si_demo_member";
const DEMO_MEMBER_TOKEN = "smartinvest-demo-member-token";
const DEMO_MEMBER_EMAIL = "test@smartinvest.local";
const DEMO_MEMBER_PASSWORD = "Test123456";
const AI_COACH_CONVERSATION_KEY = "smartinvest_ai_coach_conversation_id";
const SUPABASE_STORAGE_KEY = "smartinvest_supabase_auth";

const supabase = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: window.localStorage,
            storageKey: SUPABASE_STORAGE_KEY
        }
    })
    : null;

const AUTH_HASH_KEYS = new Set([
    "access_token",
    "refresh_token",
    "expires_in",
    "token_type",
    "provider_token",
    "provider_refresh_token",
    "error",
    "error_description"
]);

let currentSession = null;
let authReady = false;
let resolveAuthReady;
const authReadyPromise = new Promise((resolve) => {
    resolveAuthReady = resolve;
});

function markAuthReady() {
    if (authReady) return;
    authReady = true;
    window.smartInvestAuthReady = true;
    resolveAuthReady?.(currentSession);
    window.dispatchEvent(new CustomEvent("smartinvest:auth-ready", {
        detail: {
            isMember: isLoggedIn(),
            email: currentSession?.user?.email || "",
            userId: currentSession?.user?.id || ""
        }
    }));
}

function buildDemoSession() {
    return {
        access_token: DEMO_MEMBER_TOKEN,
        user: {
            id: "demo-member",
            email: DEMO_MEMBER_EMAIL,
            is_demo: true
        }
    };
}

function isDemoMemberActive() {
    return localStorage.getItem(DEMO_MEMBER_KEY) === "1" || sessionStorage.getItem(DEMO_MEMBER_KEY) === "1";
}

function activateDemoMember() {
    localStorage.setItem(DEMO_MEMBER_KEY, "1");
    sessionStorage.removeItem(DEMO_MEMBER_KEY);
    localStorage.removeItem(GUEST_MODE_KEY);
    currentSession = buildDemoSession();
    updateMembership(currentSession);
    setAuthUiBySession(currentSession);
    markAuthReady();
}

function applyAuthState(session) {
    // Supabase 會在初始化時送出 INITIAL_SESSION(null)。Demo 會員是本機
    // session，不能被這個空事件覆寫，否則切頁時 UI 會看起來像自動登出。
    if (session && !session.user?.is_demo) {
        localStorage.removeItem(DEMO_MEMBER_KEY);
        sessionStorage.removeItem(DEMO_MEMBER_KEY);
    }
    const effectiveSession = (!session && isDemoMemberActive())
        ? buildDemoSession()
        : (session || null);
    currentSession = effectiveSession;
    updateMembership(effectiveSession);
    setAuthUiBySession(effectiveSession);
    return effectiveSession;
}

function requireSupabase() {
    if (!supabase) {
        alert("Supabase 設定未完成，請檢查 SUPABASE_URL 與 SUPABASE_ANON_KEY");
        return false;
    }
    return true;
}

function isLoggedIn() {
    return Boolean(currentSession?.access_token && currentSession?.user);
}

function getUserLabel(user) {
    const metadata = user?.user_metadata || {};
    const email = String(user?.email || "").trim();
    return metadata.display_name || metadata.full_name || metadata.name || email.split("@")[0] || "Smart Invest 會員";
}

function getCleanRedirectUrl() {
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

function normalizeHash(hashValue) {
    return String(hashValue || "").replace(/^#+/, "");
}

function parseAuthHash(hashValue) {
    const normalized = normalizeHash(hashValue);
    if (!normalized) return null;
    const params = new URLSearchParams(normalized);
    const hasAuthKeys = [...params.keys()].some((key) => AUTH_HASH_KEYS.has(key));
    return hasAuthKeys ? params : null;
}

function getAuthUrlSnapshot() {
    const hash = window.location.hash || "";
    const search = window.location.search || "";
    return {
        hash,
        search,
        hasHash: Boolean(hash && hash !== "#"),
        hasSearch: Boolean(search && search !== "?")
    };
}

function clearUrlHashAfterLogin() {
    window.history.replaceState(null, null, window.location.pathname);
}

async function applyAuthFromUrl() {
    if (!supabase) return { handled: false, session: null };

    const snapshot = getAuthUrlSnapshot();
    const hashParams = parseAuthHash(snapshot.hash);
    const searchParams = snapshot.hasSearch ? new URLSearchParams(snapshot.search) : null;
    let session = null;
    let handled = false;

    if (hashParams) {
        handled = true;
        if (typeof supabase.auth.getSessionFromUrl === "function") {
            try {
                const { data, error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
                if (error) {
                    console.warn("Supabase getSessionFromUrl failed", error);
                }
                session = data?.session || null;
            } catch (error) {
                console.warn("Supabase getSessionFromUrl error", error);
            }
        } else {
            const accessToken = hashParams.get("access_token");
            const refreshToken = hashParams.get("refresh_token");
            if (accessToken && refreshToken) {
                try {
                    const { data, error } = await supabase.auth.setSession({
                        access_token: accessToken,
                        refresh_token: refreshToken
                    });
                    if (error) {
                        console.warn("Supabase setSession failed", error);
                    }
                    session = data?.session || null;
                } catch (error) {
                    console.warn("Supabase setSession error", error);
                }
            }
        }
    }

    if (!session && searchParams && searchParams.get("code") && typeof supabase.auth.exchangeCodeForSession === "function") {
        handled = true;
        try {
            const { data, error } = await supabase.auth.exchangeCodeForSession(searchParams.get("code"));
            if (error) {
                console.warn("Supabase exchangeCodeForSession failed", error);
            }
            session = data?.session || null;
        } catch (error) {
            console.warn("Supabase exchangeCodeForSession error", error);
        }
    }

    if (session) {
        currentSession = session;
        updateMembership(session);
        setAuthUiBySession(session);
        console.log("[auth] redirect session restored", Boolean(session));
        clearUrlHashAfterLogin();
    }

    return { handled, session };
}

function updateMembership(session) {
    const user = session?.user || null;
    if (user) {
        window.smartInvestMembership = {
            isMember: true,
            email: user.email || "已登入"
        };
    } else {
        window.smartInvestMembership = {
            isMember: false,
            email: ""
        };
    }

    const isGuest = localStorage.getItem(GUEST_MODE_KEY) === "1";
    document.body?.classList.toggle("is-logged-in", Boolean(user));
    document.body?.classList.toggle("is-guest", !user);
    document.body?.classList.toggle("is-guest-mode", !user && isGuest);
    document.body?.classList.toggle("is-member-locked", !Boolean(user));
    document.querySelectorAll(".member-nav i").forEach((icon) => {
        icon.classList.toggle("fa-lock", !user);
        icon.classList.toggle("fa-unlock", Boolean(user));
    });
    window.dispatchEvent(new CustomEvent("smartinvest:auth-state", {
        detail: {
            isMember: Boolean(user),
            isGuest,
            email: user?.email || "",
            userId: user?.id || ""
        }
    }));
}

function setAuthUiBySession(session) {
    const loginToggle = document.getElementById("loginToggle");
    const guestButton = document.querySelector(".auth-area > .guest-btn");
    const accountPopup = document.getElementById("accountPopup");
    const userSection = document.getElementById("user-section");
    const userEmail = document.getElementById("user-email");
    const userName = document.getElementById("user-name");
    const isGuest = localStorage.getItem(GUEST_MODE_KEY) === "1";

    if (session && session.user) {
        localStorage.removeItem(GUEST_MODE_KEY);
        if (loginToggle) loginToggle.style.display = "none";
        if (guestButton) guestButton.style.display = "none";
        if (accountPopup) accountPopup.classList.remove("show");
        if (userSection) userSection.style.display = "block";
        if (userName) userName.innerText = getUserLabel(session.user);
        if (userEmail) userEmail.innerText = session.user.email || "已登入";
    } else if (isGuest) {
        if (loginToggle) loginToggle.style.display = "inline-flex";
        if (guestButton) guestButton.style.display = "none";
        if (userSection) userSection.style.display = "block";
        if (userName) userName.innerText = "訪客模式";
        if (userEmail) userEmail.innerText = "訪客模式";
    } else {
        if (loginToggle) loginToggle.style.display = "inline-flex";
        if (guestButton) guestButton.style.display = "inline-flex";
        if (userSection) userSection.style.display = "none";
    }
}

function openLoginPopup() {
    const accountPopup = document.getElementById("accountPopup");
    const emailInput = document.getElementById("emailInput");
    if (accountPopup) accountPopup.classList.add("show");
    if (emailInput) emailInput.focus();
}

function notifyRequireLogin(featureName) {
    if (typeof window.toast === "function") {
        window.toast("會員限定", "請登入");
    } else {
        alert("會員限定\n請登入");
    }
    openLoginPopup();
    return false;
}

async function refreshSession() {
    if (isDemoMemberActive()) {
        currentSession = buildDemoSession();
        updateMembership(currentSession);
        setAuthUiBySession(currentSession);
        return currentSession;
    }
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        currentSession = data?.session || null;
    } catch (error) {
        console.warn("Supabase session read failed", error);
        currentSession = null;
    }
    updateMembership(currentSession);
    setAuthUiBySession(currentSession);
    console.log("[auth] refresh session restored", Boolean(currentSession));
    return currentSession;
}

window.authManager = {
    loginWithGoogle: async () => {
        if (!requireSupabase()) return;
        try {
            localStorage.removeItem(DEMO_MEMBER_KEY);
            sessionStorage.removeItem(DEMO_MEMBER_KEY);
            localStorage.removeItem(GUEST_MODE_KEY);
            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: getCleanRedirectUrl(),
                },
            });
            if (error) throw error;
        } catch (error) {
            alert(`Google 登入失敗: ${error.message}`);
        }
    },
    loginWithEmail: async (email, password) => {
        if (!email || !password) return alert("請輸入信箱與密碼");
        if (email.trim().toLowerCase() === DEMO_MEMBER_EMAIL && password === DEMO_MEMBER_PASSWORD) {
            activateDemoMember();
            alert("已使用 Demo 會員登入");
            return;
        }
        if (!requireSupabase()) return;
        try {
            localStorage.removeItem(DEMO_MEMBER_KEY);
            sessionStorage.removeItem(DEMO_MEMBER_KEY);
            localStorage.removeItem(GUEST_MODE_KEY);
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            alert("登入成功！");
            window.location.reload();
        } catch (error) {
            alert(`登入失敗: ${error.message}`);
        }
    },
    signUpWithEmail: async (email, password, metadata = {}) => {
        if (!requireSupabase()) return;
        if (!email || !password) return alert("請輸入信箱與密碼");
        try {
            localStorage.removeItem(DEMO_MEMBER_KEY);
            sessionStorage.removeItem(DEMO_MEMBER_KEY);
            localStorage.removeItem(GUEST_MODE_KEY);
            const safeMeta = metadata && typeof metadata === "object" ? metadata : {};
            const payload = { email, password };
            if (Object.keys(safeMeta).length) {
                payload.options = { data: safeMeta };
            }
            const { error } = await supabase.auth.signUp(payload);
            if (error) throw error;
            alert("註冊成功，請檢查信箱完成驗證（若已關閉驗證則會直接登入）");
            window.location.reload();
        } catch (error) {
            alert(`註冊失敗: ${error.message}`);
        }
    },
    logoutUser: async () => {
        try {
            localStorage.removeItem(DEMO_MEMBER_KEY);
            sessionStorage.removeItem(DEMO_MEMBER_KEY);
            localStorage.removeItem(GUEST_MODE_KEY);
            localStorage.removeItem(AI_COACH_CONVERSATION_KEY);
            localStorage.removeItem("conversation_id");
            if (supabase) {
                const { error } = await supabase.auth.signOut();
                if (error) throw error;
            }
            alert("已登出");
            window.location.reload();
        } catch (error) {
            console.error("登出失敗", error);
        }
    },
    resetPassword: async (email) => {
        if (!requireSupabase()) return;
        if (!email) return alert("請先輸入 Email");
        try {
            const { error } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: getCleanRedirectUrl()
            });
            if (error) throw error;
            alert("已送出重設密碼信件，請至信箱查看。");
        } catch (error) {
            alert(`重設密碼失敗: ${error.message}`);
        }
    },
    continueAsGuest: () => {
            localStorage.removeItem(DEMO_MEMBER_KEY);
            sessionStorage.removeItem(DEMO_MEMBER_KEY);
        localStorage.removeItem(AI_COACH_CONVERSATION_KEY);
        localStorage.removeItem("conversation_id");
        localStorage.setItem(GUEST_MODE_KEY, "1");
        currentSession = null;
        updateMembership(null);
        setAuthUiBySession(null);
        alert("已切換為訪客模式");
    },
    isGuestMode: () => localStorage.getItem(GUEST_MODE_KEY) === "1",
    isDemoMember: () => isDemoMemberActive(),
    isLoggedIn: () => isLoggedIn(),
    isReady: () => authReady,
    whenReady: () => authReadyPromise,
    ensureReady: async () => {
        if (!authReady) await authReadyPromise;
        return currentSession;
    },
    requireMember: (featureName) => {
        if (isLoggedIn()) return true;
        return notifyRequireLogin(featureName);
    },
    openLogin: () => openLoginPopup(),
    getUserId: () => currentSession?.user?.id || null,
    getToken: async () => {
        if (localStorage.getItem(GUEST_MODE_KEY) === "1") return null;
        if (isDemoMemberActive()) {
            currentSession = buildDemoSession();
            updateMembership(currentSession);
            return DEMO_MEMBER_TOKEN;
        }
        if (!supabase) return null;
        try {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            const session = data?.session;
            if (session?.access_token) {
                currentSession = session;
                updateMembership(session);
                return session.access_token;
            }
        } catch (error) {
            console.warn("Supabase token read failed", error);
        }
        return null;
    }
};

// 監聽登入狀態並自動切換導覽列 UI
if (supabase) {
    (async () => {
        try {
            await applyAuthFromUrl();
            await refreshSession();
            supabase.auth.onAuthStateChange((_event, session) => {
                const effectiveSession = applyAuthState(session);
                console.log("[auth] onAuthStateChange", _event, Boolean(effectiveSession));
                if (effectiveSession && !effectiveSession.user?.is_demo) {
                    clearUrlHashAfterLogin();
                }
            });
        } finally {
            markAuthReady();
        }
    })();
} else {
    refreshSession().finally(markAuthReady);
}
