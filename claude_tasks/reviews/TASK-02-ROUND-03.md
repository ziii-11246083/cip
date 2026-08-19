# TASK 02 — Codex 第三輪複審

審核結果：`PASS`

審核日期：2026-08-14

## 結論

第二輪唯一 blocker 已消除。deep route 的 query rewrite 發生 exception、但 retrieval 仍成功時，現在會以固定安全代碼 `rewrite_error` 標記為 degraded；仍使用原 query 繼續檢索，不影響 Chat 回答與引用。

Task 02 可關閉，Task 03 依賴已解鎖。

## Codex 核對證據

- `services/rag_service.py` 的 rewrite exception 分支設定 `fallback_reason = "rewrite_error"`，分支沒有 return/raise，仍進入 retrieval。
- `services/rag_trace_service.py` allowlist 已加入 `rewrite_error`。
- service 測試使用真實 router 與 retrieval，只讓 rewriter raise；驗證來源、citation、degraded status 與安全 log。
- endpoint 測試將真實 `RAGService` 接到 `/api/ai-chat`；驗證 HTTP 200、原 reply/conversation、citation、trace degraded 與合成 token 不外洩。
- 若 retrieval 隨後也失敗，較終端的 `retrieval_error` 會覆蓋 `rewrite_error`；此分類合理且仍為安全固定代碼。

## Codex 獨立驗證

- `/tmp/cip-test-venv/bin/python -m pytest tests/ -q`：80 passed。
- `python3 -m unittest tests.test_rag_trace_service -v`：57 passed。
- 同型反例重播：`rewrite_error / degraded / fallback=True / sources=1 / secret_leak=False`。
- 本輪 4 檔 `py_compile`：通過。
- Task 01 validator：70/70。
- `git -c core.whitespace=cr-at-eol diff --check`：通過。
- 未連 DB、未執行 migration、未 commit、未 push；未開始 Task 03。

## 非阻擋備註

- `claude_tasks/reports/TASK-02.md` 修改檔表的一處文字仍寫 56 個 service tests，但同報告驗證表與實際執行均為 57；不影響程式、測試或資料契約，不要求第四輪。
- Source compensation 仍不是真正 transaction、HMAC rotation 尚未實作、regex 無法辨識所有未標示自然語言姓名；均已在既有契約／報告誠實揭露，留待後續任務，不阻擋 Task 02。
