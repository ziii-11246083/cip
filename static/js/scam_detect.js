function initRevealMotion() {
  const revealEls = document.querySelectorAll(".reveal");

  if (!("IntersectionObserver" in window)) {
    revealEls.forEach(function(el) {
      el.classList.add("is-visible");
    });
    return;
  }

  const revealObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      }
    });
  }, {
    threshold: 0.14
  });

  revealEls.forEach(function(el) {
    revealObserver.observe(el);
  });
}

function setReportState(type) {
  const reportHeader = document.getElementById("reportHeader");
  const reportBadge = document.getElementById("reportBadge");

  if (!reportHeader || !reportBadge) return;

  reportHeader.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
  reportBadge.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
  reportHeader.style.background = "";
  reportBadge.style.color = "";
  reportBadge.style.background = "";
  reportBadge.style.borderColor = "";

  const normalized = ["high", "medium", "low"].includes(type) ? type : "unknown";

  switch (normalized) {
    case "high":
      reportHeader.textContent = "高風險詐騙警示";
      reportBadge.textContent = "高風險";
      reportHeader.classList.add("risk-high");
      reportBadge.classList.add("risk-high");
      break;
    case "medium":
      reportHeader.textContent = "中度風險提醒";
      reportBadge.textContent = "中風險";
      reportHeader.classList.add("risk-medium");
      reportBadge.classList.add("risk-medium");
      break;
    case "low":
      reportHeader.textContent = "低風險內容";
      reportBadge.textContent = "低風險";
      reportHeader.classList.add("risk-low");
      reportBadge.classList.add("risk-low");
      break;
    default:
      reportHeader.textContent = "風險待判斷";
      reportBadge.textContent = "待判斷";
      reportHeader.classList.add("risk-unknown");
      reportBadge.classList.add("risk-unknown");
      break;
  }
}

function updateCounter() {
  const input = document.getElementById("scamInput");
  const counter = document.getElementById("charCounter");
  if (input && counter) {
    counter.textContent = `${input.value.length} 字`;
  }
}

async function runScan() {
  const inputEl = document.getElementById("scamInput");
  const btn = document.getElementById("btnScan");
  const reportBox = document.getElementById("reportBox");
  const reportContent = document.getElementById("reportContent");
  const reportEmpty = document.getElementById("reportEmpty");
  const scanLoading = document.getElementById("scanLoading");

  if (!inputEl || !btn || !reportBox || !reportContent || !reportEmpty || !scanLoading) return;

  const text = inputEl.value.trim();
  if (!text) {
    alert("請先貼上想檢測的內容。");
    inputEl.focus();
    return;
  }

  const token = window.authManager ? await window.authManager.getToken() : null;

  btn.disabled = true;
  btn.classList.add("btn-loading");
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 分析中...';

  reportBox.style.display = "none";
  reportEmpty.style.display = "none";
  scanLoading.classList.add("show");

  try {
    const headers = {
      "Content-Type": "application/json"
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch("/api/scam-scan", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ text: text })
    });

    scanLoading.classList.remove("show");

    if (res.status === 401) {
      alert("這項功能需要先登入會員後才能使用。");
      reportEmpty.style.display = "grid";
      return;
    }

    const data = await res.json();
    const reportStr = data.report || "目前沒有取得分析報告。";
    const riskLevel = typeof data.risk_level === "string" ? data.risk_level.toLowerCase() : "unknown";
    reportContent.textContent = reportStr;
    setReportState(riskLevel);
    reportBox.style.display = "block";
  } catch (error) {
    scanLoading.classList.remove("show");
    reportEmpty.style.display = "grid";
    alert("分析失敗，請稍後再試一次。");
  } finally {
    btn.disabled = false;
    btn.classList.remove("btn-loading");
    btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> 開始掃描分析';
  }
}

function initExamples() {
  const input = document.getElementById("scamInput");
  if (!input) return;

  document.querySelectorAll(".exampleChip").forEach(function(btn) {
    btn.addEventListener("click", function() {
      input.value = btn.dataset.example || "";
      updateCounter();
      input.focus();
    });
  });
}

function initReportButtons() {
  const btnCopy = document.getElementById("btnCopyReport");
  const btnClear = document.getElementById("btnClearReport");
  const input = document.getElementById("scamInput");
  const reportBox = document.getElementById("reportBox");
  const reportEmpty = document.getElementById("reportEmpty");
  const scanLoading = document.getElementById("scanLoading");
  const reportContent = document.getElementById("reportContent");
  const reportBadge = document.getElementById("reportBadge");
  const reportHeader = document.getElementById("reportHeader");

  if (btnCopy) {
    btnCopy.addEventListener("click", function() {
      const text = reportContent ? reportContent.textContent.trim() : "";
      if (!text) {
        alert("目前沒有可複製的報告內容。");
        return;
      }

      navigator.clipboard.writeText(text).then(function() {
        alert("分析報告已複製。");
      }).catch(function() {
        alert("複製失敗，請稍後再試。");
      });
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", function() {
      if (input) input.value = "";
      if (reportContent) reportContent.textContent = "";
      if (reportBox) reportBox.style.display = "none";
      if (scanLoading) scanLoading.classList.remove("show");
      if (reportEmpty) reportEmpty.style.display = "grid";
      if (reportHeader) {
        reportHeader.textContent = "檢測結果";
        reportHeader.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
        reportHeader.style.background = "";
      }
      if (reportBadge) {
        reportBadge.textContent = "等待檢測";
        reportBadge.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
        reportBadge.style.color = "";
        reportBadge.style.background = "";
        reportBadge.style.borderColor = "";
      }
      updateCounter();
    });
  }
}

document.addEventListener("DOMContentLoaded", function() {
  const scamInput = document.getElementById("scamInput");
  const btnScan = document.getElementById("btnScan");

  initRevealMotion();
  initExamples();
  initReportButtons();
  updateCounter();

  if (scamInput) {
    scamInput.addEventListener("input", updateCounter);
  }

  if (btnScan) {
    btnScan.addEventListener("click", runScan);
  }
});
