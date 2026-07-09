const fmtUSD = function(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "--";

  const abs = Math.abs(n);
  if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (abs < 1) return "$" + n.toFixed(4);

  return "$" + n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const fmtChange = function(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "--";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
};

function setButtonLoading(btn, loadingText) {
  if (!btn) return;
  if (!btn.dataset.originalText) btn.dataset.originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = loadingText || "載入中...";
  btn.classList.add("loading");
}

function resetButtonLoading(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
  btn.classList.remove("loading");
}

let popularCoinsCache = [];
let topSymbols = ["BTC", "ETH", "SOL", "XRP"];
let overlaySymbols = [];
let marketChart = null;
let marketSfiCache = [];

function cacheBust() {
  return `_=${Date.now()}`;
}

async function fetchWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(function() {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMarketCoin(coin) {
  const symbol = String(coin?.symbol || "").toUpperCase();
  return {
    id: coin?.id || symbol.toLowerCase(),
    symbol,
    name: coin?.name || coin?.cn_name || symbol,
    current_price: Number(coin?.current_price ?? coin?.price_usd ?? coin?.price ?? 0),
    price_change_percentage_24h: Number(coin?.price_change_percentage_24h ?? coin?.change ?? 0),
    market_cap_rank: Number(coin?.market_cap_rank ?? coin?.rank ?? 999999)
  };
}

async function fetchPopularCoins(perPage = 30) {
  const res = await fetchWithTimeout(`/crypto/popular?vs_currency=usd&per_page=${perPage}&${cacheBust()}`);
  if (!res.ok) throw new Error(await res.text());
  const coins = await res.json();
  return Array.isArray(coins) ? coins.map(normalizeMarketCoin) : [];
}

async function fetchMarketCoinsFallback() {
  const res = await fetchWithTimeout(`/api/market?${cacheBust()}`);
  if (!res.ok) throw new Error(await res.text());
  const payload = await res.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeMarketCoin);
}

async function fetchSeries(ticker, days) {
  const res = await fetchWithTimeout(`/crypto/series?ticker=${encodeURIComponent(ticker)}&vs_currency=usd&days=${encodeURIComponent(days)}&${cacheBust()}`, 12000);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function loadPopularCoins() {
  setStatus("snapTime", `<i class="fas fa-spinner fa-spin"></i> 正在更新價格`);
  let coins = await fetchPopularCoins(30);
  const hasUsableTopPrices = topSymbols.some(function(symbol) {
    return coinPrice(coins.find(function(coin) { return coin.symbol === symbol; })) > 0;
  });

  if (!hasUsableTopPrices) {
    coins = await fetchMarketCoinsFallback();
  }

  popularCoinsCache = Array.isArray(coins) ? coins.filter(function(coin) {
    return coin.symbol && coinPrice(coin) > 0;
  }) : [];

  fillSelects();
  renderPopularCoinCards();
  setTopCoinCardsFromPopular();

  return popularCoinsCache;
}

async function loadTopCardsFromSeriesFallback() {
  const results = await Promise.allSettled(topSymbols.map(function(symbol) {
    return fetchSeries(symbol, 1).then(function(series) {
      const prices = Array.isArray(series.prices) ? series.prices : [];
      const first = prices[0] ? Number(prices[0][1]) : NaN;
      const last = prices.length ? Number(prices[prices.length - 1][1]) : NaN;
      return normalizeMarketCoin({
        id: series.coin_id,
        symbol,
        name: symbol,
        current_price: last,
        price_change_percentage_24h: pctChange(first, last)
      });
    });
  }));

  const fallbackCoins = results
    .filter(function(result) { return result.status === "fulfilled" && coinPrice(result.value) > 0; })
    .map(function(result) { return result.value; });

  if (fallbackCoins.length) {
    const rest = popularCoinsCache.filter(function(coin) {
      return !topSymbols.includes(coin.symbol);
    });
    popularCoinsCache = fallbackCoins.concat(rest);
    fillSelects();
    renderPopularCoinCards();
    setTopCoinCardsFromPopular();
  }

  return fallbackCoins;
}

function fillSelects() {
  const marketTicker = document.getElementById("marketTicker");
  const overlaySelect = document.getElementById("overlaySelect");

  if (marketTicker) marketTicker.innerHTML = "";
  if (overlaySelect) overlaySelect.innerHTML = "";

  popularCoinsCache.forEach(function(coin) {
    const symbol = String(coin.symbol || "").toUpperCase();
    if (!symbol) return;

    const label = `${symbol} (${coin.name || symbol})`;
    if (marketTicker) marketTicker.add(new Option(label, symbol, false, symbol === "BTC"));
    if (overlaySelect) overlaySelect.add(new Option(label, symbol));
  });
}

function getCoinBySymbol(symbol) {
  symbol = String(symbol || "").toUpperCase();
  return popularCoinsCache.find(function(coin) {
    return String(coin.symbol || "").toUpperCase() === symbol;
  });
}

function setChangeEl(el, change) {
  if (!el) return;

  change = Number(change);
  el.classList.remove("up", "down");

  if (!Number.isFinite(change)) {
    el.textContent = "--";
    return;
  }

  if (change >= 0) {
    el.classList.add("up");
    el.innerHTML = `<i class="fas fa-arrow-trend-up"></i> ${fmtChange(change)} / 24h`;
  } else {
    el.classList.add("down");
    el.innerHTML = `<i class="fas fa-arrow-trend-down"></i> ${fmtChange(change)} / 24h`;
  }
}

function coinPrice(coin) {
  return Number(coin?.current_price ?? coin?.price_usd ?? coin?.price ?? 0);
}

function coinChange(coin) {
  return Number(coin?.price_change_percentage_24h ?? coin?.change ?? 0);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setStatus(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = value;
}

function riskTone(score) {
  score = Number(score);
  if (score > 65) return "var(--bad)";
  if (score > 40) return "var(--warn)";
  return "var(--good)";
}

function showChartMessage(message, isVisible) {
  const empty = document.getElementById("chartEmpty");
  if (!empty) return;
  empty.textContent = message;
  empty.classList.toggle("is-hidden", !isVisible);
}

function pctChange(start, end) {
  start = Number(start);
  end = Number(end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return NaN;
  return ((end - start) / start) * 100;
}

function estimateVolatility(values) {
  if (!values || values.length < 3) return NaN;
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    const prev = Number(values[i - 1]);
    const curr = Number(values[i]);
    if (prev > 0 && Number.isFinite(curr)) returns.push((curr - prev) / prev);
  }
  if (!returns.length) return NaN;
  const avg = returns.reduce(function(a, b) { return a + b; }, 0) / returns.length;
  const variance = returns.reduce(function(sum, r) { return sum + Math.pow(r - avg, 2); }, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function updateChartSummary(symbol, values) {
  if (!values.length) {
    setText("chartLatest", "--");
    setText("chartRangeChange", "--");
    setText("chartHighLow", "--");
    setText("chartVolatility", "--");
    setText("chartInsight", "目前沒有足夠資料，請稍後重試或換一個幣種。");
    return;
  }

  const first = values[0];
  const latest = values[values.length - 1];
  const high = Math.max.apply(null, values);
  const low = Math.min.apply(null, values);
  const rangeChange = pctChange(first, latest);
  const volatility = estimateVolatility(values);
  const nearHigh = high > low ? ((latest - low) / (high - low)) * 100 : 50;

  setText("chartLatest", fmtUSD(latest));
  setText("chartRangeChange", fmtChange(rangeChange));
  setText("chartHighLow", `${fmtUSD(low)} / ${fmtUSD(high)}`);
  setText("chartVolatility", Number.isFinite(volatility) ? volatility.toFixed(2) + "%" : "--");

  const direction = rangeChange >= 3 ? "偏多" : rangeChange <= -3 ? "偏弱" : "盤整";
  const location = nearHigh >= 75 ? "接近區間高位，追價要更保守" : nearHigh <= 25 ? "接近區間低位，可觀察是否止跌" : "位於區間中段，適合等待更明確訊號";
  const risk = volatility >= 2 ? "短線波動偏大，建議分批操作。" : "波動相對溫和，但仍需留意突然放量。";

  setText("chartInsight", `${symbol} 這段期間走勢${direction}，${location}。${risk}`);
}

function drawNativeLineChart(canvas, labels, datasets) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 900));
  const height = Math.max(260, Math.floor(rect.height || canvas.clientHeight || 420));

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 62, right: 24, top: 28, bottom: 46 };
  const allValues = datasets.flatMap(function(ds) {
    return ds.data.map(Number).filter(Number.isFinite);
  });
  const min = Math.min.apply(null, allValues);
  const max = Math.max.apply(null, allValues);
  const span = max - min || 1;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(120, 79, 35, .16)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8A5A2B";
  ctx.font = "12px sans-serif";

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH * i / 4);
    const value = max - (span * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(fmtUSD(value), 10, y + 4);
  }

  datasets.forEach(function(ds) {
    ctx.strokeStyle = ds.borderColor || "#F97316";
    ctx.lineWidth = ds.borderWidth || 3;
    ctx.beginPath();

    ds.data.forEach(function(value, idx) {
      const x = pad.left + (idx / Math.max(1, ds.data.length - 1)) * plotW;
      const y = pad.top + (1 - ((Number(value) - min) / span)) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  });

  const firstLabel = labels[0] || "";
  const lastLabel = labels[labels.length - 1] || "";
  ctx.fillStyle = "#6B4A2B";
  ctx.fillText(firstLabel, pad.left, height - 18);
  ctx.fillText(lastLabel, width - pad.right - 56, height - 18);

  datasets.forEach(function(ds, idx) {
    const x = pad.left + idx * 130;
    const y = 18;
    ctx.fillStyle = ds.borderColor || "#F97316";
    ctx.fillRect(x, y - 9, 16, 4);
    ctx.fillStyle = "#2B1608";
    ctx.fillText(ds.label, x + 22, y);
  });
}

function setTopCoinCardsFromPopular() {
  topSymbols.forEach(function(symbol) {
    const coin = getCoinBySymbol(symbol);
    const priceEl = document.getElementById(`card${symbol}Price`);
    const changeEl = document.getElementById(`card${symbol}Change`);

    if (priceEl) priceEl.textContent = coin ? fmtUSD(coinPrice(coin)) : "--";
    if (changeEl) setChangeEl(changeEl, coin ? coinChange(coin) : NaN);
  });

  const snapTime = document.getElementById("snapTime");
  if (snapTime) {
    snapTime.innerHTML = `<i class="fas fa-clock"></i> 資料時間：${new Date().toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })}`;
  }
}

function renderPopularCoinCards() {
  const wrap = document.getElementById("popularCoinList");
  const meta = document.getElementById("popularMeta");
  if (!wrap) return;

  wrap.innerHTML = "";
  const coins = popularCoinsCache.slice(0, 10);
  let upCount = 0;
  let downCount = 0;

  coins.forEach(function(coin) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const change = coinChange(coin);
    const isUp = change >= 0;

    if (isUp) upCount += 1;
    else downCount += 1;

    const div = document.createElement("div");
    div.className = "hotChip";
    div.innerHTML = `
      <div class="hotSymbol">
        <span>${symbol}</span>
        <span class="hotIcon">${isUp ? "↑" : "↓"}</span>
      </div>
      <div class="hotName">${coin.name || symbol}</div>
      <div class="hotPrice">${fmtUSD(coinPrice(coin))}</div>
      <div class="hotChange ${isUp ? "up" : "down"}">${fmtChange(change)} / 24h</div>
      <div class="hotActions">
        <button type="button" data-symbol="${symbol}">看走勢</button>
        <a href="/analysis/${encodeURIComponent(symbol)}">深度分析</a>
      </div>
    `;

    div.querySelector("button")?.addEventListener("click", async function(event) {
      event.stopPropagation();
      const marketTicker = document.getElementById("marketTicker");
      if (marketTicker) {
        marketTicker.value = symbol;
        await drawMarketChart();
      }
    });

    div.querySelector("a")?.addEventListener("click", function(event) {
      event.stopPropagation();
    });

    wrap.appendChild(div);
  });

  if (meta) {
    const mood = upCount >= downCount ? "偏強" : "偏弱";
    meta.innerHTML = `<i class="fas fa-fire"></i> 熱門幣種：${mood}`;
  }
}

function renderMarketSfiTable() {
  const tbody = document.getElementById("marketSfiBody");
  if (!tbody) return;

  const rows = marketSfiCache.slice(0, 8);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="sfi-market-loading">目前沒有可顯示的風險資料。</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(coin) {
    const risk = coin.risk || {};
    const score = Number(risk.score || 0);
    const price = Number(coin.price_usd || coin.current_price || 0);
    const change = Number(coin.change ?? coin.price_change_percentage_24h ?? 0);
    const params = new URLSearchParams({
      name: coin.cn_name || coin.name || coin.symbol || "",
      corr: risk.corr || 0,
      score: score,
      beta: risk.beta || 1,
      lambda: risk.lambda || 0,
      level: risk.level || "base"
    }).toString();

    return `
      <tr>
        <td>${coin.rank || "--"}</td>
        <td>
          <div class="sfi-market-coin">
            <strong>${coin.cn_name || coin.name || coin.symbol || "--"}</strong>
            <span>${coin.symbol || "--"}</span>
          </div>
        </td>
        <td>${fmtUSD(price)}</td>
        <td class="${change >= 0 ? "up" : "down"}">${fmtChange(change)}</td>
        <td>
          <div class="sfi-market-score">
            <div class="sfi-market-score-head">
              <span style="color:${riskTone(score)};">${risk.msg || "風險觀察中"}</span>
              <b>${score}/100</b>
            </div>
            <div class="sfi-market-bar">
              <div class="sfi-market-bar-fill"></div>
              <div class="sfi-market-bar-pointer" style="left:${Math.max(0, Math.min(100, score))}%"></div>
            </div>
            ${coin.symbol !== "BTC" ? `<a class="tool-badge" href="/analysis/${coin.symbol}?${params}"><i class="fas fa-arrow-right"></i> 深度分析</a>` : ""}
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadMarketSfiPreview() {
  const tbody = document.getElementById("marketSfiBody");
  if (!tbody) return;

  try {
    const res = await fetchWithTimeout(`/api/coingecko?${cacheBust()}`, 20000);
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    marketSfiCache = Array.isArray(payload?.data) ? payload.data : [];
    renderMarketSfiTable();
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5" class="sfi-market-loading">風險資料載入失敗，請稍後再試。</td></tr>';
  }
}

async function drawMarketChart() {
  const tickerEl = document.getElementById("marketTicker");
  const daysEl = document.getElementById("marketDays");
  const canvas = document.getElementById("marketChart");
  if (!tickerEl || !daysEl || !canvas) return;

  const mainTicker = tickerEl.value || "BTC";
  const days = Number(daysEl.value || 30);
  setStatus("chartStatus", `<i class="fas fa-spinner fa-spin"></i> 載入走勢`);
  showChartMessage("正在讀取走勢資料...", true);

  try {
    const mainSeries = await fetchSeries(mainTicker, days);
    const mainPts = Array.isArray(mainSeries.prices) ? mainSeries.prices : [];

    if (!mainPts.length) {
      setStatus("chartStatus", `<i class="fas fa-circle-exclamation"></i> 無資料`);
      updateChartSummary(mainTicker, []);
      toast("圖表資料不足", "目前沒有取得走勢資料，請稍後再試。");
      showChartMessage("目前沒有取得走勢資料，請稍後再試。", true);
      return;
    }

    let labels = mainPts.map(function(p) {
      return new Date(p[0]).toLocaleDateString("zh-TW", {
        month: "short",
        day: "numeric"
      });
    });
    const sourceNote = mainSeries.source === "sparkline"
      ? "目前使用 7 日備援走勢，因完整歷史資料暫時無法取得。"
      : mainSeries.source === "current_price"
        ? "目前使用 24 小時價格參考線，因完整走勢資料暫時無法取得。"
        : "";

    const palette = ["#F97316", "#2563EB", "#10B981", "#8B5CF6", "#EF4444", "#0F766E"];
    const datasets = [{
      label: `${mainTicker} 價格`,
      data: mainPts.map(function(p) { return p[1]; }),
      tension: 0.28,
      borderColor: palette[0],
      backgroundColor: "rgba(249,115,22,.12)",
      pointRadius: 0,
      borderWidth: 3,
      fill: true
    }];

    for (let i = 0; i < overlaySymbols.length; i += 1) {
      const symbol = overlaySymbols[i];
      const series = await fetchSeries(symbol, days);
      const pts = Array.isArray(series.prices) ? series.prices : [];

      if (pts.length) {
        const len = Math.min(mainPts.length, pts.length);
        labels = labels.slice(-len);
        datasets.push({
          label: `${symbol} 價格`,
          data: pts.slice(-len).map(function(p) { return p[1]; }),
          tension: 0.28,
          borderColor: palette[(i + 1) % palette.length],
          pointRadius: 0,
          borderWidth: 3,
          fill: false
        });
      }
    }

    updateChartSummary(mainTicker, datasets[0].data.map(Number).filter(Number.isFinite));
    if (sourceNote) {
      const insight = document.getElementById("chartInsight");
      if (insight) insight.textContent = `${insight.textContent} ${sourceNote}`;
    }

    if (marketChart) marketChart.destroy();

    if (typeof Chart === "undefined") {
      drawNativeLineChart(canvas, labels, datasets);
      setStatus("chartStatus", `<i class="fas fa-check-circle"></i> 已載入`);
      showChartMessage("", false);
      renderOverlayList();
      return;
    }

    try {
      marketChart = new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: true, labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
            tooltip: {
              callbacks: {
                label: function(context) {
                  return `${context.dataset.label}: ${fmtUSD(Number(context.raw))}`;
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false } },
            y: { ticks: { callback: function(value) { return fmtUSD(Number(value)); } } }
          }
        }
      });
    } catch (chartErr) {
      console.error(chartErr);
      drawNativeLineChart(canvas, labels, datasets);
    }

    setStatus("chartStatus", `<i class="fas fa-check-circle"></i> 已載入`);
    showChartMessage("", false);
    renderOverlayList();
  } catch (err) {
    console.error(err);
    setStatus("chartStatus", `<i class="fas fa-circle-exclamation"></i> 載入失敗`);
    showChartMessage("資料暫時無法載入，請確認網路或稍後重試。", true);
    toast("資料載入失敗", "請確認後端 API 是否正常啟動，或稍後再試。");
  }
}

function renderOverlayList() {
  const wrap = document.getElementById("overlayList");
  if (!wrap) return;

  wrap.innerHTML = "";
  overlaySymbols.forEach(function(symbol) {
    const div = document.createElement("div");
    div.className = "overlayChip";
    div.innerHTML = `<span>${symbol}</span><button data-remove="${symbol}" type="button">×</button>`;
    wrap.appendChild(div);
  });

  wrap.querySelectorAll("[data-remove]").forEach(function(btn) {
    btn.onclick = async function() {
      const removeSymbol = btn.getAttribute("data-remove");
      overlaySymbols = overlaySymbols.filter(function(x) { return x !== removeSymbol; });
      await drawMarketChart();
    };
  });
}

async function loadTechnicalAnalysis() {
  const rsiEl = document.getElementById("taRsi");
  const smaEl = document.getElementById("taSma");
  const emaEl = document.getElementById("taEma");
  const signalEl = document.getElementById("taSignal");
  const signalTextEl = document.getElementById("taSignalText");
  const taGuide = document.getElementById("taGuide");

  try {
    setStatus("taStatus", `<i class="fas fa-spinner fa-spin"></i> 計算中`);
    const series = await fetchSeries("BTC", 90);
    const prices = (series.prices || []).map(function(p) {
      return Number(p[1]);
    }).filter(Number.isFinite);

    if (prices.length < 30) throw new Error("資料不足");

    const rsi = calculateRSI(prices, 14);
    const sma = calculateSMA(prices, Math.min(50, prices.length));
    const ema = calculateEMA(prices, 20);
    const latest = prices[prices.length - 1];

    if (rsiEl) rsiEl.textContent = Number.isFinite(rsi) ? rsi.toFixed(1) : "--";
    if (smaEl) smaEl.textContent = fmtUSD(sma);
    if (emaEl) emaEl.textContent = fmtUSD(ema);

    let signal = "觀望";
    let className = "signalNeutral";
    let text = "市場仍需更多確認，適合保留彈性。";

    if (latest > sma && latest > ema && rsi < 70) {
      signal = "偏多";
      className = "signalBuy";
      text = "價格站上兩條均線，RSI 也沒有過熱，短線動能偏強；新手可等回檔或突破後再分批進場。";
    } else if (rsi >= 70) {
      signal = "過熱";
      className = "signalSell";
      text = "RSI 高於 70，代表買盤偏熱；不適合盲目追高，應先設定停利停損。";
    } else if (latest < sma && latest < ema) {
      signal = "偏弱";
      className = "signalSell";
      text = "價格跌破 SMA 與 EMA，短中期動能偏弱；新手先觀望，等價格重新站回均線。";
    }

    if (signalEl) {
      signalEl.classList.remove("signalBuy", "signalSell", "signalNeutral");
      signalEl.classList.add(className);
      signalEl.textContent = signal;
    }

    if (signalTextEl) signalTextEl.textContent = text;
    if (taGuide) {
      const rsiLabel = rsi >= 70 ? "偏熱" : rsi <= 30 ? "偏冷" : "正常";
      taGuide.innerHTML = `<strong>新手解讀</strong><span>目前 BTC RSI 為 ${rsi.toFixed(1)}，屬於${rsiLabel}區間。價格 ${latest > sma ? "高於" : "低於"} SMA(50)，${latest > ema ? "高於" : "低於"} EMA(20)，綜合判斷為「${signal}」。</span>`;
    }
    setStatus("taStatus", `<i class="fas fa-check-circle"></i> 已更新`);
  } catch (err) {
    console.error(err);
    if (rsiEl) rsiEl.textContent = "--";
    if (smaEl) smaEl.textContent = "--";
    if (emaEl) emaEl.textContent = "--";
    if (signalEl) signalEl.textContent = "--";
    if (signalTextEl) signalTextEl.textContent = "技術分析資料暫時無法取得。";
    if (taGuide) taGuide.innerHTML = `<strong>新手解讀</strong><span>目前無法取得足夠價格資料，請稍後重新整理。這不代表市場沒有風險，只是系統暫時不能計算指標。</span>`;
    setStatus("taStatus", `<i class="fas fa-circle-exclamation"></i> 無法計算`);
  }
}

function calculateSMA(values, period) {
  if (!values.length) return NaN;
  const slice = values.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / slice.length;
}

function calculateEMA(values, period) {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let ema = calculateSMA(values.slice(0, period), period);
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(values, period) {
  if (values.length <= period) return NaN;

  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function initTradingView() {
  const holder = document.getElementById("tv_chart_container");
  if (!holder || !window.TradingView) return;

  holder.innerHTML = "";

  new TradingView.widget({
    autosize: false,
    width: holder.clientWidth || "100%",
    height: holder.clientHeight || 520,
    symbol: "BINANCE:BTCUSDT",
    interval: "60",
    timezone: "Asia/Taipei",
    theme: "light",
    style: "1",
    locale: "zh_TW",
    enable_publishing: false,
    backgroundColor: "rgba(255,255,255,1)",
    hide_top_toolbar: false,
    save_image: false,
    container_id: "tv_chart_container",
    allow_symbol_change: true,
    studies: ["RSI@tv-basicstudies"]
  });
}

async function refreshAll() {
  const btn = document.getElementById("btnQuickDemo");

  setButtonLoading(btn, `<i class="fas fa-spinner fa-spin"></i> 載入中...`);

  try {
    const marketResult = await Promise.race([
      loadPopularCoins(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error("market timeout")); }, 10000);
      })
    ]).catch(async function(err) {
      console.error(err);
      return await loadTopCardsFromSeriesFallback();
    });

    if (!marketResult || !marketResult.length) {
      await loadTopCardsFromSeriesFallback();
    }

    await Promise.allSettled([
      drawMarketChart(),
      loadTechnicalAnalysis(),
      loadMarketSfiPreview()
    ]);

    toast("資料已更新", "市場總覽已重新整理完成。");
  } catch (err) {
    console.error(err);
    toast("資料載入失敗", "請確認後端 API 是否正常啟動，或 CoinGecko 是否暫時無回應。");
  } finally {
    resetButtonLoading(btn);
  }
}

function initControls() {
  const btnQuickDemo = document.getElementById("btnQuickDemo");
  const btnAddOverlay = document.getElementById("btnAddOverlay");
  const btnClearOverlay = document.getElementById("btnClearOverlay");
  const marketTicker = document.getElementById("marketTicker");
  const marketDays = document.getElementById("marketDays");

  if (btnQuickDemo) btnQuickDemo.addEventListener("click", refreshAll);

  if (btnAddOverlay) {
    btnAddOverlay.addEventListener("click", async function() {
      const overlaySelect = document.getElementById("overlaySelect");
      const tickerEl = document.getElementById("marketTicker");
      if (!overlaySelect || !tickerEl) return;

      const symbol = overlaySelect.value;
      if (!symbol) return;

      if (symbol === tickerEl.value) {
        toast("已是主要幣種", "比較幣種請選擇不同標的。");
        return;
      }

      if (overlaySymbols.includes(symbol)) {
        toast("已加入比較", `${symbol} 已經在圖表中。`);
        return;
      }

      overlaySymbols.push(symbol);
      await drawMarketChart();
    });
  }

  if (btnClearOverlay) {
    btnClearOverlay.addEventListener("click", async function() {
      overlaySymbols = [];
      await drawMarketChart();
    });
  }

  if (marketTicker) marketTicker.addEventListener("change", drawMarketChart);
  if (marketDays) marketDays.addEventListener("change", drawMarketChart);
}

function initReveal() {
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) entry.target.classList.add("is-visible");
      });
    }, { threshold: 0.14 });

    revealEls.forEach(function(el) { revealObserver.observe(el); });
  } else {
    revealEls.forEach(function(el) { el.classList.add("is-visible"); });
  }
}

window.addEventListener("DOMContentLoaded", async function() {
  initControls();
  initReveal();
  initTradingView();
  await refreshAll();
});
