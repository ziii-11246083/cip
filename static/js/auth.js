import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseConfig = window.__SUPABASE_CONFIG__ || {};
const supabaseUrl = supabaseConfig.url || "";
const supabaseAnonKey = supabaseConfig.anonKey || "";
const GUEST_MODE_KEY = "si_guest_mode";

const supabase = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

function requireSupabase() {
    if (!supabase) {
        alert("Supabase 設定未完成，請檢查 SUPABASE_URL 與 SUPABASE_ANON_KEY");
        return false;
    }
    return true;
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

window.authManager = {
    loginWithGoogle: async () => {
        if (!requireSupabase()) return;
        try {
            localStorage.removeItem(GUEST_MODE_KEY);
            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: window.location.href,
                },
            });
            if (error) throw error;
        } catch (error) {
            alert(`Google 登入失敗: ${error.message}`);
        }
    },
    loginWithEmail: async (email, password) => {
        if (!requireSupabase()) return;
        if(!email || !password) return alert("請輸入信箱與密碼");
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
    signUpWithEmail: async (email, password) => {
        if (!requireSupabase()) return;
        if(!email || !password) return alert("請輸入信箱與密碼");
        try {
            localStorage.removeItem(GUEST_MODE_KEY);
            const { error } = await supabase.auth.signUp({ email, password });
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
    continueAsGuest: () => {
        localStorage.setItem(GUEST_MODE_KEY, "1");
        setAuthUiBySession(null);
        alert("已切換為訪客模式");
    },
    isGuestMode: () => localStorage.getItem(GUEST_MODE_KEY) === "1",
    getToken: async () => {
        if (localStorage.getItem(GUEST_MODE_KEY) === "1") return null;
        if (!supabase) return null;
        const { data, error } = await supabase.auth.getSession();
        if (error) return null;
        const session = data?.session;
        if (session?.access_token) return session.access_token;
        return null;
    }
};

// 監聽登入狀態並自動切換導覽列 UI
if (supabase) {
    supabase.auth.getSession().then(({ data }) => {
        setAuthUiBySession(data?.session || null);
    });
    supabase.auth.onAuthStateChange((_event, session) => {
        setAuthUiBySession(session);
    });
} else {
    setAuthUiBySession(null);
}