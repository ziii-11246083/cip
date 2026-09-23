"""
TASK 04 — 前端測試 wrapper：以 Node 執行 tests/test_ai_coach_frontend.test.js
（純函式／DOM 安全渲染／feedback 互動測試）。無 Node 環境時 skip。
"""

import shutil
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
NODE_SCRIPT = PROJECT_ROOT / "tests" / "test_ai_coach_frontend.test.js"


@unittest.skipUnless(shutil.which("node"), "需要 Node.js 執行前端測試")
class FrontendHookTests(unittest.TestCase):
    def test_node_frontend_suite(self):
        result = subprocess.run(
            ["node", str(NODE_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            result.returncode, 0,
            f"node 前端測試失敗：\n{result.stdout}\n{result.stderr}")


if __name__ == "__main__":
    unittest.main()
