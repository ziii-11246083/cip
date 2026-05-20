import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseConfig = window.__SUPABASE_CONFIG__ || {};
const supabaseUrl = supabaseConfig.url || "";
const supabaseAnonKey = supabaseConfig.anonKey || "";
const GUEST_MODE_KEY = "si_guest_mode";

const supabase = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey)
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
        console.log("[auth] redirect session", session);
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
}

function setAuthUiBySession(session) {
    const loginSection = document.getElementById("login-section");
    const userSection = document.getElementById("user-section");
    const userEmail = document.getElementById("user-email");
    const isGuest = localStorage.getItem(GUEST_MODE_KEY) === "1";

    if (session && session.user) {
        localStorage.removeItem(GUEST_MODE_KEY);
        if (loginSection) loginSection.style.display = "none";
        if (userSection) userSection.style.display = "flex";
        if (userEmail) userEmail.innerText = session.user.email || "已登入";
    } else if (isGuest) {
        if (loginSection) loginSection.style.display = "none";
        if (userSection) userSection.style.display = "flex";
        if (userEmail) userEmail.innerText = "訪客模式";
    } else {
        if (loginSection) loginSection.style.display = "flex";
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
    const label = featureName ? `${featureName} 需要登入會員才能使用。` : "此功能需要登入會員才能使用。";
    if (typeof window.toast === "function") {
        window.toast("需要登入", label);
    } else {
        alert(label);
    }
    openLoginPopup();
    return false;
}

async function refreshSession() {
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
    console.log("[auth] refresh session", currentSession);
    return currentSession;
}

window.authManager = {
    loginWithGoogle: async () => {
        if (!requireSupabase()) return;
        try {
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
        if (!requireSupabase()) return;
        if (!email || !password) return alert("請輸入信箱與密碼");
        try {
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
            localStorage.removeItem(GUEST_MODE_KEY);
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
        localStorage.setItem(GUEST_MODE_KEY, "1");
        updateMembership(null);
        setAuthUiBySession(null);
        alert("已切換為訪客模式");
    },
    isGuestMode: () => localStorage.getItem(GUEST_MODE_KEY) === "1",
    isLoggedIn: () => isLoggedIn(),
    requireMember: (featureName) => {
        if (isLoggedIn()) return true;
        return notifyRequireLogin(featureName);
    },
    openLogin: () => openLoginPopup(),
    getToken: async () => {
        if (localStorage.getItem(GUEST_MODE_KEY) === "1") return null;
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
        await applyAuthFromUrl();
        await refreshSession();
        supabase.auth.onAuthStateChange((_event, session) => {
            currentSession = session || null;
            updateMembership(session || null);
            setAuthUiBySession(session || null);
            console.log("[auth] onAuthStateChange", _event, session);
            if (session) {
                clearUrlHashAfterLogin();
            }
        });
    })();
} else {
    updateMembership(null);
    setAuthUiBySession(null);
}