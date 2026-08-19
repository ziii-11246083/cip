# TASK 12 — 商業數字、競品與 GitHub 複評證據包

## 依賴

- Task 11 的 Codex review 必須為 `PASS`。

## 本次唯一目標

只整理可驗證的複評文件與展示證據，不新增產品功能。

## 工作內容

1. 商業模式：
   - 依實際部署 model/env/config 重新列固定與變動成本。
   - 加入 embeddings、TTS、資料庫、託管、監控、金流費、退款/稅務/人力假設。
   - Base/best/worst 三情境與損益平衡敏感度。
   - 所有價格需有查詢日期與來源；無法確認就標待確認。
2. 競品：
   - 功能、對象、定價、差異化、查詢日期、來源。
   - 不寫無證據的「市面唯一」。
3. GitHub：
   - 整理有效主分支、重要 commits、每位成員貢獻。
   - 不改寫歷史、不製造假 commits、不以 commit 數量代替品質。
4. 答辯：
   - 每位成員負責模組、可能問題、90 秒回答重點。
   - 建立評審建議 → 修改 → 程式/文件證據 → Demo 步驟矩陣。

## 允許修改

- `docs/**`
- `README`（只有必要且內容正確時）
- Task report/status

不得修改 Python、JS、HTML、CSS、migration 或 Git history。

## 驗收

- 商業數字可重算，假設與來源清楚。
- 每一評審建議都有 implemented/partial/planned 與證據。
- 每位成員都有可展示的真實貢獻。
- 文件不把 mock/planned/pending review 說成完成。
- 完成後停止，等待最終 Codex 審核。
