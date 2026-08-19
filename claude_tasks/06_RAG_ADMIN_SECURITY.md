# TASK 06 — RAG 管理 Endpoints 權限

## 依賴

- Task 05B 的 Codex review 必須為 `PASS`。

## 本次唯一目標

保護 RAG rebuild/eval/detailed metrics；不得改動 retrieval 演算法。

## 實作要求

- 盤點 `/api/rag/rebuild-index`、`/api/rag/eval`、`/api/rag/stats`。
- destructive/昂貴操作必須 admin-only，server-side 驗證，不可靠前端隱藏。
- 定義最小 admin 判斷方式，優先沿用現有 auth/claims；不得硬編 email 清單。
- stats 分 public health 摘要與 admin details；public 不可包含 query、user、路徑或敏感 config。
- 401（未登入）與 403（非管理員）語意一致。
- rebuild 需防併發，避免同時多次重建；錯誤不得留下半套 index 卻回 success。
- 加 audit log，但不得記錄 secret 或完整敏感 query。

## 測試最低要求

- anonymous、normal user、admin。
- concurrent rebuild。
- rebuild failure。
- public stats 無敏感欄位。
- 既有 RAG Chat 不受影響。

## 不可做

- 不調整 BM25/dense/rerank 邏輯。
- 不建立新的完整後台 UI。

## 驗收

未授權者無法 rebuild/eval/read detailed metrics；完成後停止。
