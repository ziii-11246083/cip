"""
TASK 02（Codex 複審）— app 初始化順序與 legacy metrics 隱私測試。

驗證：
  - app.py 的 load_dotenv() 在 trace singleton 建立之前執行，
    讓 .env 中的 HMAC secret / service-role credential 在初始化時可見。
  - 以上行為在隔離 subprocess（cwd=temp dir、僅 .env 提供憑證）重現。
測試不輸出、不保存任何真實 secret。
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

try:
    import flask  # noqa: F401
    HAVE_FLASK = True
except ImportError:
    HAVE_FLASK = False


class AppInitOrderTests(unittest.TestCase):
    def test_load_dotenv_before_trace_singleton_in_source(self):
        src = (PROJECT_ROOT / "app.py").read_text(encoding="utf-8")
        dotenv_pos = src.find("load_dotenv()")
        trace_pos = src.find("_get_trace_service()")
        self.assertNotEqual(dotenv_pos, -1, "app.py 必須呼叫 load_dotenv()")
        self.assertNotEqual(trace_pos, -1, "app.py 必須建立 trace singleton")
        self.assertLess(
            dotenv_pos, trace_pos,
            "load_dotenv() 必須在 trace singleton 建立之前，否則 .env 憑證會被誤判 missing")

    @unittest.skipUnless(HAVE_FLASK, "需要 flask（僅在測試 venv 執行）")
    def test_dotenv_credentials_visible_after_app_init(self):
        script = (
            "import sys\n"
            "sys.path.insert(0, {project!r})\n"
            "import app as app_module\n"
            "t = app_module._trace\n"
            "print('HMAC_OK=%d' % (1 if t._hmac_secret else 0))\n"
            "print('DB_DISABLED=%s' % (t._db_store.disabled_reason or 'None'))\n"
        ).format(project=str(PROJECT_ROOT))

        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            # 合成憑證（非真實）：僅用於驗證載入順序
            env_file.write_text(
                "RAG_TRACE_HMAC_SECRET=fake-hmac-secret-0123456789abcdef0123456789abcdef\n"
                "SUPABASE_URL=https://example.supabase.co\n"
                "SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key-0123456789abcdef\n"
                "SUPABASE_ANON_KEY=\n"
                "SUPABASE_KEY=\n",
                encoding="utf-8",
            )
            # 清掉繼承環境中的憑證類變數，確保「只有 .env 提供」
            env = {
                k: v for k, v in os.environ.items()
                if not k.startswith(("SUPABASE", "RAG_TRACE", "OPENAI"))
            }
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=tmp, env=env, capture_output=True, text=True, timeout=120,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HMAC_OK=1", result.stdout)
        # DB store 不得因載入順序被誤判 missing
        self.assertIn("DB_DISABLED=None", result.stdout)
        # 測試輸出不得包含任何 secret 值
        self.assertNotIn("fake-hmac-secret", result.stdout)
        self.assertNotIn("fake-service-role-key", result.stdout)


if __name__ == "__main__":
    unittest.main()
