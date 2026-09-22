# Smart Invest Crypto

智慧虛擬貨幣投資平台，整合市場總覽、投資健康度檢查、AI 投資教練、Podcast 與模擬交易功能。

## 快速啟動

本機啟動方式請參考 [`啟動說明.txt`](啟動說明.txt)。

主要流程：

1. 建立 `.env`
2. 安裝 `requirements.txt`
3. 執行 `python run_local.py`
4. 開啟 `http://127.0.0.1:5000`

## 本機回歸檢查

先安裝專案套件，再從專案根目錄執行：

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
```

已啟用虛擬環境時，也可使用 `python -B -m unittest discover -s tests -v`。
檢查包含 Git 追蹤檔案的衝突標記、Python 語法、主要頁面渲染及未登入的會員 API 回應。
頁面測試會停用本機金鑰載入與外部連線，不需要啟動網站；通過不代表外部 AI 或資料庫串接已驗證。

## 注意事項

`.env` 和金鑰檔案含有私密資訊，請勿公開上傳或分享。
