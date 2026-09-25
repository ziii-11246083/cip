# 功能驗證紀錄（2026-09-25）

本次為離線程式驗證，外部服務使用隔離或測試替身；沒有建立正式帳號、寄信、呼叫付費 AI、執行 migration 或修改正式資料。未進行瀏覽器視覺／完整人工操作驗收，不代表所有正式服務已通過。

## 執行結果

- 完整 Python unittest：332 項通過；之後新增 Agent 縮放下單、單幣分析兩案例，所屬 8 項 smoke suite 全部通過。
- tests 下全部 7 支 JavaScript 測試程式通過。
- static/js 下 15 支 JavaScript 通過 node --check。
- validate_asset_sync_migration.py、validate_asset_sync_mvp.py、validate_rag_trace_migration.py 全部通過。屬於靜態檢查，未在資料庫執行 SQL。
- 測試輸出的 provider、trace、invalid JSON 錯誤包含故意注入的失敗案例，以 unittest 最終結果為準。

## 本次修正

1. 橫盤時 RSI 的 0/0 產生 NaN；改為 50，價格等於均線時不再扣分而誤標賣出。
2. 同一 ticker（含大小寫及空白差異）的持倉拆成多筆，集中度與加權報酬被低估；先合併再計算。50% BTC + 50% BTC 現在等同 100% BTC。
3. 最大回撤未包含初始淨值 1；100 跌到 80 的案例原本顯示 0，現在正確為 20%。
4. /crypto/popular 的非數字 per_page 造成例外；改為接受 1–250 的整數，其餘回傳 400，且不呼叫供應商。

前三項皆先由新增測試重現失敗，再確認修正後通過。

## 各功能測試範圍

| 功能 | 本次已驗證 | 證據／仍待驗證 |
|---|---|---|
| 首頁及頁面導覽 | 14 個 page route 可 render、包含免責 footer | test_feature_smoke；未做瀏覽器排版及點擊驗收 |
| 市場總覽／熱門幣／搜尋 | 空資料回應、熱門幣參數邊界 | test_feature_smoke；未查證即時行情 |
| 單幣分析／技術指標 | 已知歷史資料計算、橫盤 RSI | test_feature_smoke、test_market_health_regressions |
| 價格序列 | CoinGecko 無資料時使用 yfinance 備援 | test_feature_smoke；外部來源以替身驗證 |
| 社群情緒／敘事雷達 | page render、無資料 API 回應 | test_feature_smoke；未驗證即時抓文及分類品質 |
| FOMO 提示 | 已知漲幅回傳 HIGH | test_feature_smoke；非投資效果驗證 |
| AI 教練／對話 | 回答、trace、引用、歷史、Demo 隔離、錯誤與降級 | test_ai_chat_trace、test_ai_coach_frontend；未測付費模型實際輸出 |
| Agent 配置／模擬下單 | 配置回應、錯誤降級、依現金比例縮放下單金額 | test_rag_endpoints_trace、test_feature_smoke；外部 DB 下單未實測 |
| 防詐辨識 | 規則風險、錯誤與空上下文、不虛構外部掃描、剪貼簿 | test_scam_truth、test_scam_clipboard |
| Podcast 文稿／語音 | 文稿 trace／fallback；缺少語音供應商回傳 503 | test_rag_endpoints_trace、test_feature_smoke；未生成或聆聽實際音訊 |
| 組合健康度 | 集中度、波動與回撤數值、AI 解讀降級、未登入拒絕 | test_market_health_regressions、test_rag_endpoints_trace |
| 登入／註冊 | Demo、狀態事件、失敗保留身分、重複註冊防護 | test_auth_frontend、test_registration_frontend；未測 OAuth／驗證信 |
| 會員中心 | 備註安全呈現、紀錄更新、登入切換 | test_member_rendering、test_sim_trade_auth；未瀏覽器端到端操作 |
| 模擬交易／歷史／重置／入金 | 成交價格、非有限數值、筆數限制、UID 隔離、遠端失敗行為 | test_sim_order_amounts、test_sim_local_ledger；見下方已知限制 |
| 黑天鵝與其他情境 | 可重現數值、實際配置、期末值、過期結果清除 | test_paper_stress、test_stress_display |
| RAG 檢索／評測／回饋／管理 | Chroma、索引、離線評測、角色權限、跨用戶隔離、資訊遮蔽 | test_vector_store_service、test_rag_*、test_trace_init_and_metrics_privacy |
| 唯讀錢包同步 | 地址、權限、分頁、錯誤、原子提交契約及 DB migration 靜態檢查 | test_asset_sync_*、validate_asset_sync_*；未連正式 Alchemy／Supabase |
| 訂閱付款／交易所同步／通知 | repo 功能矩陣列為未實作 | 無可驗收 runtime，不列通過 |

## 已知限制與未完成驗證

- 已加入遠端入金保護：遠端帳本入金回傳 409，不切換或建立本機帳本。Demo 與已啟用本機帳本的會員可繼續入金。遠端入金 RPC 尚未實作。
- repo 缺少 sim 表／RPC、ai_conversations／ai_messages 的完整 migration；正式 DB 的結構與 RLS 待部署環境確認。
- 2026-09-26 已修正健康度缺少行情誤報零波動：缺漏持倉行情或無共同日期時回傳 null 與 market_data_available=false；前端顯示資料不足、不給綜合評分，AI 不依缺失行情生成分析。真正計算出的零波動仍顯示 0%。
- 外部行情新鮮度、社群抓取品質、AI 回答品質、語音品質、OAuth callback 與寄信需正式或測試服務驗證。
- 歷史曾提交的服務帳戶私鑰仍需管理者撤銷／輪替。
- 現有 output/ 與兩個本機 .pyc 變更保留，未納入提交。
