const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const https = require("https");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const https = require("https");

function sendTelegramMessage(text) {
  console.log("USING HTTPS TELEGRAM");
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram missing config");
    return;
  }

  const data = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    },
  };

  const req = https.request(options, (res) => {
    let body = "";

    res.on("data", (chunk) => {
      body += chunk;
    });

    res.on("end", () => {
      console.log("Telegram response", res.statusCode, body);
    });
  });

  req.on("error", (err) => {
    console.error("Telegram error:", err.message);
  });

  req.write(data);
  req.end();
}

const PORT = process.env.PORT || 3000;
const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream request failed (${res.status}): ${text || url}`);
  }
  return res.json();
}

function parseMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function tokensForSlug(slug) {
  const data = await fetchJson(`${GAMMA_API}/markets/slug/${encodeURIComponent(slug)}`);
  const rawIds = data.clobTokenIds ?? data.clob_token_ids ?? [];
  const rawOutcomes = data.outcomes ?? [];
  const tokenIds = Array.isArray(rawIds) ? rawIds : parseMaybeArray(rawIds);
  const outcomes = Array.isArray(rawOutcomes) ? rawOutcomes : parseMaybeArray(rawOutcomes);

  if (tokenIds.length !== outcomes.length || !tokenIds.length) {
    throw new Error(`Could not parse token ids/outcomes for slug: ${slug}`);
  }

  const question = data.question || data.title || slug;
  return tokenIds.map((assetId, i) => ({
    assetId: String(assetId),
    outcome: String(outcomes[i]),
    slug,
    question,
  }));
}

const sessions = new Map();

function createSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function closeUpstream(session) {
  try {
    if (session.upstream) session.upstream.close();
  } catch {}
  session.upstream = null;
}

function broadcast(session, payload) {
  const msg = JSON.stringify(payload);
  for (const ws of session.subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function startUpstream(session) {
  closeUpstream(session);
  if (!session.assetIds.length) return;

  const upstream = new WebSocket(POLYMARKET_WS);
  session.upstream = upstream;

  upstream.on("open", () => {
    upstream.send(JSON.stringify({
      assets_ids: session.assetIds,
      type: "market",
      custom_feature_enabled: true,
    }));
  });

  upstream.on("message", (buf) => {
    let payload;
    try {
      payload = JSON.parse(buf.toString());
    } catch {
      return;
    }
    broadcast(session, { type: "market_event", payload });
  });

  upstream.on("error", (err) => {
    broadcast(session, { type: "server_warning", message: `Upstream error: ${err.message}` });
  });

  upstream.on("close", () => {
    if (!sessions.has(session.sessionId)) return;
    setTimeout(() => {
      const current = sessions.get(session.sessionId);
      if (current) startUpstream(current);
    }, 2500);
  });
}

app.post("/api/start-session", async (req, res) => {
  try {
    const slugs = Array.isArray(req.body?.slugs)
      ? req.body.slugs.map(String).map((s) => s.trim()).filter(Boolean)
      : [];

    if (!slugs.length) {
      return res.status(400).json({ error: "Provide at least one Polymarket slug." });
    }

    const deduped = [...new Set(slugs)];
    const tokenLists = await Promise.all(deduped.map(tokensForSlug));
    const tokens = tokenLists.flat();
    const assetIds = tokens.map((t) => t.assetId);
    const sessionId = createSessionId();

    const session = {
      sessionId,
      slugs: deduped,
      tokens,
      assetIds,
      subscribers: new Set(),
      upstream: null,
    };

    sessions.set(sessionId, session);
    startUpstream(session);
    res.json({ sessionId, tokens });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to start session" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/browser-ws" });

wss.on("connection", (ws) => {
  let attachedSessionId = null;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.type === "attach_session") {
      const sessionId = String(msg.sessionId || "");
      const session = sessions.get(sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: "server_error", message: "Session not found." }));
        return;
      }

      if (attachedSessionId && sessions.has(attachedSessionId)) {
        sessions.get(attachedSessionId).subscribers.delete(ws);
      }

      attachedSessionId = sessionId;
      session.subscribers.add(ws);
    }
  });

  ws.on("close", () => {
    if (attachedSessionId && sessions.has(attachedSessionId)) {
      const session = sessions.get(attachedSessionId);
      session.subscribers.delete(ws);
      setTimeout(() => {
        const current = sessions.get(attachedSessionId);
        if (current && current.subscribers.size === 0) {
          closeUpstream(current);
          sessions.delete(attachedSessionId);
        }
      }, 30000);
    }
  });
});
app.post("/api/send-alert", async (req, res) => {
  try {
console.log("send-alert hit", req.body);
    const { question, outcome, deltaPp, fromPrice, toPrice } = req.body;

    const msg =
      `🚨 Polymarket Alert\n` +
      `${question}\n` +
      `${outcome}\n` +
      `Move: ${deltaPp.toFixed(2)} pp\n` +
      `From: ${(fromPrice * 100).toFixed(2)}%\n` +
      `To: ${(toPrice * 100).toFixed(2)}%`;

    await sendTelegramMessage(msg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "failed" });
  }
});

server.listen(PORT, () => {
  console.log(`Polymarket dashboard running at http://localhost:${PORT}`);
});
