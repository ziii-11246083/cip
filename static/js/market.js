const fmtUSD = function(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "--";

  const abs = Math.abs(n);
  if (abs >= 1e12) return "USD " + (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return "USD " + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "USD " + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "USD " + (n / 1e3).toFixed(2) + "K";
  if (abs < 1) return "USD " + n.toFixed(4);

  return "USD " + n.toLocaleString(undefined, {
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
let professionalChart = null;
let professionalChartRequest = 0;
let professionalFallbackCandles = null;
let marketChartMode = 'price';

function escapeMarketText(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function marketSparkline(values, color = '#ef7d2d') {
  const numbers = values.map(Number).filter(Number.isFinite);
  if(numbers.length<2)return '';
  const low=Math.min(...numbers),high=Math.max(...numbers),span=high-low||1;
  const points=numbers.map((n,i)=>`${(i/(numbers.length-1)*240).toFixed(1)},${(48-(n-low)/span*40).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label="所選期間的實際價格走勢"><line x1="0" y1="49" x2="240" y2="49" stroke="#f0e2d6"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
}

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
  const rawChange = coin?.price_change_percentage_24h ?? coin?.change;
  return {
    id: coin?.id || symbol.toLowerCase(),
    symbol,
    name: coin?.name || coin?.cn_name || symbol,
    current_price: Number(coin?.current_price ?? coin?.price_usd ?? coin?.price ?? 0),
    price_change_percentage_24h: rawChange == null || rawChange === "" ? NaN : Number(rawChange),
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

async function fetchCandles(ticker, days) {
  const res = await fetchWithTimeout(`/crypto/ohlc?ticker=${encodeURIComponent(ticker)}&vs_currency=usd&days=${encodeURIComponent(days)}&${cacheBust()}`, 30000);
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

  coins = await withBtcQuote(coins);
  popularCoinsCache = Array.isArray(coins) ? coins.filter(function(coin) {
    return coin.symbol && coinPrice(coin) > 0;
  }) : [];

  fillSelects();
  renderPopularCoinCards();
  setTopCoinCardsFromPopular();

  return popularCoinsCache;
}

async function withBtcQuote(coins) {
  const others = coins.filter(coin => coin.symbol !== "BTC");
  try {
    const res = await fetchWithTimeout(`/crypto/quote?ticker=BTC&${cacheBust()}`, 12000);
    if (!res.ok) return others;
    const quote = await res.json();
    const price = Number(quote.current_price);
    if (!Number.isFinite(price) || price <= 0) return others;
    const previous = coins.find(coin => coin.symbol === "BTC");
    return [Object.assign({ id: "bitcoin", symbol: "BTC", name: "Bitcoin", price_change_percentage_24h: NaN }, previous, {
      current_price: price
    }), ...others];
  } catch {
    return others;
  }
}

async function loadTopCardsFromSeriesFallback() {
  // BTC uses the same current quote as trading; daily chart closes are not spot quotes.
  const results = await Promise.allSettled(topSymbols.filter(symbol => symbol !== "BTC").map(function(symbol) {
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

  let fallbackCoins = results
    .filter(function(result) { return result.status === "fulfilled" && coinPrice(result.value) > 0; })
    .map(function(result) { return result.value; });
  fallbackCoins = await withBtcQuote(fallbackCoins);

  const rest = popularCoinsCache.filter(function(coin) {
    return !topSymbols.includes(coin.symbol);
  });
  popularCoinsCache = fallbackCoins.concat(rest);
  fillSelects();
  renderPopularCoinCards();
  setTopCoinCardsFromPopular();

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
  if (score >= 65) return "var(--bad)";
  if (score >= 40) return "var(--warn)";
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
    ['chartPriceSpark','chartDirection','chartVolatilityBars'].forEach(id=>{const el=document.getElementById(id);if(el)el.replaceChildren();});
    const location=document.getElementById('chartPricePosition');if(location)location.hidden=true;
    const changeEl=document.getElementById('chartRangeChange');if(changeEl)changeEl.classList.remove('up','down');
    setText('chartPositionLabel','目前沒有可計算的區間資料');
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
  const highLow=document.getElementById('chartHighLow');
  if(highLow)highLow.innerHTML=`<span class="range-value"><small>最低</small>${fmtUSD(low)}</span><span class="range-value"><small>最高</small>${fmtUSD(high)}</span>`;
  setText("chartVolatility", Number.isFinite(volatility) ? volatility.toFixed(2) + "%" : "--");
  const changeEl=document.getElementById('chartRangeChange');
  if(changeEl){changeEl.classList.toggle('up',rangeChange>=0);changeEl.classList.toggle('down',rangeChange<0);}
  const spark=document.getElementById('chartPriceSpark');if(spark)spark.innerHTML=marketSparkline(values,rangeChange>=0?'#3b8a69':'#c64a44');
  const directionEl=document.getElementById('chartDirection');
  if(directionEl)directionEl.innerHTML=`<i class="fas fa-arrow-trend-${rangeChange>=0?'up':'down'}" aria-hidden="true"></i><span>${rangeChange>=0?'區間上漲':'區間下跌'}</span>`;
  const positionEl=document.getElementById('chartPricePosition');
  if(positionEl){positionEl.hidden=false;positionEl.querySelector('i').style.left=`${nearHigh}%`;}
  setText('chartPositionLabel',`目前價格位於區間 ${nearHigh.toFixed(0)}% 位置`);
  const bars=document.getElementById('chartVolatilityBars');
  if(bars){
    const changes=values.slice(1).map((n,i)=>pctChange(values[i],n)).filter(Number.isFinite).slice(-20);
    const max=Math.max(...changes.map(Math.abs),.01);
    bars.innerHTML=changes.map(n=>`<i class="${n>=0?'up':'down'}" style="--bar-height:${Math.max(5,Math.abs(n)/max*30)}px" title="${fmtChange(n)}"></i>`).join('');
  }

  const direction = rangeChange >= 3 ? "偏多" : rangeChange <= -3 ? "偏弱" : "盤整";
  const location = nearHigh >= 75 ? "接近區間高位，追價要更保守" : nearHigh <= 25 ? "接近區間低位，可觀察是否止跌" : "位於區間中段，適合等待更明確訊號";
  const risk = volatility >= 2 ? "短線波動偏大，建議分批操作。" : "波動相對溫和，但仍需留意突然放量。";

  setText("chartInsight", `${symbol} 這段期間走勢${direction}，${location}。${risk}`);
}

function drawNativeLineChart(canvas, labels, datasets, relative = false) {
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
    ctx.fillText(relative?fmtChange(value):fmtUSD(value), 10, y + 4);
  }

  datasets.forEach(function(ds) {
    ctx.strokeStyle = ds.borderColor || "#ef7d2d";
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
    ctx.fillStyle = ds.borderColor || "#ef7d2d";
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
    const hasTopPrice = topSymbols.some(function(symbol) {
      return coinPrice(getCoinBySymbol(symbol)) > 0;
    });
    snapTime.innerHTML = hasTopPrice
      ? `<i class="fas fa-clock"></i> 資料時間：${new Date().toLocaleString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })}`
      : '<i class="fas fa-circle-exclamation"></i> 即時價格暫時無法取得';
  }
}

function renderPopularCoinCards() {
  const wrap = document.getElementById("popularCoinList");
  const meta = document.getElementById("popularMeta");
  if (!wrap) return;

  wrap.innerHTML = "";
  const coins = popularCoinsCache.slice(0, 10);
  const maxChange = Math.max(...coins.map(coinChange).filter(Number.isFinite).map(Math.abs), .01);
  let upCount = 0;
  let downCount = 0;

  coins.forEach(function(coin) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const change = coinChange(coin);
    const hasChange = Number.isFinite(change);
    const isUp = hasChange && change >= 0;

    if (hasChange && isUp) upCount += 1;
    else if (hasChange) downCount += 1;

    const div = document.createElement("div");
    div.className = `hotChip ${!hasChange || Math.abs(change)<.005?'flat':isUp?'rising':'falling'}`;
    const moveWidth = hasChange ? Math.min(50, Math.abs(change) / maxChange * 50) : 0;
    const moveLabel = !hasChange ? "漲跌資料不足" : Math.abs(change)<.005 ? "持平" : isUp ? "↗ 上漲" : "↘ 下跌";
    const moveDescription = hasChange
      ? `24 小時${isUp?'上漲':'下跌'} ${Math.abs(change).toFixed(2)}%，相對本列幣種的漲跌幅`
      : "24 小時漲跌資料不足";
    div.innerHTML = `
      <div class="hot-card-header"><div class="hot-coin-mark" aria-hidden="true">${escapeMarketText(symbol.slice(0,3))}</div><div><div class="hotSymbol">${escapeMarketText(symbol)}</div><div class="hotName">${escapeMarketText(coin.name || symbol)}</div></div><span class="hot-move-label">${moveLabel}</span></div>
      <div class="hotPrice">${fmtUSD(coinPrice(coin))}</div>
      <div class="hot-change-row"><small>24 小時漲跌</small><div class="hotChange ${hasChange ? isUp ? "up" : "down" : ""}">${fmtChange(change)}</div></div>
      <div class="hot-change-track" role="img" aria-label="${moveDescription}"><i class="hot-change-fill" style="left:${isUp?50:50-moveWidth}%;width:${moveWidth}%"></i><b></b></div>
      <div class="hotActions">
        <button type="button" data-symbol="${escapeMarketText(symbol)}"><i class="fas fa-chart-line" aria-hidden="true"></i> 看走勢</button>
        <a href="/analysis/${encodeURIComponent(symbol)}">深度分析</a>
      </div>
    `;

    div.querySelector("button")?.addEventListener("click", async function(event) {
      event.stopPropagation();
      const marketTicker = document.getElementById("marketTicker");
      if (marketTicker) {
        marketTicker.value = symbol;
        await drawMarketChart();
        document.getElementById('marketComparisonSection')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
      }
    });

    div.querySelector("a")?.addEventListener("click", function(event) {
      event.stopPropagation();
    });

    wrap.appendChild(div);
  });

  if (meta) {
    const knownChangeCount = upCount + downCount;
    const mood = knownChangeCount === 0 ? "資料不足" : upCount === downCount ? "漲跌接近" : upCount > downCount ? "偏強" : "偏弱";
    meta.innerHTML = `<i class="fas fa-fire"></i> 熱門幣種：${mood}`;
  }
  const breadth=document.getElementById('marketBreadth');
  if(breadth){
    const changes=coins.map(coinChange);
    const rising=changes.filter(change=>Number.isFinite(change)&&change>=.005).length;
    const falling=changes.filter(change=>Number.isFinite(change)&&change<=-.005).length;
    const flat=changes.filter(change=>Number.isFinite(change)&&Math.abs(change)<.005).length;
    const unavailable=changes.length-rising-falling-flat;
    breadth.hidden=!coins.length;
    breadth.innerHTML=`<div class="breadth-title"><i class="fas fa-chart-simple" aria-hidden="true"></i><strong>這 ${coins.length} 種幣的漲跌分布</strong><small>24 小時 · 非全市場統計</small></div><div class="breadth-track" role="img" aria-label="${rising} 種上漲、${flat} 種持平、${falling} 種下跌、${unavailable} 種資料不足"><i style="width:${rising/coins.length*100}%" class="breadth-up"></i><i style="width:${flat/coins.length*100}%" class="breadth-flat"></i><i style="width:${falling/coins.length*100}%" class="breadth-down"></i></div><div class="breadth-legend"><span class="up">↗ ${rising} 上漲</span><span>${flat} 持平</span><span class="down">↘ ${falling} 下跌</span>${unavailable ? `<span>${unavailable} 資料不足</span>` : ""}</div>`;
  }
}

function renderMarketSfiTable() {
  const tbody = document.getElementById("marketSfiBody");
  if (!tbody) return;

  const rows = marketSfiCache.slice(0, 8);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="sfi-market-loading">市場資料來源暫時無法取得，SFI 風險排名尚未更新，請稍後再試。</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(coin) {
    const risk = coin.risk || {};
    const hasScore = risk.level !== "base" && risk.score != null && Number.isFinite(Number(risk.score));
    const score = hasScore ? Number(risk.score) : 0;
    const price = Number(coin.price_usd || coin.current_price || 0);
    const change = Number(coin.change ?? coin.price_change_percentage_24h ?? 0);
    const params = new URLSearchParams({
      name: coin.cn_name || coin.name || coin.symbol || "",
      corr: risk.corr || 0,
      score: score,
      beta: risk.beta ?? 1,
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
              <b>${hasScore ? `${score}/100` : risk.msg === "市場基準" ? "基準" : "--"}</b>
            </div>
            ${hasScore ? `<div class="sfi-market-bar">
              <div class="sfi-market-bar-fill"></div>
              <div class="sfi-market-bar-pointer" style="left:${Math.max(0, Math.min(100, score))}%"></div>
            </div>` : ""}
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

    const palette = ["#ef7d2d", "#4b8278", "#10B981", "#c9a572", "#EF4444", "#0F766E"];
    const rawSeries = [mainPts];
    let datasets = [{
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
        rawSeries.push(pts);
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

    const compareLength=Math.min(labels.length,...datasets.map(ds=>ds.data.length));
    labels=labels.slice(-compareLength);
    datasets=datasets.map(ds=>({...ds,data:ds.data.slice(-compareLength)}));
    const relative=marketChartMode==='return';
    // Return comparisons share actual calendar dates, not just array positions.
    let dailyComparison=false;
    if(relative&&rawSeries.length>1){
      const daily=rawSeries.map(points=>new Map(points.map(p=>[new Date(p[0]).toISOString().slice(0,10),Number(p[1])])));
      const dates=Array.from(daily[0].keys()).filter(date=>daily.every(series=>series.has(date))).sort();
      if(dates.length<2)throw new Error('比較幣種沒有足夠的共同日期資料');
      labels=dates.map(date=>date.slice(5));
      datasets=datasets.map((ds,i)=>({...ds,data:dates.map(date=>daily[i].get(date))}));
      dailyComparison=true;
    }
    updateChartSummary(mainTicker, datasets[0].data.map(Number).filter(Number.isFinite));
    if(relative)datasets=datasets.map(ds=>({...ds,label:ds.label.replace('價格','區間漲跌'),data:ds.data.map(n=>pctChange(ds.data[0],n))}));
    setText('chartModeNote',relative?(dailyComparison?'共同日期從 0% 起算，以每日最後一筆價格比較相對漲跌幅。':'從 0% 起算，查看所選期間的累積漲跌幅。'):'查看各幣種的實際價格；比較強弱時可切換漲跌幅。');
    if (sourceNote) {
      const insight = document.getElementById("chartInsight");
      if (insight) insight.textContent = `${insight.textContent} ${sourceNote}`;
    }

    if (marketChart) marketChart.destroy();

    if (typeof Chart === "undefined") {
      drawNativeLineChart(canvas, labels, datasets, relative);
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
                  return `${context.dataset.label}: ${relative?fmtChange(Number(context.raw)):fmtUSD(Number(context.raw))}`;
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false } },
            y: { ticks: { callback: function(value) { return relative?fmtChange(Number(value)):fmtUSD(Number(value)); } } }
          }
        }
      });
    } catch (chartErr) {
      console.error(chartErr);
      drawNativeLineChart(canvas, labels, datasets, relative);
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

function clearTechnicalVisuals() {
  ["taRsiVisual", "taSmaVisual", "taEmaVisual", "taSignalVisual"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.replaceChildren();
  });
  ["taSmaDistance", "taEmaDistance"].forEach(id => setText(id, "等待資料"));
}

function renderTechnicalVisuals(prices, rsi, sma, ema, latest, className) {
  const gauge = document.getElementById("taRsiVisual");
  if (gauge && Number.isFinite(rsi)) {
    const value = Math.max(0, Math.min(100, rsi));
    const angle = value / 100 * Math.PI;
    const x = 100 - 80 * Math.cos(angle), y = 100 - 80 * Math.sin(angle);
    const label = value >= 70 ? "偏熱" : value <= 30 ? "偏冷" : "正常";
    gauge.innerHTML = `<svg viewBox="0 0 200 118" role="img" aria-label="RSI ${rsi.toFixed(1)}，${label}，低於 30 偏冷，高於 70 偏熱">
      <path d="M20 100 A80 80 0 0 1 53 35" fill="none" stroke="#82b297" stroke-width="13" stroke-linecap="round"/>
      <path d="M53 35 A80 80 0 0 1 147 35" fill="none" stroke="#f4ba70" stroke-width="13"/>
      <path d="M147 35 A80 80 0 0 1 180 100" fill="none" stroke="#d97664" stroke-width="13" stroke-linecap="round"/>
      <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="7" fill="#69452d" stroke="#fff" stroke-width="3"/>
      <text x="100" y="92" text-anchor="middle" fill="#795a42" font-size="20">${label}</text>
    </svg><div class="ta-gauge-labels"><span>偏冷</span><span>正常</span><span>偏熱</span></div>`;
  }
  [["taSmaVisual", "taSmaDistance", sma], ["taEmaVisual", "taEmaDistance", ema]].forEach(([id, distanceId, average]) => {
    const host = document.getElementById(id), distance = document.getElementById(distanceId);
    if (!host || !Number.isFinite(average) || average <= 0) return;
    const points = prices.slice(-30);
    const low = Math.min(...points, average), high = Math.max(...points, average);
    const range = Math.max(high - low, high * .001);
    const y = value => 94 - (value - low) / range * 74;
    const coords = points.map((value, i) => [8 + i / Math.max(1, points.length - 1) * 224, y(value)]);
    const path = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    const change = (latest / average - 1) * 100;
    const above = latest >= average, color = above ? "#458b70" : "#c95d50";
    host.innerHTML = `<svg viewBox="0 0 240 110" role="img" aria-label="近 ${points.length} 筆 BTC 價格，實線為價格，虛線為均價，目前${above ? "高於" : "低於"}均價 ${Math.abs(change).toFixed(2)}%">
      <path d="${path} L232 104 L8 104 Z" fill="${color}" opacity=".08"/>
      <path d="M8 ${y(average).toFixed(2)} H232" stroke="#c78c4f" stroke-width="2" stroke-dasharray="5 5"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="232" cy="${y(latest).toFixed(2)}" r="4" fill="${color}"/>
    </svg>`;
    if (distance) distance.innerHTML = `<span><i class="fas fa-arrow-trend-${above ? "up" : "down"}" aria-hidden="true"></i> ${above ? "高於" : "低於"}均價</span><b class="${above ? "up" : "down"}">${fmtChange(change)}</b>`;
  });
  const signal = document.getElementById("taSignalVisual");
  if (signal) {
    const icon = className === "signalBuy" ? "arrow-trend-up" : className === "signalSell" ? "arrow-trend-down" : "arrows-left-right";
    const checks = [["RSI", rsi >= 70 ? "偏熱" : rsi <= 30 ? "偏冷" : "正常", rsi >= 70 ? "down" : "neutral"], ["SMA", latest >= sma ? "上方" : "下方", latest >= sma ? "up" : "down"], ["EMA", latest >= ema ? "上方" : "下方", latest >= ema ? "up" : "down"]];
    signal.innerHTML = `<div class="ta-signal-icon ${className}"><i class="fas fa-${icon}" aria-hidden="true"></i></div><div class="ta-signal-checks">${checks.map(([name, label, tone]) => `<div class="${tone}"><span>${name}</span><b><i class="fas fa-circle" aria-hidden="true"></i> ${label}</b></div>`).join("")}</div>`;
  }
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
    clearTechnicalVisuals();
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
    let text = "均線與動能方向未一致，持續觀察。";

    if (latest > sma && latest > ema && rsi < 70) {
      signal = "偏多";
      className = "signalBuy";
      text = "價格高於兩條均線，動能偏強。";
    } else if (rsi >= 70) {
      signal = "過熱";
      className = "signalSell";
      text = "RSI 高於 70，短期買盤偏熱。";
    } else if (latest < sma && latest < ema) {
      signal = "偏弱";
      className = "signalSell";
      text = "價格低於兩條均線，動能偏弱。";
    }

    if (signalEl) {
      signalEl.classList.remove("signalBuy", "signalSell", "signalNeutral");
      signalEl.classList.add(className);
      signalEl.textContent = signal;
    }

    if (signalTextEl) signalTextEl.textContent = text;
    renderTechnicalVisuals(prices, rsi, sma, ema, latest, className);
    if (taGuide) {
      const rsiLabel = rsi >= 70 ? "偏熱" : rsi <= 30 ? "偏冷" : "正常";
      taGuide.innerHTML = `<strong><i class="fas fa-circle-info" aria-hidden="true"></i> 觀察重點</strong><span>動能${rsiLabel} · 價格${latest > sma ? "高於" : "低於"}中期均價、${latest > ema ? "高於" : "低於"}短期均價。技術訊號僅供參考。</span>`;
    }
    setStatus("taStatus", `<i class="fas fa-check-circle"></i> 已更新`);
  } catch (err) {
    console.error(err);
    clearTechnicalVisuals();
    if (rsiEl) rsiEl.textContent = "--";
    if (smaEl) smaEl.textContent = "--";
    if (emaEl) emaEl.textContent = "--";
    if (signalEl) { signalEl.textContent = "--"; signalEl.classList.remove("signalBuy", "signalSell", "signalNeutral"); }
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

function showProfessionalChartMessage(message, visible) {
  const empty = document.getElementById("tvChartEmpty");
  if (!empty) return;
  empty.textContent = message;
  empty.classList.toggle("is-hidden", !visible);
}

function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map();
  rows.forEach(function(row) {
    const time = Number(row?.time);
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    if (!Number.isSafeInteger(time) || time <= 0 ||
        ![open, high, low, close].every(function(value) { return Number.isFinite(value) && value > 0; }) ||
        high < Math.max(open, close) || low > Math.min(open, close) || high < low) return;
    byTime.set(time, { time, open, high, low, close });
  });
  return Array.from(byTime.values()).sort(function(a, b) { return a.time - b.time; });
}

function disposeProfessionalChart() {
  if (!professionalChart) return;
  professionalChart.remove();
  professionalChart = null;
}

function renderCandlePrices(candle) {
  const value = document.getElementById("tvOhlcValue");
  if (!value) return;
  const fields = [["開盤", "open"], ["最高", "high"], ["最低", "low"], ["收盤", "close"]];
  setText("tvOhlcValue", fields.map(([label, key]) => `${label} ${candle ? fmtUSD(candle[key]) : "--"}`).join("　"));
  value.innerHTML = fields.map(([label, key]) => `<div><span>${label}</span><strong>${candle ? fmtUSD(candle[key]) : "--"}</strong></div>`).join("");
}

function drawNativeCandlestickChart(canvas, candles) {
  const context = canvas.getContext && canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || canvas.parentElement?.clientWidth || 760));
  const height = Math.max(240, Math.floor(rect.height || canvas.parentElement?.clientHeight || 480));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const left = 16;
  const right = width - 86;
  const top = 24;
  const bottom = height - 34;
  const minPrice = Math.min.apply(null, candles.map(function(candle) { return candle.low; }));
  const maxPrice = Math.max.apply(null, candles.map(function(candle) { return candle.high; }));
  const margin = Math.max((maxPrice - minPrice) * .07, maxPrice * .002);
  const lower = minPrice - margin;
  const upper = maxPrice + margin;
  const y = function(price) { return bottom - (price - lower) / (upper - lower) * (bottom - top); };

  context.font = "14px Arial, sans-serif";
  context.textAlign = "left";
  context.strokeStyle = "#efe3d6";
  context.fillStyle = "#8a735f";
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const price = lower + (upper - lower) * i / 4;
    const lineY = y(price);
    context.beginPath();
    context.moveTo(left, lineY);
    context.lineTo(right, lineY);
    context.stroke();
    context.fillText(fmtUSD(price), right + 8, lineY + 4);
  }

  const step = (right - left) / candles.length;
  const bodyWidth = Math.max(2, Math.min(16, step * .65));
  candles.forEach(function(candle, index) {
    const x = left + step * (index + .5);
    const color = candle.close >= candle.open ? "#409171" : "#cc5a50";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x, y(candle.high));
    context.lineTo(x, y(candle.low));
    context.stroke();
    const bodyTop = Math.min(y(candle.open), y(candle.close));
    const bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
    context.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  context.fillStyle = "#8a735f";
  const labelCount = Math.min(5, candles.length);
  for (let i = 0; i < labelCount; i += 1) {
    const index = Math.round((candles.length - 1) * i / Math.max(1, labelCount - 1));
    const date = new Date(candles[index].time * 1000);
    context.fillText(`${date.getMonth() + 1}/${date.getDate()}`, left + step * (index + .5) - 12, height - 10);
  }
}

function renderProfessionalCandles(host, canvas, candles) {
  disposeProfessionalChart();
  const library = window.LightweightCharts;
  if (library && typeof library.createChart === "function" && library.CandlestickSeries) {
    try {
      host.hidden = false;
      canvas.hidden = true;
      const chart = library.createChart(host, {
        autoSize: true,
        width: host.clientWidth || 760,
        height: host.clientHeight || 480,
        layout: {
          background: { type: "solid", color: "#ffffff" },
          textColor: "#8a735f",
          fontSize: 14,
          fontFamily: "Arial, sans-serif",
          attributionLogo: true
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { color: "#f0e6dc", style: 2 }
        },
        crosshair: {
          vertLine: { color: "#db955d", labelBackgroundColor: "#78573e", style: 2 },
          horzLine: { color: "#db955d", labelBackgroundColor: "#78573e", style: 2 }
        },
        rightPriceScale: { borderColor: "#eadbc8", scaleMargins: { top: .12, bottom: .12 } },
        timeScale: { borderColor: "#eadbc8", timeVisible: true, secondsVisible: false, rightOffset: 4 },
        localization: { locale: "zh-TW", priceFormatter: price => fmtUSD(price) }
      });
      professionalChart = chart;
      const series = chart.addSeries(library.CandlestickSeries, {
        upColor: "#409171",
        downColor: "#cc5a50",
        wickUpColor: "#409171",
        wickDownColor: "#cc5a50",
        borderVisible: false,
        priceFormat: { type: "price", precision: 2, minMove: .01 }
      });
      series.setData(candles);
      if (typeof chart.subscribeCrosshairMove === "function") {
        chart.subscribeCrosshairMove(event => {
          const selected = event.seriesData?.get(series);
          renderCandlePrices(selected && [selected.open, selected.high, selected.low, selected.close].every(Number.isFinite) ? selected : candles[candles.length - 1]);
        });
      }
      chart.timeScale().fitContent();
      professionalFallbackCandles = null;
      return;
    } catch (error) {
      console.error("TradingView K 線繪製失敗，改用站內蠟燭圖", error);
      disposeProfessionalChart();
      host.replaceChildren();
    }
  }
  host.hidden = true;
  canvas.hidden = false;
  drawNativeCandlestickChart(canvas, candles);
  professionalFallbackCandles = candles;
}

async function drawProfessionalChart(days) {
  const host = document.getElementById("tvCandlesChart");
  const canvas = document.getElementById("tvFallbackChart");
  if (!host || !canvas) return;
  const requestId = ++professionalChartRequest;
  setText("tvChartStatus", `正在載入 BTC 近 ${days} 天 K 線…`);
  showProfessionalChartMessage("正在載入 K 線資料…", true);

  try {
    const result = await fetchCandles("BTC", days);
    if (requestId !== professionalChartRequest) return;
    const candles = normalizeCandles(result.candles);
    if (candles.length < 2) throw new Error("BTC OHLC unavailable");
    renderProfessionalCandles(host, canvas, candles);

    const source = result.source === "yfinance" ? "Yahoo Finance" : result.source === "coingecko" ? "CoinGecko" : "市場資料";
    const interval = result.interval === "4h" ? "4 小時 K" : result.interval === "4d" ? "4 日 K" : "日 K";
    const latest = candles[candles.length - 1];
    setText("tvChartStatus", `BTC / USD · 近 ${days} 天 · ${interval}`);
    setText("tvSourceNote", `K 線資料來源：${source}。本站為 BTC/USD；外連 TradingView 為 BTC/USDT，兩者報價可能不同。`);
    renderCandlePrices(latest);
    setText("tvLatestPrice", fmtUSD(latest.close));
    const movement = (latest.close / latest.open - 1) * 100;
    const move = document.getElementById("tvCandleMove");
    if (move) {
      move.className = movement >= 0 ? "up" : "down";
      move.textContent = `${movement >= 0 ? "↗" : "↘"} ${fmtChange(movement)} · 最新 K 線`;
    }
    host.setAttribute("aria-label", `BTC 近 ${days} 天 ${interval} 圖`);
    canvas.setAttribute("aria-label", `BTC 近 ${days} 天 ${interval} 圖`);
    showProfessionalChartMessage("", false);
  } catch (error) {
    if (requestId !== professionalChartRequest) return;
    if (error.message !== "BTC OHLC unavailable") console.error(error);
    disposeProfessionalChart();
    professionalFallbackCandles = null;
    host.hidden = true;
    canvas.hidden = true;
    setText("tvChartStatus", "BTC K 線暫時無法取得");
    setText("tvSourceNote", "K 線資料暫時無法取得；仍可在 TradingView 開啟完整圖表。");
    renderCandlePrices(null);
    setText("tvLatestPrice", "--");
    const move = document.getElementById("tvCandleMove");
    if (move) { move.className = ""; move.textContent = "等待資料"; }
    showProfessionalChartMessage("K 線資料暫時無法取得，請稍後重試。", true);
  }
}

function initProfessionalChart() {
  const fallbackCanvas = document.getElementById("tvFallbackChart");
  if (fallbackCanvas) {
    fallbackCanvas.addEventListener("pointermove", event => {
      if (!professionalFallbackCandles || fallbackCanvas.hidden) return;
      const rect = fallbackCanvas.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const x = (event.clientX - rect.left) / rect.width * width;
      const index = Math.floor((x - 16) / (width - 102) * professionalFallbackCandles.length);
      renderCandlePrices(professionalFallbackCandles[index] || professionalFallbackCandles[professionalFallbackCandles.length - 1]);
    });
    fallbackCanvas.addEventListener("pointerleave", () => {
      if (professionalFallbackCandles) renderCandlePrices(professionalFallbackCandles[professionalFallbackCandles.length - 1]);
    });
  }
  const buttons = document.querySelectorAll("[data-tv-days]");
  buttons.forEach(function(button) {
    button.addEventListener("click", function() {
      buttons.forEach(function(item) { item.setAttribute("aria-pressed", String(item === button)); });
      drawProfessionalChart(Number(button.dataset.tvDays));
    });
  });
  window.addEventListener("resize", function() {
    if (!professionalFallbackCandles) return;
    const canvas = document.getElementById("tvFallbackChart");
    if (canvas && !canvas.hidden) drawNativeCandlestickChart(canvas, professionalFallbackCandles);
  });
  drawProfessionalChart(30);
}

async function refreshAll() {
  const btn = document.getElementById("btnQuickDemo");

  setButtonLoading(btn, `<i class="fas fa-spinner fa-spin"></i> 載入中...`);

  try {
    let fallbackAttempted = false;
    await Promise.race([
      loadPopularCoins(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error("market timeout")); }, 10000);
      })
    ]).catch(async function(err) {
      console.error(err);
      fallbackAttempted = true;
      return await loadTopCardsFromSeriesFallback();
    });

    if (!fallbackAttempted && !topSymbols.some(function(symbol) { return coinPrice(getCoinBySymbol(symbol)) > 0; })) {
      await loadTopCardsFromSeriesFallback();
    }

    await Promise.allSettled([
      drawMarketChart(),
      loadTechnicalAnalysis(),
      loadMarketSfiPreview()
    ]);

    if (topSymbols.some(function(symbol) { return coinPrice(getCoinBySymbol(symbol)) > 0; })) {
      toast("資料已更新", "市場總覽已重新整理完成。");
    } else {
      setStatus("snapTime", '<i class="fas fa-circle-exclamation"></i> 即時價格暫時無法取得');
      toast("即時市場資料無法取得", "價格來源暫時無回應，請稍後再試。");
    }
  } catch (err) {
    console.error(err);
    toast("資料載入失敗", "請確認後端 API 是否正常啟動，或 CoinGecko 是否暫時無回應。");
  } finally {
    resetButtonLoading(btn);
  }
}

function initControls() {
  document.querySelectorAll('[data-chart-mode]').forEach(button=>button.addEventListener('click',()=>{
    marketChartMode=button.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    drawMarketChart();
  }));
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
  initProfessionalChart();
  await refreshAll();
});
