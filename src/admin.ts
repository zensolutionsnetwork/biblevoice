/**
 * Super-admin panel auth + living backlog API.
 *
 * Model (council-wide convention, mirrors zen-ai.net/admin):
 * - GET  /api/admin/backlog  → public (the backlog already lives in the public GitHub repo).
 * - POST /api/admin/backlog  → requires an admin session.
 * - POST /api/admin/login    → exchanges a Google Sign-In ID token (GIS credential) for a
 *   short-lived HMAC session token. Only ADMIN_EMAIL may log in.
 *
 * Identity = Mathieu's business Google account (no static token to remember).
 * Google ID tokens are verified server-side against Google's tokeninfo endpoint:
 * audience must match GOOGLE_CLIENT_ID, email must be verified and equal ADMIN_EMAIL.
 *
 * Sessions are stateless HMAC tokens (email|exp|sig). The signing secret is
 * ADMIN_SESSION_SECRET if set, otherwise random per boot (a redeploy just means
 * logging in again — acceptable for a one-admin panel).
 */
import crypto from "node:crypto";

// Owner identity comes from env ONLY — never hardcode emails in this public repo.
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

export function makeSessionToken(email: string): string {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${email}|${exp}`;
  return Buffer.from(`${payload}|${sign(payload)}`).toString("base64url");
}

export function verifySessionToken(token: string): string | null {
  try {
    const [email, expStr, sig] = Buffer.from(token, "base64url").toString().split("|");
    if (!email || !expStr || !sig) return null;
    const payload = `${email}|${expStr}`;
    const expect = sign(payload);
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() > Number(expStr)) return null;
    if (email.toLowerCase() !== ADMIN_EMAIL) return null;
    return email;
  } catch { return null; }
}

/** Verify a Google Sign-In ID token; return the admin email or null. */
export async function verifyGoogleCredential(credential: string): Promise<string | null> {
  if (!GOOGLE_CLIENT_ID) { console.warn("[admin] GOOGLE_CLIENT_ID not set — login disabled"); return null; }
  if (!ADMIN_EMAIL) { console.warn("[admin] ADMIN_EMAIL not set — login disabled (set it in env)"); return null; }
  try {
    const res = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
    if (!res.ok) return null;
    const j: any = await res.json();
    if (j.aud !== GOOGLE_CLIENT_ID) return null;
    if (j.email_verified !== "true" && j.email_verified !== true) return null;
    const email = String(j.email || "").toLowerCase();
    if (email !== ADMIN_EMAIL) { console.warn("[admin] login refused for", email); return null; }
    return email;
  } catch (e: any) { console.warn("[admin] google verify failed:", e?.message || e); return null; }
}

/**
 * Express middleware: require a valid admin session (Authorization: Bearer <token>).
 * Two accepted bearer forms:
 * - a Google-login HMAC session token (the human admin in the /admin panel);
 * - the machine token ADMIN_API_TOKEN (local sessions syncing the living backlog
 *   from rituals — same pattern as the council hub's admin token).
 */
export function adminAuth(req: any, res: any, next: any) {
  // Fail CLOSED when misconfigured (council pattern, stolen from Nova): if neither
  // owner-auth mechanism is configured, this is a 503 — never a silent allow.
  if (!process.env.ADMIN_API_TOKEN && !GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "owner_auth_unconfigured" });
  }
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ error: "unauthorized" });
  const machine = process.env.ADMIN_API_TOKEN || "";
  if (machine && token.length === machine.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(machine))) {
    req.adminEmail = "session:logos";
    return next();
  }
  const email = verifySessionToken(token);
  if (!email) return res.status(401).json({ error: "unauthorized" });
  req.adminEmail = email;
  next();
}
