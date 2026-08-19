# TASK 03 — Codex 第五輪複審

審核結果：`PASS`

審核日期：2026-08-15

## 結論

第四輪唯一 blocker 已消除。`_trace_shrink()` 現在會針對實際要寫入輸出 dict 的 final candidate 檢查唯一性，依序配置 `base`、`base#2`、`base#3`……，不再因原始 `<JWT>#N` key 與遮罩後自動後綴碰撞而靜默遺失 value。

前四輪已修正的固定錯誤代碼、完整 query/answer snapshot、citation 全欄位清理、合法 bounded JSON、leaf-first sanitize、nested dict caps 與外層必要 keys 亦全數通過回歸。Task 03 可關閉，Task 04 依賴已解鎖，但尚未開始。

## Codex 核對證據

- `app.py` 的 dict key allocator 以 sorted 原始 key 決定迭代順序，先產生 cleaned base，再以 `while candidate in cleaned` 對 final candidate 尋找下一個未使用後綴；因此同 base 與既有 suffixed key 都不會互相覆蓋。
- 新增測試包含兩個會遮罩成 `<JWT>` 的 synthetic JWT keys，以及原始 `<JWT>`、`<JWT>#2`、`<JWT>#3`；驗證 5 筆 value 全數保留、輸出 key 唯一、無 JWT 原文、合法 JSON、重跑 byte-for-byte 相同。
- 本輪局部修正未改動已通過的 leaf-first sanitize、dict/list caps、truncation marker、排序、長度上限、route、service、DB migration 或 Task 01／02。
- `claude_tasks/reports/TASK-03.md` 如實記錄修正前 `3 != 5`、修正規則、測試總數，以及未連 DB／未 migration／未 commit／未 push。

## Codex 獨立驗證

- `/tmp/cip-test-venv/bin/python -m pytest tests/ -q`：150 passed。
- `/tmp/cip-test-venv/bin/python -m unittest tests.test_rag_trace_service -v`：70 passed。
- 加強碰撞鏈反例：3 個不同 JWT keys、原始 `<JWT>` 至 `<JWT>#4`、2 個清理後截斷碰撞的長 keys，共 9 筆 values 全數保留；key 唯一、輸出 deterministic、JWT 原文未出現、JSON 長度符合上限。
- `/tmp/cip-test-venv/bin/python -m py_compile app.py tests/test_rag_endpoints_trace.py`：通過。
- Task 01 validator：70/70。
- `git -c core.whitespace=cr-at-eol diff --check`：通過。
- 未連 DB、未執行 migration、未 commit、未 push；Task 04 仍為 PENDING。

## 非阻擋備註

- pytest 顯示 27 個第三方套件棄用／LibreSSL 警告，沒有測試失敗，與本輪功能正確性無直接關係。
- DB 寫入仍只以 fake Supabase 與靜態 migration validator 驗證；依任務限制不得連正式資料庫或執行 migration，部署前仍須在隔離環境做 schema/RLS integration test。
- trace snapshot 是經遮罩與有界縮減的稽核資料，不是答案正確性的 ground truth；答案準確率仍須由 Task 05 的 baseline、evaluation 與 regression gate 建立。
