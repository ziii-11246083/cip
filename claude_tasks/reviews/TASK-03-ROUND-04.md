# TASK 03 — Codex 第四輪複審

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-15

## 結論

第三輪的兩個主要問題已修正並由 Codex 獨立反例確認：

- Agent URL route 的 stored query 現在是合法 JSON，URL 已遮罩且必要 keys 齊全。
- 3000-entry `portfolio_summary` 現在會局部縮減，整筆 query 仍保留六個必要外層 keys。

完整驗證亦通過：pytest `149/149`、service unittest `70/70`、Python compile、Task 01 validator `70/70`、CRLF-aware diff check。

但 key collision allocator 還有一個精準資料遺失反例，因此 Task 03 暫不 PASS，Task 04 繼續鎖定。

## 唯一必修：final cleaned key 必須對整個輸出 dict 保證唯一

目前演算法只計算相同 base cleaned key 出現幾次：

```python
count = used.get(ck, 0) + 1
if count > 1:
    ck = f"{ck}#{count}"
cleaned[ck] = value
```

這沒有檢查加上 `#N` 後的 final candidate 是否已被另一個原始 key 占用。

Codex 已重現：nested dict 同時包含以下三個 keys：

- JWT A → 清理為 `<JWT>`
- JWT B → 清理後候選為 `<JWT>#2`
- 原始合法 key `<JWT>#2`

由於 sorted 原始 key 的順序，原始 `<JWT>#2` 先寫入，之後 JWT B 又寫入相同 final key，造成三筆 value 最後只剩兩筆，`value-c` 靜默遺失。

### 修正要求

- 以 base cleaned key 建立 candidate。
- 在寫入前必須用 `while candidate in cleaned` 尋找下一個未使用的 deterministic suffix，例如 `<JWT>`、`<JWT>#2`、`<JWT>#3`。
- 唯一性判斷必須針對 final candidate，而不只是同 base 的計數。
- 不得改變已通過的 leaf-first sanitize、dict caps、marker、排序、長度上限或 byte stability。
- 不得重構其他 helper 或 route。

## 唯一新增回歸測試

建立 nested dict，至少同時包含：

- 兩個不同、但都會遮罩成 `<JWT>` 的 synthetic JWT keys；
- 原始 key `<JWT>`；
- 原始 key `<JWT>#2`；
- 原始 key `<JWT>#3`。

斷言：

- snapshot 可 parse、無 JWT 原文。
- 所有輸入 values 均各自保留，數量完全一致，沒有覆蓋。
- 所有輸出 keys 唯一。
- 相同輸入重跑結果 byte-for-byte deterministic。
- 先證明此測試在目前實作會少一筆 value，再修正通過。

## 允許修改範圍

只能修改：

- `app.py` `_trace_shrink()` dict key candidate 配置的局部數行
- `tests/test_rag_endpoints_trace.py` 一個 collision regression test
- `claude_tasks/reports/TASK-03.md`
- `claude_tasks/STATUS.md` 的 Task 03 Implementation 欄位

不得修改 Codex review 欄位、其他 helper 語意、service、route、DB、migration、UI 或 Task 01／02；不得開始 Task 04。

## 重新送審驗收

- 唯一 collision 反例通過，所有 values 完整保留。
- 原 149 項 pytest 全數保留並通過。
- service unittest、compile、validator 70/70、diff check 通過。
- 報告記錄修正前遺失的 value、修正後 final-candidate 配置規則、測試總數及未連 DB／未 migration／未 commit／未 push。
- Implementation 回到 `READY_FOR_CODEX_REVIEW` 後立即停止。
