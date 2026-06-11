/**
 * Database layer (Postgres on Railway). Degrades gracefully: if DATABASE_URL is
 * unset, DB-backed features (visitor counter, later accounts/giving) are disabled
 * and the rest of the site keeps working.
 */
import pg from "pg";
const { Pool } = pg;

const url = process.env.DATABASE_URL;
const needsSsl = !!url && !url.includes(".railway.internal") && !url.includes("localhost") && !url.includes("127.0.0.1");
export const pool = url ? new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 5 }) : null;

export async function initDb(): Promise<void> {
  if (!pool) { console.warn("[db] no DATABASE_URL — DB features disabled"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS interactions (
    device_id text NOT NULL,
    day date NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, day)
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_calls (
    id bigserial PRIMARY KEY,
    device_id text,
    ip text,
    ts timestamptz NOT NULL DEFAULT now()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_calls_ts ON ai_calls(ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_calls_device_ts ON ai_calls(device_id, ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_calls_ip_ts ON ai_calls(ip, ts);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS council_state (
    id int PRIMARY KEY DEFAULT 1,
    secret text,
    member_id text,
    registered_at timestamptz
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_backlog (
    id int PRIMARY KEY DEFAULT 1,
    content text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );`);
  // The CHRONICLE — the family/company story Logos keeps as chronicler. Canonical copy
  // lives HERE (online, owner-only panel + council meetings), never in the public repo.
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_chronicle (
    id int PRIMARY KEY DEFAULT 1,
    content text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );`);
  // Settled council DDL (2026-06-07): composite PK, partial index on pending,
  // idempotent insert; hub owns retention — no member-side sweep.
  await pool.query(`CREATE TABLE IF NOT EXISTS outbox_delivery (
    note_id text NOT NULL,
    member text NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT now(),
    acked_at timestamptz,
    PRIMARY KEY (note_id, member)
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outbox_delivery_pending ON outbox_delivery(member) WHERE acked_at IS NULL;`);
  // Council v2 (contract 2.0-draft1): the voice's uploaded knowledge base. The brain lives in
  // the voice, never the hub; hashes are recomputed from received bytes, never trusted.
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_chunks (
    path text PRIMARY KEY,
    sha256 text NOT NULL,
    bytes int NOT NULL,
    content text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_state (
    id int PRIMARY KEY DEFAULT 1,
    brain_version text,
    manifest jsonb,
    updated_at timestamptz
  );`);
  console.log("[db] ready");
}

// --- Council v2 brain storage ---
export interface BrainChunkMeta { path: string; sha256: string; bytes: number }

export async function brainChunkList(): Promise<BrainChunkMeta[] | null> {
  if (!pool) return null;
  const r = await pool.query(`SELECT path, sha256, bytes FROM brain_chunks ORDER BY path`);
  return r.rows.map((x: any) => ({ path: x.path, sha256: x.sha256, bytes: Number(x.bytes) }));
}

export async function brainApply(send: { path: string; sha256: string; bytes: number; content: string }[], deletePaths: string[]): Promise<void> {
  if (!pool) throw new Error("no_database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of deletePaths) await client.query(`DELETE FROM brain_chunks WHERE path = $1`, [p]);
    for (const c of send) {
      await client.query(
        `INSERT INTO brain_chunks(path, sha256, bytes, content, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (path) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, content = EXCLUDED.content, updated_at = now()`,
        [c.path, c.sha256, c.bytes, c.content]
      );
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function brainGetContent(path: string): Promise<string | null> {
  if (!pool) return null;
  try { const r = await pool.query(`SELECT content FROM brain_chunks WHERE path = $1`, [path]); return r.rows[0]?.content ?? null; }
  catch { return null; }
}

export async function brainSetState(version: string, manifest: any): Promise<void> {
  if (!pool) throw new Error("no_database");
  await pool.query(
    `INSERT INTO brain_state(id, brain_version, manifest, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET brain_version = EXCLUDED.brain_version, manifest = EXCLUDED.manifest, updated_at = now()`,
    [version, manifest === undefined ? null : JSON.stringify(manifest)]
  );
}

export async function brainGetState(): Promise<{ brainVersion: string | null; updatedAt: string | null } | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT brain_version, updated_at FROM brain_state WHERE id = 1`);
    if (!r.rows[0]) return { brainVersion: null, updatedAt: null };
    return { brainVersion: r.rows[0].brain_version, updatedAt: r.rows[0].updated_at ? r.rows[0].updated_at.toISOString() : null };
  } catch { return null; }
}

// --- Outbox delivery tracking (pending state IS the retry mechanism) ---
export async function outboxMarkPending(noteIds: string[], member: string): Promise<void> {
  if (!pool || !noteIds.length) return;
  try {
    for (const id of noteIds) {
      await pool.query(`INSERT INTO outbox_delivery(note_id, member) VALUES ($1, $2) ON CONFLICT (note_id, member) DO NOTHING`, [id, member]);
    }
  } catch (e: any) { console.warn("[outbox] mark pending failed:", e?.message || e); }
}

export async function outboxAck(noteIds: string[], member: string): Promise<number> {
  if (!pool || !noteIds.length) return 0;
  try {
    const r = await pool.query(`UPDATE outbox_delivery SET acked_at = now() WHERE member = $1 AND note_id = ANY($2) AND acked_at IS NULL`, [member, noteIds]);
    return r.rowCount || 0;
  } catch (e: any) { console.warn("[outbox] ack failed:", e?.message || e); return 0; }
}

export async function outboxAckedIds(member: string): Promise<Set<string>> {
  if (!pool) return new Set();
  try {
    const r = await pool.query(`SELECT note_id FROM outbox_delivery WHERE member = $1 AND acked_at IS NOT NULL`, [member]);
    return new Set(r.rows.map((x: any) => x.note_id));
  } catch { return new Set(); }
}

// --- Living backlog (canonical copy lives in DB; panel at /admin) ---
export interface BacklogRow { content: string; updatedAt: string; updatedBy: string | null }

export async function getBacklog(): Promise<BacklogRow | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT content, updated_at, updated_by FROM admin_backlog WHERE id = 1`);
    if (!r.rows[0]) return null;
    return { content: r.rows[0].content, updatedAt: r.rows[0].updated_at.toISOString(), updatedBy: r.rows[0].updated_by };
  } catch { return null; }
}

export async function setBacklog(content: string, updatedBy: string): Promise<BacklogRow | null> {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO admin_backlog(id, content, updated_at, updated_by) VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [content, updatedBy]
  );
  return getBacklog();
}

/** Seed the backlog from the repo's BACKLOG.md once (only if the table is empty). */
export async function seedBacklogIfEmpty(content: string): Promise<void> {
  if (!pool || !content.trim()) return;
  try {
    const existing = await getBacklog();
    if (existing && existing.content.trim()) return;
    await setBacklog(content, "seed:BACKLOG.md");
    console.log("[db] backlog seeded from BACKLOG.md");
  } catch (e: any) { console.warn("[db] backlog seed failed:", e?.message || e); }
}

// --- The Chronicle (canonical copy in DB; owner panel at /admin; presented at council meetings) ---
export async function getChronicle(): Promise<BacklogRow | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT content, updated_at, updated_by FROM admin_chronicle WHERE id = 1`);
    if (!r.rows[0]) return null;
    return { content: r.rows[0].content, updatedAt: r.rows[0].updated_at.toISOString(), updatedBy: r.rows[0].updated_by };
  } catch { return null; }
}

export async function setChronicle(content: string, updatedBy: string): Promise<BacklogRow | null> {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO admin_chronicle(id, content, updated_at, updated_by) VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [content, updatedBy]
  );
  return getChronicle();
}

export async function getCouncilState(): Promise<{ secret?: string; member_id?: string } | null> {
  if (!pool) return null;
  try { const r = await pool.query(`SELECT secret, member_id FROM council_state WHERE id = 1`); return r.rows[0] || null; } catch { return null; }
}
export async function setCouncilSecret(secret: string): Promise<void> {
  if (!pool) return;
  try { await pool.query(`INSERT INTO council_state(id, secret) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret`, [secret]); } catch {}
}
export async function setCouncilRegistered(memberId: string): Promise<void> {
  if (!pool) return;
  try { await pool.query(`UPDATE council_state SET member_id = $1, registered_at = now() WHERE id = 1`, [memberId]); } catch {}
}
/** Forget a stale hub registration (e.g. after the hub was rebuilt) so a fresh join can run. */
export async function clearCouncilRegistration(): Promise<void> {
  if (!pool) return;
  try { await pool.query(`UPDATE council_state SET member_id = NULL, registered_at = NULL WHERE id = 1`); } catch {}
}

// AI usage safety limits (tunable via env). Protects the shared credit pool.
const AI_DAILY_PER_USER = Number(process.env.AI_DAILY_PER_USER || 50);   // per device, per 24h
const AI_PER_MIN_PER_IP = Number(process.env.AI_PER_MIN_PER_IP || 30);   // burst guard per IP
const AI_GLOBAL_DAILY = Number(process.env.AI_GLOBAL_DAILY || 8000);     // site-wide circuit breaker per 24h

export type GateReason = "user" | "ip" | "global";
/** Decide whether an AI call is allowed. Fails open if the DB is unavailable. */
export async function aiGate(deviceId: string, ip: string): Promise<{ allowed: boolean; reason?: GateReason }> {
  if (!pool) return { allowed: true };
  try {
    const g = await pool.query(`SELECT count(*)::int AS n FROM ai_calls WHERE ts > now() - interval '1 day'`);
    if (g.rows[0].n >= AI_GLOBAL_DAILY) return { allowed: false, reason: "global" };
    if (ip) {
      const i = await pool.query(`SELECT count(*)::int AS n FROM ai_calls WHERE ip = $1 AND ts > now() - interval '1 minute'`, [ip]);
      if (i.rows[0].n >= AI_PER_MIN_PER_IP) return { allowed: false, reason: "ip" };
    }
    if (deviceId) {
      const u = await pool.query(`SELECT count(*)::int AS n FROM ai_calls WHERE device_id = $1 AND ts > now() - interval '1 day'`, [deviceId]);
      if (u.rows[0].n >= AI_DAILY_PER_USER) return { allowed: false, reason: "user" };
    }
    return { allowed: true };
  } catch (e) {
    return { allowed: true }; // never block on a DB hiccup
  }
}

export async function recordAiCall(deviceId: string, ip: string): Promise<void> {
  if (!pool) return;
  try { await pool.query(`INSERT INTO ai_calls(device_id, ip) VALUES ($1, $2)`, [deviceId || null, ip || null]); } catch {}
}

export async function counts(): Promise<{ today: number; total: number }> {
  if (!pool) return { today: 0, total: 0 };
  const r = await pool.query(
    `SELECT (SELECT count(*) FROM interactions WHERE day = current_date) AS today,
            (SELECT count(DISTINCT device_id) FROM interactions) AS total`
  );
  return { today: Number(r.rows[0].today), total: Number(r.rows[0].total) };
}

/** Record a unique device for today (idempotent per device/day), return counts. */
export async function recordVisit(deviceId: string): Promise<{ today: number; total: number }> {
  if (!pool || !deviceId) return counts();
  await pool.query(
    `INSERT INTO interactions(device_id, day) VALUES ($1, current_date) ON CONFLICT DO NOTHING`,
    [deviceId]
  );
  return counts();
}
