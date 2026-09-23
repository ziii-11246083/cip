# TASK 03 — 其餘 RAG Endpoints 與 Citation API

## 依賴

- Task 02 的 Codex review 必須為 `PASS`。

## 本次唯一目標

沿用已通過審核的 trace service，接入其餘 RAG endpoints；只處理後端 response，不改前端 UI。

## 範圍

- `/api/agent-plan`
- `/api/scam-scan`
- `/podcast/generate`（`/api/podcast/generate` 只是同一 handler 的 alias；一次 request 只能產生一筆 trace）
- `/portfolio/analyze-llm`

不要接沒有使用 RAG 的 `/portfolio/risk-health`、`/api/portfolio/analyze`、Podcast TTS routes。

## 實作要求

- 每個 endpoint 都產生 trace_id；DB/trace status 只能使用 Task 01 契約允許的 `success`、`degraded`、`abstained`、`error`。partial/fallback 屬於判定情境，不可自行新增非法 status 字串。
- 延續 Task 02 邊界：Auth 未通過或 request validation 直接拒絕時不建立 trace；已接受的請求即使缺 LLM key、RAG unavailable 或使用 fallback response，仍要建立 trace 並標記正確 degraded/error。Agent/Health 使用已驗證 Auth UID；匿名 Scam/Podcast 的 `user_id` 維持 NULL。
- 將 Task 02 的 Chat 專用 trace lifecycle 做最小、向後相容泛化：保留 `start_chat_run()` 與既有 Chat 行為，新增／調整共用入口以接受 allowlist endpoint（`chat`、`agent`、`scam`、`podcast`、`health`）；未知 endpoint 必須 fail closed 或安全拒絕，不得默默寫成 chat。
- 保留每個 endpoint 的既有 response 欄位；只新增 trace/citation/confidence metadata。
- citations 必須來自實際注入的 chunks，不能把檢索到但未注入的結果冒充引用。
- citation 對外只回傳安全欄位：chunk_id、顯示用 source、section/topic；不可曝露伺服器絕對路徑。
- Scam 的外部掃描真實化不在本 Task；不可順手加入 GMGN/WHOIS/PTT。
- 共用邏輯放 service，不要在每個 route 複製大段程式。

## 測試最低要求

- 每個 endpoint 至少成功、empty context、trace store failure 三類。
- 至少覆蓋 RAG/LLM exception 的固定安全代碼；不得把 `str(exception)`、使用者原文、token 或 provider error 寫入 trace、log 或 API response。
- endpoint 之間 metadata 不串錯。
- 既有 response contract regression test。
- Podcast canonical route 與 alias 都要驗證，但同一請求不得重複寫兩筆 trace。
- 不需要真實 OpenAI Key；以 mock/stub 驗證。

## 不可做

- 不改前端。
- 不改詐騙功能定位。
- 不修改模擬交易或會員資產。

## 驗收

五類 RAG 使用路徑（含 Task 02 的 Chat）都有一致 trace 契約；本 Task 只新增其餘四類。完成後停止。
