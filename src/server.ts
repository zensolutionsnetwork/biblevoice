/** BibleVoice (God AI) — HTTP server. Static landing page + JSON API. */
import crypto from "node:crypto";
import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIndex, getChapter, search, verseOfTheDay, pickLang } from "./canon.js";
import { chat, type ChatMessage } from "./chat.js";
import { readFileSync } from "node:fs";
import { initDb, recordVisit, aiGate, recordAiCall, getBacklog, setBacklog, seedBacklogIfEmpty, getChronicle, setChronicle, outboxMarkPending, outboxAck, outboxAckedIds, brainChunkList, brainApply, brainSetState, brainGetState } from "./db.js";
import { ensureCouncil, bridgeSecret, architectReply, reviewProposal, brainSnapshot, DISPLAY_NAME, REVIEW_CAPABILITIES, COUNCIL_MODEL_TIER, outboxWithIds, computeBrainVersion, sha256Hex, V2_CONTRACT_VERSION } from "./council.js";
import { adminAuth, verifyGoogleCredential, makeSessionToken, GOOGLE_CLIENT_ID } from "./admin.js";
import { PUBLIC_MODEL_TIER } from "./chat.js";

/** Deterministic JSON serialization (sorted keys) so idempotency hashes are stable (council decision). */
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"] === "http") return res.redirect(301, "https://" + req.headers.host + req.originalUrl);
  // Security headers (owner's rule: only the public website is public; everything else locked down hard).
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: https://accounts.google.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; media-src 'self' https://audio.bible.helloao.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});
// Council v2 brain uploads carry file batches (client maxBatchBytes ~1.5MB) — bigger limit on
// that one bridge route only; everything else keeps the tight public cap.
app.use("/api/bridge/brain-upload", express.json({ limit: "6mb" }));
app.use(express.json({ limit: "1mb" }));

// Simple in-memory per-IP rate limiter for the admin auth surface (brute-force guard).
const rlMap = new Map<string, { n: number; reset: number }>();
function rateLimit(maxPerMin: number) {
  return (req: any, res: any, next: any) => {
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "").trim() || "unknown";
    const now = Date.now();
    const e = rlMap.get(ip);
    if (!e || now > e.reset) { rlMap.set(ip, { n: 1, reset: now + 60_000 }); return next(); }
    if (++e.n > maxPerMin) return res.status(429).json({ error: "rate_limited" });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rlMap) if (now > v.reset) rlMap.delete(k); }, 300_000).unref();
app.use(express.static(resolve(__dirname, "../public")));

app.get("/read", (_req, res) => res.sendFile(resolve(__dirname, "../public/read.html")));
app.get("/privacy", (_req, res) => res.sendFile(resolve(__dirname, "../public/privacy.html")));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "biblevoice", uptime: Math.floor(process.uptime()), time: new Date().toISOString() }));
app.get("/api/canon", (req, res) => res.json(getIndex(pickLang(String(req.query.lang || "")))));
app.get("/api/vod", (req, res) => res.json({ verse: verseOfTheDay(new Date(), pickLang(String(req.query.lang || ""))) }));
app.get("/api/random", (req, res) => {
  const books = getIndex(pickLang(String(req.query.lang || ""))).books;
  const b = books[Math.floor(Math.random() * books.length)];
  const chapter = 1 + Math.floor(Math.random() * b.numberOfChapters);
  res.json({ bookId: b.id, book: b.name, chapter });
});

app.get("/api/bible/:book/:chapter", (req, res) => {
  const c = getChapter(req.params.book, Number(req.params.chapter), pickLang(String(req.query.lang || "")));
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").slice(0, 200); // cap query length (abuse guard)
  if (!q) return res.status(400).json({ error: "Missing q" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50); // cap result size
  res.json({ query: q, results: search(q, limit, pickLang(String(req.query.lang || ""))) });
});

app.post("/api/chat", async (req, res) => {
  try {
    const messages = (req.body?.messages || []) as ChatMessage[];
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "messages[] required" });
    // Input-length cap: trim any over-long message to protect tokens/cost.
    for (const m of messages) if (typeof m.content === "string" && m.content.length > 4000) m.content = m.content.slice(0, 4000);

    const deviceId = String(req.body?.deviceId || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 64);
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "").trim();

    const gate = await aiGate(deviceId, ip);
    if (!gate.allowed) {
      const reply =
        gate.reason === "ip"
          ? "Peace — you're sending messages very quickly. Please pause for a moment, then try again. This keeps the guide available for everyone."
          : gate.reason === "global"
          ? "The AI guide has reached today's shared limit, so this gift stays free for everyone around the world. You can still read the whole Bible freely here, and the guide returns soon. 🕊️"
          : "You've reached today's limit with the AI guide, so the gift stays available to everyone who seeks. You can keep reading the Bible freely, and the guide will be here again tomorrow. “Be still, and know that I am God.” (Psalm 46:10)";
      return res.json({ reply, verses: [], grounded: false, model: null, goto: null });
    }

    await recordAiCall(deviceId, ip); // count before the call so concurrent floods are limited
    const out = await chat(messages.slice(-12), pickLang(String(req.body?.lang || "")));
    res.json(out);
  } catch (e: any) {
    // Generic error on the public surface — never leak model names or upstream details (council decision).
    console.error("[chat]", e?.message || e);
    res.status(503).json({ error: "upstream_unavailable" });
  }
});

app.post("/api/visit", async (req, res) => {
  try {
    const id = String(req.body?.deviceId || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 64);
    res.json(await recordVisit(id));
  } catch (e: any) {
    console.error("[visit]", e?.message || e);
    res.json({ today: 0, total: 0 });
  }
});

// --- Architects Council bridge (inert until activated via env) ---
function bridgeAuth(req: any, res: any, next: any) {
  const s = bridgeSecret();
  const given = String(req.headers["x-bridge-secret"] || "");
  // Timing-safe comparison: no secret, wrong length, or mismatch all return the same 401.
  if (!s || given.length !== s.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(s))) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
app.get("/api/bridge/ping", bridgeAuth, (_req, res) => res.json({ ok: true, project: "biblevoice", displayName: DISPLAY_NAME, contractVersion: "1.2", capabilities: REVIEW_CAPABILITIES }));
app.post("/api/bridge/ask", bridgeAuth, async (req, res) => {
  try { const { from, message, history } = req.body || {}; res.json(await architectReply(String(from || "hub"), String(message || ""), Array.isArray(history) ? history : [])); }
  catch (e: any) { console.error("[bridge/ask]", e?.message || e); res.status(500).json({ error: "ask_failed" }); }
});
app.get("/api/bridge/brain", bridgeAuth, (_req, res) => res.json({ project: "biblevoice", brain: brainSnapshot(), updatedAt: new Date().toISOString() }));
// CHRONICLER ritual: the full family chronicle, readable by council members (member-secret auth)
// so the whole story can be displayed to everyone at each meeting.
app.get("/api/bridge/chronicle", bridgeAuth, async (_req, res) => {
  const row = await getChronicle();
  if (!row) return res.status(503).json({ error: "no_database" });
  res.json({ project: "biblevoice", chronicle: row.content, updatedAt: row.updatedAt });
});
app.post("/api/bridge/review", bridgeAuth, async (req, res) => {
  // Contract v1.2: accepts full AskPayload { from, proposal: string|object, history[] };
  // legacy { title, summary, details } bodies are normalized into a proposal string.
  try {
    const b = req.body || {};
    const proposal = b.proposal !== undefined
      ? (typeof b.proposal === "string" ? b.proposal : stableStringify(b.proposal)) // sorted keys → stable idempotency hashes
      : [b.title && `Title: ${b.title}`, b.summary && `Summary: ${b.summary}`, b.details && `Details: ${b.details}`].filter(Boolean).join("\n");
    const history = Array.isArray(b.history) ? b.history : [];
    res.json(await reviewProposal(String(b.from || "hub"), String(proposal || ""), history));
  } catch (e: any) { console.error("[bridge/review]", e?.message || e); res.status(500).json({ error: "review_failed" }); }
});

// Outbox read/ack (council delivery model: attempt once, pending state IS the retry —
// unacked notes are simply re-delivered on the next read; no inline retry loops).
app.post("/api/bridge/outbox/read", bridgeAuth, async (req, res) => {
  try {
    const member = String(req.body?.member || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64);
    if (!member) return res.status(400).json({ error: "member_required" });
    const all = outboxWithIds();
    const acked = await outboxAckedIds(member);
    const pending = all.filter((n) => !acked.has(n.id));
    await outboxMarkPending(pending.map((n) => n.id), member);
    res.json({ notes: pending, count: pending.length });
  } catch (e: any) { console.error("[bridge/outbox/read]", e?.message || e); res.status(500).json({ error: "outbox_read_failed" }); }
});
app.post("/api/bridge/outbox/ack", bridgeAuth, async (req, res) => {
  try {
    const member = String(req.body?.member || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64);
    const ids = Array.isArray(req.body?.note_ids) ? req.body.note_ids.map((x: any) => String(x).slice(0, 32)).slice(0, 200) : [];
    if (!member || !ids.length) return res.status(400).json({ error: "member_and_note_ids_required" });
    const acked = await outboxAck(ids, member);
    res.json({ acked });
  } catch (e: any) { console.error("[bridge/outbox/ack]", e?.message || e); res.status(500).json({ error: "outbox_ack_failed" }); }
});

// --- Council v2 brain sync (contract 2.0-draft1; member secret auth; hashes recomputed, never trusted) ---
const BRAIN_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\/\-]{0,299}$/;
function validBrainPath(p: any): boolean {
  return typeof p === "string" && BRAIN_PATH_RE.test(p) && !p.includes("..") && !p.startsWith("/");
}
app.get("/api/bridge/brain-chunks", bridgeAuth, async (_req, res) => {
  try {
    const list = await brainChunkList();
    if (!list) return res.status(503).json({ error: "no_database" });
    res.json({ chunks: list.map(({ path, sha256 }) => ({ path, sha256 })) });
  } catch (e: any) { console.error("[brain-chunks]", e?.message || e); res.status(500).json({ error: "brain_chunks_failed" }); }
});
app.post("/api/bridge/brain-upload", bridgeAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const send = Array.isArray(b.send) ? b.send : [];
    const deletePaths = Array.isArray(b.deletePaths) ? b.deletePaths : [];
    if (send.length > 500 || deletePaths.length > 2000) return res.status(413).json({ error: "batch_too_large" });
    const mismatched: string[] = [];
    const apply: { path: string; sha256: string; bytes: number; content: string }[] = [];
    for (const c of send) {
      if (!validBrainPath(c?.path) || typeof c?.content !== "string" || c.content.length > 2_000_000) {
        return res.status(400).json({ error: "invalid_chunk", path: String(c?.path || "?").slice(0, 100) });
      }
      // Integrity by construction: recompute from received bytes; the sender's claim is never trusted.
      const actual = sha256Hex(c.content);
      if (c.sha256 && c.sha256 !== actual) { mismatched.push(c.path); continue; }
      apply.push({ path: c.path, sha256: actual, bytes: Buffer.byteLength(c.content, "utf8"), content: c.content });
    }
    if (mismatched.length) return res.status(400).json({ error: "sha256_mismatch", mismatched });
    for (const p of deletePaths) if (!validBrainPath(p)) return res.status(400).json({ error: "invalid_delete_path" });
    await brainApply(apply, deletePaths);
    res.json({ applied: apply.length, deleted: deletePaths.length });
  } catch (e: any) {
    if (String(e?.message).includes("no_database")) return res.status(503).json({ error: "no_database" });
    console.error("[brain-upload]", e?.message || e); res.status(500).json({ error: "brain_upload_failed" });
  }
});
app.post("/api/bridge/brain-commit", bridgeAuth, async (req, res) => {
  try {
    const list = await brainChunkList();
    if (!list) return res.status(503).json({ error: "no_database" });
    const brainVersion = computeBrainVersion(list); // recomputed over the FULL held set, independently
    const manifest = req.body?.manifest;
    if (manifest && manifest.brainVersion && manifest.brainVersion !== brainVersion) {
      // Both sides must arrive at the same hash independently; report ours so the client fails loudly.
      return res.status(409).json({ error: "brain_version_mismatch", brainVersion });
    }
    await brainSetState(brainVersion, manifest ?? null);
    res.json({ brainVersion });
  } catch (e: any) { console.error("[brain-commit]", e?.message || e); res.status(500).json({ error: "brain_commit_failed" }); }
});
app.get("/api/bridge/brain-version", bridgeAuth, async (_req, res) => {
  try {
    const list = await brainChunkList();
    if (!list) return res.status(503).json({ error: "no_database" });
    const state = await brainGetState();
    res.json({
      member: "biblevoice",
      displayName: DISPLAY_NAME,
      brainVersion: list.length ? computeBrainVersion(list) : null,
      updatedAt: state?.updatedAt ?? null,
      contractVersion: V2_CONTRACT_VERSION,
    });
  } catch (e: any) { console.error("[brain-version]", e?.message || e); res.status(500).json({ error: "brain_version_failed" }); }
});

// Owner-gated relay to the hub's environment channel: the member secret lives server-side only,
// so local sessions report readiness through this door instead of ever holding the secret.
app.post("/api/admin/env-report", rateLimit(10), adminAuth, async (req, res) => {
  try {
    const s = bridgeSecret();
    if (!s) return res.status(503).json({ error: "council_disabled" });
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const r = await fetch((process.env.COUNCIL_HUB || "https://architectscouncil.com") + "/api/env/task", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-secret": s },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text.slice(0, 2000));
  } catch (e: any) { console.error("[env-report]", e?.message || e); res.status(502).json({ error: "hub_unreachable" }); }
});

// Owner-gated READ relay for the hub environment channel (the inbox): lists tasks/messages
// addressed to this member. Same doctrine as env-report — the member secret never leaves the server.
app.get("/api/admin/env-tasks", rateLimit(30), adminAuth, async (_req, res) => {
  try {
    const s = bridgeSecret();
    if (!s) return res.status(503).json({ error: "council_disabled" });
    const r = await fetch((process.env.COUNCIL_HUB || "https://architectscouncil.com") + "/api/env/tasks?for=logos", {
      headers: { "x-bridge-secret": s },
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text.slice(0, 500000));
  } catch (e: any) { console.error("[env-tasks]", e?.message || e); res.status(502).json({ error: "hub_unreachable" }); }
});

// Owner-gated security self-check (council-locked shape; booleans/tiers only, no secrets, no model names).
app.get("/api/council/security-selfcheck", rateLimit(30), adminAuth, (_req, res) => {
  let db_public_reachable = false;
  let sslmode = "unknown";
  const dbUrl = process.env.DATABASE_URL || "";
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      db_public_reachable = !u.hostname.endsWith(".railway.internal") && !u.hostname.endsWith(".internal");
      sslmode = u.searchParams.get("sslmode") || "unknown";
    } catch { /* malformed URL — leave defaults */ }
  }
  res.json({
    db_public_reachable,
    sslmode,
    owner_auth_configured: !!(process.env.ADMIN_API_TOKEN || GOOGLE_CLIENT_ID),
    model_pinned: { public: PUBLIC_MODEL_TIER, council: COUNCIL_MODEL_TIER },
  });
});

// --- Super-admin panel (living backlog). BOTH reads and writes require auth
// --- (owner's Google Sign-In session or the machine token — see src/admin.ts). ---
app.get("/admin", (_req, res) => res.sendFile(resolve(__dirname, "../public/admin.html")));
app.get("/api/admin/config", (_req, res) => res.json({ clientId: GOOGLE_CLIENT_ID }));
app.post("/api/admin/login", rateLimit(10), async (req, res) => {
  const email = await verifyGoogleCredential(String(req.body?.credential || ""));
  if (!email) return res.status(401).json({ error: "unauthorized" });
  res.json({ token: makeSessionToken(email), email });
});
app.get("/api/admin/backlog", rateLimit(60), adminAuth, async (_req, res) => {
  const row = await getBacklog();
  if (!row) return res.json({ content: "", updatedAt: null, updatedBy: null, db: false });
  res.json(row);
});
app.post("/api/admin/backlog", rateLimit(30), adminAuth, async (req: any, res) => {
  const content = String(req.body?.content ?? "");
  if (content.length > 500_000) return res.status(413).json({ error: "too_large" });
  const row = await setBacklog(content, req.adminEmail);
  if (!row) return res.status(503).json({ error: "no_database" });
  res.json(row);
});
// --- The Chronicle (owner-only; canonical copy in DB, never in the public repo). ---
app.get("/api/admin/chronicle", rateLimit(60), adminAuth, async (_req, res) => {
  const row = await getChronicle();
  if (!row) return res.json({ content: "", updatedAt: null, updatedBy: null, db: false });
  res.json(row);
});
app.post("/api/admin/chronicle", rateLimit(30), adminAuth, async (req: any, res) => {
  const content = String(req.body?.content ?? "");
  if (content.length > 900_000) return res.status(413).json({ error: "too_large" });
  const row = await setChronicle(content, req.adminEmail);
  if (!row) return res.status(503).json({ error: "no_database" });
  res.json(row);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[biblevoice] listening on :${PORT}`);
  initDb()
    .then(() => {
      try { seedBacklogIfEmpty(readFileSync(resolve(__dirname, "../BACKLOG.md"), "utf8")); }
      catch { console.warn("[db] BACKLOG.md not found — backlog starts empty"); }
      return ensureCouncil();
    })
    .catch((e) => console.error("[db] init failed:", e?.message || e));
});
