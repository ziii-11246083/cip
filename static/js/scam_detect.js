let latestReportText = "";
let scanGeneration = 0;
let scanController = null;

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
  const card = document.getElementById("scamReportCard");
  if (card) card.dataset.risk = normalized;
  const symbol = document.getElementById("scamRiskSymbol");
  const symbols = {
    high:'<path d="M50 13 L91 84 Q93 89 86 89 H14 Q7 89 10 83 Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M50 37 V59" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="50" cy="73" r="4" fill="currentColor"/>',
    medium:'<circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width="5"/><path d="M50 29 V55" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="50" cy="70" r="4" fill="currentColor"/>',
    low:'<circle cx="43" cy="42" r="25" fill="none" stroke="currentColor" stroke-width="5"/><path d="M62 61 L83 82" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M43 30 V43" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="43" cy="53" r="3" fill="currentColor"/>',
    unknown:'<circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width="5"/><path d="M38 35 C39 23 64 23 64 37 C64 46 50 47 50 58" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="72" r="4" fill="currentColor"/>'
  };
  if (symbol) symbol.innerHTML = `<svg viewBox="0 0 100 100" focusable="false">${symbols[normalized]}</svg>`;
  const captions = {high:"出現高風險文字訊號。先暫停付款或提供敏感資訊，透過獨立管道查證。",medium:"有需要留意的文字訊號，請補齊資訊並確認來源。",low:"這段文字較少明顯警訊；對方身分、網站與交易安全仍未確認。",unknown:"資訊不足或分析不可用，目前不能合理判斷風險。"};
  const caption = document.getElementById("scamRiskCaption");
  if (caption) caption.textContent = captions[normalized];
  document.querySelectorAll("[data-risk-step]").forEach(step => {
    step.setAttribute("aria-current", step.dataset.riskStep === normalized ? "step" : "false");
  });

  switch (normalized) {
    case "high":
      reportHeader.textContent = "高風險文字警示";
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
      reportHeader.textContent = "文案未見明顯紅旗";
      reportBadge.textContent = "低風險（僅文案）";
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

function renderTextList(elementId, values, emptyText) {
  const list = document.getElementById(elementId);
  if (!list) return;
  list.replaceChildren();
  const items = Array.isArray(values) && values.length ? values : [emptyText];
  items.forEach(function(value) {
    const item = document.createElement("li");
    item.textContent = String(value || emptyText);
    list.appendChild(item);
  });
}

function evidenceLabel(entry) {
  if (!entry || typeof entry !== "object") return "未提供結構化證據";
  if (entry.type === "deterministic_rule") {
    return `文字規則｜${entry.label || entry.rule_id || "未命名"}｜${({high:"高風險",medium:"中風險",low:"低風險"})[entry.severity] || "等級未提供"}`;
  }
  if (entry.type === "knowledge_base") {
    return `知識庫｜${entry.source || "未提供來源"}｜${entry.topic || "未提供主題"}`;
  }
  if (entry.type === "llm_text_analysis") {
    return `AI 文字分析｜${entry.status === "available" ? "已完成" : "未能完成"}`;
  }
  return `其他證據｜${entry.type || "unknown"}`;
}

function renderStructuredResult(data) {
  renderTextList("scamReasons", data.reasons, "沒有可顯示的規則原因");
  renderTextList("scamWarnings", data.warnings, "仍需自行查證");
  renderTextList(
    "scamEvidence",
    Array.isArray(data.evidence) ? data.evidence.map(evidenceLabel) : [],
    "沒有可顯示的結構化證據"
  );
  const uncertainty = document.getElementById("scamUncertainty");
  if (uncertainty) {
    const item = data.uncertainty && typeof data.uncertainty === "object"
      ? data.uncertainty : {};
    uncertainty.textContent = item.reason || "資訊不足，請自行查證。";
    const level = document.getElementById("scamUncertaintyLevel");
    if (level) level.textContent = `不確定性：${({high:"高",medium:"中",low:"低"})[item.level] || "未提供"}`;
  }
  const rules = Array.isArray(data.triggered_rules) ? data.triggered_rules : Array.isArray(data.evidence) ? data.evidence.filter(item => item?.type === "deterministic_rule").map(item => item.rule_id || item.label) : null;
  const count = document.getElementById("scamRuleCount");
  if (count) count.textContent = rules ? `${new Set(rules).size} 項命中` : "未提供";
  const ai = Array.isArray(data.evidence) ? data.evidence.find(item => item?.type === "llm_text_analysis") : null;
  const aiState = document.getElementById("scamAiState");
  if (aiState) aiState.textContent = !ai ? "未提供" : ai.status === "available" ? "已完成" : "未能完成";
}

function renderFormattedReport(text) {
  const target = document.getElementById("reportContent");
  if (!target) return;
  target.replaceChildren();
  const formatted = String(text).replace(/\r\n?/g, "\n").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/((?:\d{1,2}[.．、)]\s*)?(?:文字規則命中|AI\s*文字分析|風險等級|疑點解析|防範建議|風險原因|注意事項|查證建議|建議)\s*[:：])/g, "\n\n$1");
  
  formatted.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).forEach(part => {
    const heading = part.match(/^(?:\d{1,2}[.．、)]\s*)?([^\n:：]{1,24})[:：]\s*([\s\S]*)$/);
    const titleText = heading ? heading[1].trim() : "";
    const body = heading ? heading[2] : part;

    // ======== 過濾邏輯：只要標題是「風險等級」就跳過不顯示 ========
    if (titleText === "風險等級" || /^(high|medium|low|unknown)$/i.test(body.trim())) {
      return;
    }

    const section = document.createElement("article");
    section.className = "scam-analysis-block";
    
    if (heading && !body.trim()) {
      const label = document.createElement("h4"); 
      label.className = "scam-analysis-source"; 
      label.textContent = heading[1]; 
      target.appendChild(label); 
      return;
    }
    
    if (heading && heading[1] === "文字規則命中") section.classList.add("scam-rule-summary");
    if (heading) { 
      const title = document.createElement("h4"); 
      title.textContent = heading[1]; 
      section.appendChild(title); 
    }
    
    const paragraphs = body.length > 110 ? body.split(/(?<=[。！？；])\s*|\n+/) : body.split(/\n+/);
    paragraphs.filter(value => value.trim()).forEach(value => { 
      const p = document.createElement("p"); 
      p.textContent = value.trim(); 
      section.appendChild(p); 
    });
    
    target.appendChild(section);
  });
}

function resetScamReport(message = "輸入訊息後，這裡會整理風險、原因與需要查證的地方。") {
  scanGeneration += 1;
  if (scanController) scanController.abort();
  scanController = null;
  latestReportText = "";
  const report = document.getElementById("reportBox"), empty = document.getElementById("reportEmpty"), loading = document.getElementById("scanLoading");
  if (report) report.style.display = "none";
  if (loading) loading.classList.remove("show");
  if (empty) { empty.style.display = "grid"; const caption = empty.querySelector("span"); if (caption) caption.textContent = message; }
  const content = document.getElementById("reportContent");
  if (content) content.replaceChildren();
  const badge = document.getElementById("reportBadge");
  if (badge) { badge.className = ""; badge.textContent = "等待辨識"; }
  const card = document.getElementById("scamReportCard");
  if (card) card.dataset.risk = "unknown";
  const copy = document.getElementById("btnCopyReport");
  if (copy) copy.disabled = true;
  const scan = document.getElementById("btnScan");
  if (scan) { scan.disabled = false; scan.classList.remove("btn-loading"); scan.innerHTML = '<i class="fas fa-search" aria-hidden="true"></i> 開始文案風險辨識'; }
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

  resetScamReport();
  const generation = ++scanGeneration;
  const controller = new AbortController();
  scanController = controller;

  btn.disabled = true;
  btn.classList.add("btn-loading");
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 分析中...';

  reportBox.style.display = "none";
  reportEmpty.style.display = "none";
  scanLoading.classList.add("show");
  const badge = document.getElementById("reportBadge");
  if (badge) badge.textContent = "分析中";

  try {
    const token = await window.authManager?.getToken?.();
    if (generation !== scanGeneration) return;
    const headers = {
      "Content-Type": "application/json"
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch("/api/scam-scan", {
      method: "POST",
      headers: headers,
      signal: controller.signal,
      body: JSON.stringify({ text: text })
    });

    if (generation !== scanGeneration) return;
    scanLoading.classList.remove("show");

    if (res.status === 401) {
      alert("這項功能需要先登入會員後才能使用。");
      reportEmpty.style.display = "grid";
      if (badge) badge.textContent = "尚未完成";
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const reportStr = data.report || "目前沒有取得分析報告。";
    const riskLevel = typeof data.risk_level === "string" ? data.risk_level.toLowerCase() : "unknown";
    if (generation !== scanGeneration) return;
    latestReportText = String(reportStr);
    renderFormattedReport(latestReportText);
    renderStructuredResult(data);
    setReportState(riskLevel);
    reportBox.style.display = "block";
    const copy = document.getElementById("btnCopyReport");
    if (copy) copy.disabled = false;
  } catch (error) {
    if (generation !== scanGeneration || error.name === "AbortError") return;
    scanLoading.classList.remove("show");
    reportEmpty.style.display = "grid";
    const caption = reportEmpty.querySelector("span");
    if (caption) caption.textContent = "這次未能完成分析，請稍後重新辨識。";
    if (badge) badge.textContent = "尚未完成";
  } finally {
    if (generation !== scanGeneration) return;
    scanController = null;
    btn.disabled = false;
    btn.classList.remove("btn-loading");
    btn.innerHTML = '<i class="fas fa-search" aria-hidden="true"></i> 開始文案風險辨識';
  }
}

function initExamples() {
  const input = document.getElementById("scamInput");
  if (!input) return;

  document.querySelectorAll(".exampleChip").forEach(function(btn) {
    btn.addEventListener("click", function() {
      input.value = btn.dataset.example || "";
      resetScamReport("範例已帶入。按下辨識後，才會產生分析結果。");
      document.querySelectorAll(".exampleChip").forEach(item => item.setAttribute("aria-pressed", String(item === btn)));
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
      const text = (latestReportText || (reportContent ? reportContent.textContent : "")).trim();
      if (!text) {
        alert("目前沒有可複製的報告內容。");
        return;
      }

      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        alert("此瀏覽器目前無法使用剪貼簿，請選取報告內容後手動複製。");
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
      resetScamReport();
      if (input) input.value = "";
      if (reportContent) reportContent.textContent = "";
      renderTextList("scamReasons", [], "沒有可顯示的規則原因");
      renderTextList("scamWarnings", [], "仍需自行查證");
      renderTextList("scamEvidence", [], "沒有可顯示的結構化證據");
      const uncertainty = document.getElementById("scamUncertainty");
      if (uncertainty) uncertainty.textContent = "";
      if (reportBox) reportBox.style.display = "none";
      if (scanLoading) scanLoading.classList.remove("show");
      if (reportEmpty) reportEmpty.style.display = "grid";
      if (reportHeader) {
        reportHeader.textContent = "風險辨識結果";
        reportHeader.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
        reportHeader.style.background = "";
      }
      if (reportBadge) {
        reportBadge.textContent = "等待辨識";
        reportBadge.classList.remove("risk-high", "risk-medium", "risk-low", "risk-unknown");
        reportBadge.style.color = "";
        reportBadge.style.background = "";
        reportBadge.style.borderColor = "";
      }
      updateCounter();
      document.querySelectorAll(".exampleChip").forEach(item => item.setAttribute("aria-pressed", "false"));
      if (input) input.focus();
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
    scamInput.addEventListener("input", () => {
      updateCounter();
      resetScamReport("內容已更新，請重新辨識。");
      document.querySelectorAll(".exampleChip").forEach(item => item.setAttribute("aria-pressed", "false"));
    });
  }

  if (btnScan) {
    btnScan.addEventListener("click", runScan);
  }
});
