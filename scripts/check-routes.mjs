/**
 * Default-deny route regression test (council code-review decision 2026-06-06).
 * Statically parses src/server.ts: every route NOT in the public allowlist must
 * carry an auth middleware (bridgeAuth or adminAuth). Run alongside `tsc --noEmit`
 * before every deploy: `node scripts/check-routes.mjs`. Exit 1 = violation.
 *
 * Also asserts the model-tier pins: the public bot resolver must stay on haiku
 * (src/chat.ts), and the council resolver must remain a separate constant.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = readFileSync(resolve(root, "src/server.ts"), "utf8");
const chatSrc = readFileSync(resolve(root, "src/chat.ts"), "utf8");
const councilSrc = readFileSync(resolve(root, "src/council.ts"), "utf8");

// The ONLY surfaces allowed without auth (the public website + its data + login plumbing).
const PUBLIC_ALLOWLIST = new Set([
  "/read",
  "/privacy",
  "/admin", // login page only — the data behind it requires auth
  "/api/health",
  "/api/canon",
  "/api/vod",
  "/api/random",
  "/api/bible/:book/:chapter",
  "/api/search",
  "/api/chat",
  "/api/visit",
  "/api/admin/config", // public by design: only the GIS client id (needed to render the sign-in button)
  "/api/admin/login",  // exchanges a Google credential for a session; rate-limited
]);

const failures = [];
const routeRe = /app\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,([^\n]*)/g;
let m;
let checked = 0;
while ((m = routeRe.exec(serverSrc)) !== null) {
  const [, method, path, rest] = m;
  checked++;
  const hasAuth = /bridgeAuth|adminAuth/.test(rest);
  if (!PUBLIC_ALLOWLIST.has(path) && !hasAuth) {
    failures.push(`${method.toUpperCase()} ${path} has NO auth middleware and is not in the public allowlist`);
  }
  if (PUBLIC_ALLOWLIST.has(path) && hasAuth && path !== "/admin") {
    // Not a failure, but worth knowing if a public route silently became private.
    console.log(`note: public-allowlisted route ${path} now carries auth — update the allowlist if intentional`);
  }
}
if (checked < 10) failures.push(`route scan only found ${checked} routes — parser may be broken, refusing to pass`);

// Model-tier pins (canary must not share the path it monitors).
if (!/const MODEL = process\.env\.ANTHROPIC_MODEL \|\| "claude-haiku/.test(chatSrc)) {
  failures.push("public bot resolver in src/chat.ts no longer pins haiku as its default — review required");
}
if (!/PUBLIC_MODEL_TIER/.test(chatSrc)) failures.push("PUBLIC_MODEL_TIER missing from src/chat.ts");
if (!/COUNCIL_MODEL/.test(councilSrc)) failures.push("council resolver (COUNCIL_MODEL) missing from src/council.ts");
if (/PUBLIC_MODEL_TIER/.test(councilSrc)) failures.push("council code references PUBLIC_MODEL_TIER — resolvers must stay separate");

// Public responses must not leak model names (the internal API call `model: MODEL` is fine;
// only RETURNED objects matter).
if (/return\s*\{[^}]*model:\s*MODEL/.test(chatSrc)) failures.push("src/chat.ts returns the model name on the public surface");

if (failures.length) {
  console.error("ROUTE_CHECK: FAILED");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`ROUTE_CHECK: clean (${checked} routes verified, model pins intact)`);
