# TASK 02 — Codex 第二輪複審

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-14

本輪只剩 1 個阻擋問題。Claude Code 只能修正本文件列出的 rewrite fallback trace，不得開始 Task 03，不得擴張到其他 endpoint、UI、migration、資料庫部署、commit 或 push。

## 已通過的第一輪修正

以下 5 項已由 Codex 檢查實作並獨立重跑測試，可視為通過，本輪不得重寫：

1. `load_dotenv()` 已在 trace singleton 建立前執行，隔離 subprocess 行為測試通過。
2. KB unavailable、retrieval exception、empty context 已能標記 degraded；正常有來源仍為 success。
3. primary store、DB store 與 `finish()` 的錯誤已隔離，不會改變成功 Chat 回答。
4. PII/secret 遮罩、弱 HMAC fail closed、固定 error/fallback code、legacy metrics query 安全化已補齊。
5. source insert failure 與 missing run id 已做 scoped compensation cleanup；報告也已誠實標示非真正 transaction。

Codex 獨立驗證結果：

- `/tmp/cip-test-venv/bin/python -m pytest tests/ -q`：78 passed。
- `python3 -m unittest tests.test_rag_trace_service -v`：56 passed。
- 初始化測試：系統 Python 1 passed / 1 skipped（缺 Flask）；完整 pytest venv 已執行 subprocess 行為測試。
- `py_compile`：通過。
- Task 01 validator：70/70。
- `git -c core.whitespace=cr-at-eol diff --check`：通過。

## 唯一阻擋問題：rewrite exception 被誤記為 success

### 證據

`services/rag_service.py` 的 deep route query rewrite 發生 exception 時，目前只寫固定 warning，沒有設定 `fallback_reason`。如果後續 retrieval 仍成功，metrics 會回傳空的 fallback reason，最終 trace 會被記成：

```text
fallback_reason=''
trace_status=success
fallback=False
```

Codex 已用真實 `RAGService._retrieve_for_endpoint()` 路徑重現：router 回 deep、rewriter raise、retrieval 正常回傳 1 筆來源，仍得到上述錯誤分類。現有 78 項測試沒有覆蓋此路徑。

這會讓「實際發生 query rewrite 降級」的回答混入成功樣本，污染之後的 RAG 成功率、版本比較與 regression gate，因此屬於 Task 02 的資料正確性阻擋問題。

## 必須修正

只做下列最小改動：

1. 在 `services/rag_service.py` 的 rewrite exception 分支設定固定安全代碼 `fallback_reason = "rewrite_error"`。
2. 在 `services/rag_trace_service.py` 的 fallback allowlist 加入 `rewrite_error`，使 persisted trace 保留這個類別而不是 raw exception 或泛化字串。
3. 新增 regression test，使用真實 `RAGService` pipeline 行為（不得只把整個 `augment_chat()` mock 成 raise）：
   - router 決定 deep；
   - rewriter raise，exception text 含合成 secret/token；
   - retrieval 仍成功並回至少 1 筆來源；
   - metrics 的 `fallback_reason == "rewrite_error"`；
   - 最終 trace 為 `status == "degraded"`、`fallback is True`、`fallback_reason == "rewrite_error"`；
   - trace record、log 與 API response 不得包含 exception text 或合成 secret；
   - retrieval source/citation 仍保留，Chat 原回答與 HTTP 行為不變。

## 不可做

- 不得讓 rewrite exception 變成 fatal error；仍需用原 query 繼續 retrieval。
- 不得修改既有 Chat prompt、LLM 回答、引用排序或 retrieval 演算法。
- 不得為此重構整個 `RAGService`、trace service 或 `app.py`。
- 不處理其他 endpoint；Task 03 仍鎖定。
- 不得修改 Task 01 migration/data contract，不得連 DB 或執行 migration。
- 不要處理來源 rank 的額外防禦性重構；production `record_rag()` 已產生連續 rank，此項不屬於本輪 blocker。

## 重新送審驗收

- 新增測試在修正前能重現誤記 success，修正後通過。
- 原有 78 項測試全部保留並通過。
- 重新執行 56 項 service unittest、py_compile、Task 01 validator 70/70、CRLF-aware diff check。
- 更新 `claude_tasks/reports/TASK-02.md`，加入第二輪修正、測試數與未連 DB／未執行 migration聲明。
- `claude_tasks/STATUS.md` 的 Task 02 Implementation 維持／設回 `READY_FOR_CODEX_REVIEW`；Codex review 欄位不得修改。
- 完成後立即停止，等待 Codex 第三輪複審，不得開始 Task 03。
