# TASK-12 實作報告

## 目標與邊界

- 只整理複評可驗證的商業數字、競品、GitHub 證據與答辯路徑。
- 不新增產品功能，不修改 Python、JavaScript、HTML、CSS、migration 或 Git history。
- 不把本機已驗證但未提交的工作說成 GitHub 已有，不把 code-ready 說成已部署。

## 完成內容

- 依 runtime 實際預設重整主模型、query rewrite、embedding 與 TTS 成本，附 2026-08-20 官方來源。
- 新增可重算的單次回答公式、downside/base/upside 現金損益與損平敏感度；定價明標為 planned assumption。
- 補上 Supabase、Render、CoinGecko、Alchemy、Sentry、Stripe、退款／稅務／人力假設，不可確認處全部標示待確認。
- 以官方頁面比較 TradingView、CoinStats、Koinly 與 CoinGecko，同時列出競品更強的地方與本平台現有缺口。
- 將 33 條評審／指導老師建議統一標示為 evidence complete、partial 或 planned，每條都有程式／文件證據與 Demo 步驟。
- 整理 `origin/08/20` checkpoint、歷史分支、重要 commits、五個 human Git identities 與 90 秒答題卡；明列 author alias 仍需團隊對回正式名冊。
- 修正四份架構文件的舊 `TTS-1` / `GPT-4o-mini` 說法，統一為 `OPENAI_MODEL`（預設 `gpt-5.4`）與 `OPENAI_TTS_MODEL`（預設 `gpt-4o-mini-tts`）。

## 驗證

| 驗證 | 結果 |
|---|---|
| 商業公式獨立重算 | PASS；單次文字回答 US$0.017145，Pro/Premium 單位貢獻 7.39/18.07，80/20 加權 9.52 |
| 評審矩陣靜態檢查 | PASS；33 IDs / 33 unique，統計 23 evidence-complete / 6 partial / 4 planned |
| 官方來源與文件紅線檢查 | PASS；13 個價格／產品 URL 均有查詢日，舊 TTS 正向宣稱已清除 |
| 完整 Python regression | pytest 284/284 PASS（11 個既有 dependency warnings） |
| AI Coach Node tests | 23/23 PASS，`ALL PASS` |
| Task 01 RAG validator | 70/70 PASS |
| Task 09 asset validator | 108/108 PASS |
| Task 10 asset MVP validator | 28/28 PASS |
| Python compile / Node syntax / CRLF-aware diff check | PASS |
| Git remote checkpoint | branch `08/20`；本機 HEAD、`origin/08/20` 與 `ls-remote` 皆為 `5b7f52351c92e75406e9d8296bf103b8364423ac` |

## 誠實揭露

- Render 實際 plan，Stripe 台灣商戶費率，稅務／退款與實際帳單仍待 Dashboard、會計或業者確認；文件內的 hosting 金額是 budget allowance，不是官方報價。
- 15 題 RAG dataset 仍為 pending human review，沒有 approved clean baseline，不能宣稱準確率。
- 公開錢包只到 Ethereum Mainnet 唯讀 code/migration MVP；未執行 migration、未接付費 entitlement、交易所 API 或 scheduler。
- 本機 Task 05A 後續修正與 05B–12 仍未 commit/push；GitHub 遠端只能宣稱到 `5b7f523`。
- Task 12 執行期間沒有連 DB、執行 migration、呼叫真實 provider、修改 Git history 或推送新的 commit。
