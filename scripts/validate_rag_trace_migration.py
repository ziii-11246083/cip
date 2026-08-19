#!/usr/bin/env python3
"""
TASK 01 — RAG Trace migration 靜態驗證腳本（schema/migration only）。

只做「文字層級」的靜態檢查：不連線任何資料庫、不執行 migration、
不觸碰正式 Supabase 資料。驗證項目對應 TASK 01 驗收標準與 Codex
複審要求：
  - 表/欄位/PK/FK/index/RLS policy 齊全、建表順序正確。
  - authenticated 對 rag_runs / rag_run_sources 只能 SELECT，
    不得 INSERT / UPDATE / DELETE（防偽造稽核紀錄）。
  - rag_feedback UPDATE 的 USING 與 WITH CHECK 都驗證新舊
    parent run 屬於 auth.uid()。
  - rag_evaluations.eval_run_id FK + case_id→eval_run_id 約束 + index。
  - query_hash 為 keyed HMAC-SHA-256（契約一致性）。
  - rag_runs.user_id 為 ON DELETE CASCADE。
  - idempotent、無 DROP TABLE/TRUNCATE 既有表、無敏感欄位。

用法：python3 scripts/validate_rag_trace_migration.py
退出碼：0 = 全部通過；1 = 任一檢查失敗。
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = PROJECT_ROOT / "supabase" / "migrations"
CONTRACT_DOC = PROJECT_ROOT / "docs" / "RAG_TRACE_DATA_CONTRACT.md"

REQUIRED_TABLES = ["rag_runs", "rag_run_sources", "rag_feedback",
                   "rag_evaluations", "rag_eval_runs"]


def load_migration() -> Path:
    candidates = sorted(MIGRATIONS_DIR.glob("*_rag_trace.sql"))
    if not candidates:
        print(f"FAIL: 找不到 migration 檔（{MIGRATIONS_DIR}/*_rag_trace.sql）")
        sys.exit(1)
    return candidates[-1]


def split_table_blocks(sql: str):
    """回傳 {table_name: body}，body 為 CREATE TABLE 括號內的內容。"""
    blocks = {}
    pattern = re.compile(
        r"CREATE TABLE IF NOT EXISTS\s+public\.(\w+)\s*\((.*?)\);",
        re.DOTALL,
    )
    for m in pattern.finditer(sql):
        blocks[m.group(1)] = m.group(2)
    return blocks


def table_has(body: str, column: str) -> bool:
    return re.search(rf"^\s*{re.escape(column)}\s+", body, re.MULTILINE) is not None


def strip_comments(sql: str) -> str:
    """移除 SQL 註解，供破壞性語句／敏感字檢查使用（註解中的說明文字不算 schema）。"""
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", "", sql)
    return sql


def auth_policy_verbs(sql: str, table: str) -> list:
    """列出該表上 TO authenticated 的 policy verb（依 SELECT/INSERT/UPDATE/DELETE 順）。"""
    verbs = []
    for verb in ["SELECT", "INSERT", "UPDATE", "DELETE"]:
        if re.search(
            rf"CREATE POLICY\s+\w+\s+ON\s+public\.{table}\s+FOR\s+{verb}\s+TO\s+authenticated",
            sql,
        ):
            verbs.append(verb)
    return verbs


def any_policy_verbs(sql: str, table: str, verbs: list) -> list:
    """列出該表上「任何 role」的指定 verbs policy（service role 不需 policy）。"""
    found = []
    for verb in verbs:
        if re.search(
            rf"CREATE POLICY\s+\w+\s+ON\s+public\.{table}\s+FOR\s+{verb}",
            sql,
        ):
            found.append(verb)
    return found


def policy_block(sql: str, table: str, verb: str) -> str:
    """擷取該表該 verb 的完整 CREATE POLICY 區塊（至第一個分號）。"""
    m = re.search(
        rf"CREATE POLICY\s+\w+\s+ON\s+public\.{table}\s+FOR\s+{verb}.*?;",
        sql, re.DOTALL,
    )
    return m.group(0) if m else ""


def main() -> int:
    failures = []
    checks_run = 0

    def check(name: str, ok: bool, detail: str = ""):
        nonlocal checks_run
        checks_run += 1
        status = "PASS" if ok else "FAIL"
        line = f"[{status}] {name}"
        if detail and not ok:
            line += f" — {detail}"
        print(line)
        if not ok:
            failures.append(name)

    sql_path = load_migration()
    sql = sql_path.read_text(encoding="utf-8")
    sql_code = strip_comments(sql)
    contract = CONTRACT_DOC.read_text(encoding="utf-8") if CONTRACT_DOC.exists() else ""
    print(f"檢查檔案：{sql_path.relative_to(PROJECT_ROOT)}（{len(sql)} chars）\n")

    tables = split_table_blocks(sql)

    # ── 1. 五張表齊全且為 idempotent 建立 ──────────────────────────
    for t in REQUIRED_TABLES:
        check(f"表 {t} 存在（CREATE TABLE IF NOT EXISTS）", t in tables)

    non_idem_tables = re.findall(
        r"CREATE TABLE\s+(?!IF NOT EXISTS)(public\.)?(\w+)", sql
    )
    check("所有 CREATE TABLE 均帶 IF NOT EXISTS（可重複執行）",
          len(non_idem_tables) == 0, str(non_idem_tables))

    non_idem_idx = re.findall(r"CREATE INDEX\s+(?!IF NOT EXISTS)", sql)
    check("所有 CREATE INDEX 均帶 IF NOT EXISTS", len(non_idem_idx) == 0,
          f"{len(non_idem_idx)} 個未帶")

    # ── 2. 建表順序：rag_eval_runs 先於 rag_evaluations（FK 參照） ──
    pos_eval_runs = sql.find("CREATE TABLE IF NOT EXISTS public.rag_eval_runs")
    pos_evaluations = sql.find("CREATE TABLE IF NOT EXISTS public.rag_evaluations")
    check("建表順序：rag_eval_runs 先於 rag_evaluations（供 eval_run_id FK 參照）",
          pos_eval_runs != -1 and pos_evaluations != -1 and pos_eval_runs < pos_evaluations)

    # ── 3. PK 與 created_at DEFAULT now() ───────────────────────────
    for t in REQUIRED_TABLES:
        if t not in tables:
            continue
        check(f"{t} 有 PRIMARY KEY",
              re.search(r"PRIMARY KEY", tables[t]) is not None)
        check(f"{t} 有 created_at DEFAULT now()",
              re.search(r"created_at\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)",
                        tables[t]) is not None)

    # ── 4. 必要欄位（rag_evaluations 含 eval_run_id） ───────────────
    required_columns = {
        "rag_runs": ["trace_id", "user_id", "conversation_id", "message_id",
                     "endpoint", "sanitized_query", "query_hash", "answer",
                     "model", "prompt_version", "kb_version", "index_version",
                     "config_version", "route", "confidence", "abstained",
                     "fallback", "status", "error", "prompt_tokens",
                     "completion_tokens", "total_latency_ms", "created_at"],
        "rag_run_sources": ["run_id", "chunk_id", "source", "topic", "section",
                            "rank", "score", "content_hash", "excerpt",
                            "actually_injected", "created_at"],
        "rag_feedback": ["run_id", "user_id", "vote", "reason", "comment",
                         "created_at"],
        "rag_evaluations": ["run_id", "eval_run_id", "case_id", "evaluator_type",
                            "faithfulness", "relevance", "citation_correctness",
                            "completeness", "safety_score", "total_score",
                            "passed", "reviewer", "created_at"],
        "rag_eval_runs": ["dataset_version", "config_version", "code_version",
                          "case_count", "overall_metrics",
                          "per_endpoint_metrics", "artifact_path", "status",
                          "created_at"],
    }
    for t, cols in required_columns.items():
        if t not in tables:
            continue
        missing = [c for c in cols if not table_has(tables[t], c)]
        check(f"{t} 必要欄位齊全（{len(cols)} 欄）", not missing, f"缺：{missing}")

    # ── 5. FK 關聯（含 CASCADE 語意） ───────────────────────────────
    fk_checks = [
        ("rag_runs → user_profiles(user_id) ON DELETE CASCADE", "rag_runs",
         r"REFERENCES\s+public\.user_profiles\(user_id\)\s+ON DELETE CASCADE"),
        ("rag_runs → ai_conversations(id)", "rag_runs",
         r"REFERENCES\s+public\.ai_conversations\(id\)"),
        ("rag_runs → ai_messages(id)", "rag_runs",
         r"REFERENCES\s+public\.ai_messages\(id\)"),
        ("rag_run_sources → rag_runs(id)", "rag_run_sources",
         r"REFERENCES\s+public\.rag_runs\(id\)"),
        ("rag_feedback → rag_runs(id)", "rag_feedback",
         r"REFERENCES\s+public\.rag_runs\(id\)"),
        ("rag_feedback → user_profiles(user_id)", "rag_feedback",
         r"REFERENCES\s+public\.user_profiles\(user_id\)"),
        ("rag_evaluations → rag_runs(id)", "rag_evaluations",
         r"REFERENCES\s+public\.rag_runs\(id\)"),
        ("rag_evaluations → rag_eval_runs(id) ON DELETE CASCADE（eval_run_id）",
         "rag_evaluations",
         r"REFERENCES\s+public\.rag_eval_runs\(id\)\s+ON DELETE CASCADE"),
    ]
    for name, t, pattern in fk_checks:
        if t not in tables:
            continue
        check(f"FK：{name}", re.search(pattern, tables[t]) is not None)

    # 不使用 user_profiles.id（任務明確禁止假定其存在）
    check("未假定 user_profiles.id（使用者鍵為 user_id）",
          "user_profiles.id" not in sql_code and
          not re.search(r"REFERENCES\s+public\.user_profiles\s*\(\s*id\s*\)", sql_code))

    # ── 6. RLS：五表全部啟用 ───────────────────────────────────────
    for t in REQUIRED_TABLES:
        check(f"{t} 啟用 RLS（ENABLE ROW LEVEL SECURITY）",
              f"public.{t} ENABLE ROW LEVEL SECURITY" in sql)

    # ── 7. Policy 授權方向（Codex 複審核心） ─────────────────────────
    check("rag_runs：authenticated 僅 SELECT policy（不得 INSERT/UPDATE/DELETE）",
          auth_policy_verbs(sql, "rag_runs") == ["SELECT"]
          and any_policy_verbs(sql, "rag_runs", ["INSERT", "UPDATE", "DELETE"]) == [])
    check("rag_run_sources：authenticated 僅 SELECT policy（不得 INSERT/UPDATE/DELETE）",
          auth_policy_verbs(sql, "rag_run_sources") == ["SELECT"]
          and any_policy_verbs(sql, "rag_run_sources", ["INSERT", "UPDATE", "DELETE"]) == [])
    check("rag_feedback：authenticated 有 SELECT/INSERT/UPDATE/DELETE policy",
          auth_policy_verbs(sql, "rag_feedback") == ["SELECT", "INSERT", "UPDATE", "DELETE"])
    check("rag_evaluations：authenticated 僅 SELECT（一般使用者不可寫 evaluation）",
          auth_policy_verbs(sql, "rag_evaluations") == ["SELECT"]
          and any_policy_verbs(sql, "rag_evaluations", ["INSERT", "UPDATE", "DELETE"]) == [])
    check("rag_eval_runs：無任何 policy（僅 service role）",
          any_policy_verbs(sql, "rag_eval_runs", ["SELECT", "INSERT", "UPDATE", "DELETE"]) == [])
    check("無任何 policy 授權 anon role",
          not re.search(r"CREATE POLICY\s+\w+\s+ON\s+\S+\s+FOR\s+\w+\s+TO\s+anon", sql))

    # rag_run_sources SELECT 必須經 parent run 間接授權
    src_sel = policy_block(sql, "rag_run_sources", "SELECT")
    ok_src = ("rag_run_sources.run_id" in src_sel
              and "r.user_id = auth.uid()" in src_sel)
    check("rag_run_sources SELECT 經 parent run EXISTS 授權", ok_src)

    # rag_feedback INSERT：parent run 必須屬於自己
    fb_insert = policy_block(sql, "rag_feedback", "INSERT")
    ok_fb_i = ("auth.uid()" in fb_insert
               and "rag_feedback.run_id" in fb_insert
               and "rag_runs" in fb_insert)
    check("rag_feedback INSERT 限制「自己的 run」（EXISTS 父 run）", ok_fb_i)

    # rag_feedback UPDATE：USING 與 WITH CHECK 都驗證新舊 parent run 所有權
    fb_update = policy_block(sql, "rag_feedback", "UPDATE")
    ok_fb_u = (
        "USING" in fb_update
        and "WITH CHECK" in fb_update
        and fb_update.count("auth.uid()") >= 4          # USING 2 + WITH CHECK 2
        and fb_update.count("rag_feedback.run_id") >= 2  # USING 1 + WITH CHECK 1
        and fb_update.count("r.user_id = auth.uid()") >= 2
    )
    check("rag_feedback UPDATE：USING 與 WITH CHECK 均驗證新舊 parent run 屬於 auth.uid()",
          ok_fb_u, f"區塊 {len(fb_update)} chars")

    # ── 8. 無破壞性語句 / 無敏感欄位（對「去除註解後」的 schema 檢查）──
    check("無 DROP TABLE（既有表不得被刪除）",
          not re.search(r"DROP\s+TABLE", sql_code, re.I))
    check("無 TRUNCATE", not re.search(r"TRUNCATE", sql_code, re.I))
    forbidden = ["api_key", "secret", "private_key", "mnemonic",
                 "seed_phrase", "passphrase", "access_token", "service_role_key"]
    hits = [w for w in forbidden if re.search(rf"\b{re.escape(w)}\b", sql_code)]
    check("無 API Key / secret / 私鑰 / 助記詞欄位", not hits, str(hits))

    # ── 9. 關鍵 CHECK 約束 ─────────────────────────────────────────
    enum_checks = [
        ("endpoint CHECK（5 endpoints）",
         r"endpoint\s+text\s+NOT NULL\s*\n?\s*CHECK\s*\(endpoint\s+IN\s*\('chat','agent','podcast','scam','health'\)\)"),
        ("route CHECK（fast/deep/unknown）",
         r"CHECK\s*\(route\s+IN\s*\('fast','deep','unknown'\)\)"),
        ("status CHECK（success/degraded/abstained/error）",
         r"CHECK\s*\(status\s+IN\s*\('success','degraded','abstained','error'\)\)"),
        ("vote CHECK（up/down）",
         r"CHECK\s*\(vote\s+IN\s*\('up','down'\)\)"),
        ("evaluator_type CHECK（llm_judge/human/heuristic）",
         r"CHECK\s*\(evaluator_type\s+IN\s*\('llm_judge','human','heuristic'\)\)"),
        ("query_hash CHECK（64-hex，契約定義為 keyed HMAC-SHA-256 輸出）",
         r"query_hash\s+text\s+NOT\s+NULL\s+CHECK\s*\(query_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'\)"),
        ("confidence CHECK（0–1）",
         r"CHECK\s*\(confidence\s+>=\s+0\s+AND\s+confidence\s+<=\s+1\)"),
        ("evaluations CHECK（run_id 或 case_id 至少其一）",
         r"CHECK\s*\(run_id\s+IS\s+NOT\s+NULL\s+OR\s+case_id\s+IS\s+NOT\s+NULL\)"),
        ("evaluations CHECK（case_id 非 NULL → eval_run_id 必非 NULL）",
         r"CHECK\s*\(case_id\s+IS\s+NULL\s+OR\s+eval_run_id\s+IS\s+NOT\s+NULL\)"),
    ]
    for name, pattern in enum_checks:
        check(f"約束：{name}", re.search(pattern, sql) is not None)

    # ── 10. Policy idempotency：CREATE POLICY 前有 DROP POLICY IF EXISTS ──
    drops = len(re.findall(r"DROP POLICY IF EXISTS\s+(\w+)\s+ON", sql))
    creates = len(re.findall(r"CREATE POLICY\s+(\w+)\s+ON", sql))
    check("每個 CREATE POLICY 前均有 DROP POLICY IF EXISTS（可重複執行）",
          drops == creates, f"DROP={drops}, CREATE={creates}")

    # ── 11. 索引 ───────────────────────────────────────────────────
    index_checks = [
        ("rag_runs 有 (user_id, created_at DESC) index",
         r"idx_rag_runs_user_created\s+ON\s+public\.rag_runs\s*\(user_id,\s*created_at\s+DESC\)"),
        ("rag_runs 有 (endpoint, created_at DESC) index",
         r"idx_rag_runs_endpoint_created\s+ON\s+public\.rag_runs\s*\(endpoint,\s*created_at\s+DESC\)"),
        ("rag_runs 有 query_hash index",
         r"idx_rag_runs_query_hash\s+ON\s+public\.rag_runs\s*\(query_hash\)"),
        ("rag_run_sources 有 UNIQUE(run_id, rank)",
         r"UNIQUE\s*\(run_id,\s*rank\)"),
        ("rag_feedback 有 UNIQUE(run_id, user_id)",
         r"UNIQUE\s*\(run_id,\s*user_id\)"),
        ("rag_evaluations 有 eval_run_id index",
         r"idx_rag_evaluations_eval_run\s+ON\s+public\.rag_evaluations\s*\(eval_run_id\)"),
        ("rag_eval_runs 有 created_at DESC index",
         r"idx_rag_eval_runs_created\s+ON\s+public\.rag_eval_runs\s*\(created_at\s+DESC\)"),
    ]
    for name, pattern in index_checks:
        check(f"索引：{name}", re.search(pattern, sql) is not None)

    # ── 12. 契約文件一致性（SQL ↔ docs/RAG_TRACE_DATA_CONTRACT.md）──
    check("契約文件提及 keyed HMAC-SHA-256（query_hash 定義）",
          "HMAC-SHA-256" in contract)
    check("契約文件提及 eval_run_id（評測批次關聯）",
          "eval_run_id" in contract)
    check("契約文件提及 rag_runs.user_id ON DELETE CASCADE（刪除策略）",
          "ON DELETE CASCADE" in contract)
    check("SQL 註解標示 query_hash 為 keyed HMAC-SHA-256",
          "HMAC-SHA-256" in sql)

    # ── 總結 ──────────────────────────────────────────────────────
    print(f"\n{'-' * 60}")
    print(f"檢查項目：{checks_run}，失敗：{len(failures)}")
    if failures:
        print("結果：FAIL")
        print("失敗項目：")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("結果：PASS（靜態驗證；未連線資料庫、未執行 migration、未經 SQL parser）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
