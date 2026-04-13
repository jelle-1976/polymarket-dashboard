const state = {
  tokens: {},
  prices: {},
  history: {},
  cooldowns: {},
  alerts: [],
  browserWs: null,
  sessionId: null,
};

function config() {
  return {
    slugs: document.getElementById("slugs").value.split(",").map(s => s.trim()).filter(Boolean),
    windowSeconds: Math.max(5, Number(document.getElementById("window").value || 60)),
    thresholdPp: Math.max(0.1, Number(document.getElementById("threshold").value || 5)),
    cooldownSeconds: Math.max(0, Number(document.getElementById("cooldown").value || 180)),
  };
}

function pct(x) {
  return Number.isFinite(x) ? (x * 100).toFixed(2) + "%" : "—";
}

function pp(x) {
  return Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) + " pp" : "—";
}

function setStatus(text, cls) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = cls || "muted";
}

function getMid(bestBid, bestAsk) {
  const bid = bestBid == null ? null : Number(bestBid);
  const ask = bestAsk == null ? null : Number(bestAsk);
  const bidOk = Number.isFinite(bid) && bid >= 0 && bid <= 1;
  const askOk = Number.isFinite(ask) && ask >= 0 && ask <= 1;
  if (bidOk && askOk) return (bid + ask) / 2;
  if (bidOk) return bid;
  if (askOk) return ask;
  return null;
}

function render() {
  const cfg = config();
  const tracked = Object.values(state.tokens).map(token => {
    const current = state.prices[token.assetId];
    const bucket = state.history[token.assetId] || [];
    const first = bucket.length ? bucket[0].price : null;
    const currentPrice = current ? current.price : null;
    const movePp = first != null && currentPrice != null ? (currentPrice - first) * 100 : null;
    return { ...token, currentPrice, movePp };
  }).sort((a, b) => Math.abs((b.movePp || 0)) - Math.abs((a.movePp || 0)));

  const trackedHtml = tracked.length
    ? tracked.map(row => `
      <div style="padding:10px 0;border-top:1px solid #334155">
        <div><strong>${row.question}</strong></div>
        <div style="margin:6px 0">
          <span class="pill">${row.outcome}</span>
          <span class="pill">${row.slug}</span>
        </div>
        <div class="row">
          <div>Current: <strong>${pct(row.currentPrice)}</strong></div>
          <div>Move: <strong class="${Math.abs(row.movePp || 0) >= cfg.thresholdPp ? "warn" : ""}">${pp(row.movePp || 0)}</strong></div>
        </div>
      </div>
    `).join("")
    : '<div class="muted">No outcomes loaded yet.</div>';

  const alertsHtml = state.alerts.length
    ? state.alerts.map(a => `
      <div style="padding:10px 0;border-top:1px solid #334155">
        <div><strong>${a.question}</strong></div>
        <div style="margin:6px 0">
          <span class="pill">${a.outcome}</span>
          <span class="pill">${a.slug}</span>
        </div>
        <div>Move: <strong class="warn">${pp(a.deltaPp)}</strong></div>
        <div class="muted">From ${pct(a.fromPrice)} to ${pct(a.toPrice)}</div>
      </div>
    `).join("")
    : '<div class="muted">No alerts yet.</div>';

  document.getElementById("tracked").innerHTML = trackedHtml;
  document.getElementById("alerts").innerHTML = alertsHtml;
}

function applyPrice(assetId, price, ts) {
  if (!assetId || !Number.isFinite(price)) return;
  state.prices[assetId] = { price, ts };

  const cfg = config();
  const bucket = state.history[assetId] || [];
  const cutoff = ts - cfg.windowSeconds * 1000;
  const trimmed = bucket.filter(x => x.ts >= cutoff);
  trimmed.push({ ts, price });
  state.history[assetId] = trimmed;

  if (trimmed.length >= 2) {
    const oldest = trimmed[0];
    const newest = trimmed[trimmed.length - 1];
    const deltaPpAbs = Math.abs((newest.price - oldest.price) * 100);
    const last = state.cooldowns[assetId] || 0;

    if (
      newest.ts - oldest.ts >= Math.min(5000, cfg.windowSeconds * 1000) &&
      deltaPpAbs >= cfg.thresholdPp &&
      ts - last >= cfg.cooldownSeconds * 1000
    ) {
      state.cooldowns[assetId] = ts;
      const token = state.tokens[assetId];
      if (token) {
        state.alerts.unshift({
          question: token.question,
          slug: token.slug,
          outcome: token.outcome,
          fromPrice: oldest.price,
          toPrice: newest.price,
          deltaPp: (newest.price - oldest.price) * 100,
        });
fetch("/api/send-alert", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: token.question,
    slug: token.slug,
    outcome: token.outcome,
    fromPrice: oldest.price,
    toPrice: newest.price,
    deltaPp: (newest.price - oldest.price) * 100,
  }),
}).catch(() => {});
        state.alerts = state.alerts.slice(0, 50);
      }
    }
  }

  render();
}

function handleEvent(payload) {
  const eventType = payload.event_type;
  const ts = payload.timestamp ? Number(payload.timestamp) : Date.now();

  if (eventType === "best_bid_ask") {
    applyPrice(payload.asset_id, getMid(payload.best_bid, payload.best_ask), ts);
  } else if (eventType === "last_trade_price") {
    applyPrice(payload.asset_id, Number(payload.price), ts);
  } else if (eventType === "price_change") {
    for (const change of payload.price_changes || []) {
      let price = getMid(change.best_bid, change.best_ask);
      if (price == null) price = Number(change.price);
      applyPrice(change.asset_id, price, ts);
    }
  } else if (eventType === "book") {
    const bids = payload.bids || [];
    const asks = payload.asks || [];
    const bestBid = bids.length ? bids[bids.length - 1].price : null;
    const bestAsk = asks.length ? asks[0].price : null;
    applyPrice(payload.asset_id, getMid(bestBid, bestAsk), ts);
  }
}

async function startSession() {
  state.tokens = {};
  state.prices = {};
  state.history = {};
  state.cooldowns = {};
  state.alerts = [];
  render();

  setStatus("Starting session...", "muted");
  const res = await fetch("/api/start-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slugs: config().slugs })
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || "Failed to start session", "bad");
    return;
  }

  state.sessionId = data.sessionId;
  for (const token of data.tokens || []) state.tokens[token.assetId] = token;
  render();

  if (state.browserWs) state.browserWs.close();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  state.browserWs = new WebSocket(proto + "//" + location.host + "/browser-ws");

  state.browserWs.onopen = () => {
    setStatus("Connected", "ok");
    state.browserWs.send(JSON.stringify({ type: "attach_session", sessionId: state.sessionId }));
  };

  state.browserWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "market_event") handleEvent(msg.payload || {});
    if (msg.type === "server_warning" || msg.type === "server_error") {
      setStatus(msg.message || "Server message", "bad");
    }
  };

  state.browserWs.onclose = () => {
    setStatus("Disconnected", "bad");
  };
}

document.getElementById("apply").addEventListener("click", startSession);
startSession();
