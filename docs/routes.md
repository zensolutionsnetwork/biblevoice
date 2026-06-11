# Routes — canonical pinned list (council pattern, ratified 2026-06-11)

Rule (Arke's discipline, Kairos's ratification, adopted by Logos): **never probe a path you
haven't confirmed from this list.** Kept in lockstep with `src/server.ts`;
`scripts/check-routes.mjs` enforces default-deny (every route not in the public allowlist must
carry `adminAuth` or `bridgeAuth`).

## Public website (no auth — the only public surface)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` (static) | Home — Word-first landing, opt-in AI guide |
| GET | `/read` | Full-Bible reader (82 books, EN/FR/ES) |
| GET | `/privacy` | Privacy page |
| GET | `/admin` | Login page only — nothing visible before owner sign-in; all data behind authed APIs |
| GET | `/api/health` | Health probe |
| GET | `/api/canon` | Book index (per lang) |
| GET | `/api/vod` | Verse of the day |
| GET | `/api/random` | Random chapter |
| GET | `/api/bible/:book/:chapter` | Chapter text (404 on unknown — never silent) |
| GET | `/api/search` | Scripture search (q≤200, limit≤50) |
| POST | `/api/chat` | Scripture-grounded AI guide (rate-capped, guardrails inviolable) |
| POST | `/api/visit` | Unique device/day counter |
| GET | `/api/admin/config` | GIS client id only (renders the sign-in button) |
| POST | `/api/admin/login` | Google credential → owner session (rate-limited) |

## Council bridge (x-bridge-secret, timing-safe)

| Method | Path |
|---|---|
| GET | `/api/bridge/ping` |
| POST | `/api/bridge/ask` |
| GET | `/api/bridge/brain` |
| GET | `/api/bridge/chronicle` |
| POST | `/api/bridge/review` |
| POST | `/api/bridge/outbox/read` · `/api/bridge/outbox/ack` |
| GET | `/api/bridge/brain-chunks` · `/api/bridge/brain-version` |
| POST | `/api/bridge/brain-upload` · `/api/bridge/brain-commit` |

## Owner-gated (adminAuth: owner Google session or machine token)

| Method | Path |
|---|---|
| GET/POST | `/api/admin/backlog` |
| GET/POST | `/api/admin/chronicle` |
| POST | `/api/admin/env-report` |
| GET | `/api/admin/env-tasks` (hub inbox relay — secret stays server-side) |
| POST | `/api/admin/council-rejoin` |
| GET | `/api/admin/bridge-secret` (owner door; accesses logged) |
| GET | `/api/council/security-selfcheck` |
| GET | `/api/council/boot-log` (boot-stamp history; cycle = restart outside a deploy) |

---

*Transcript hash verification: the council-jcs-1.0 spec lives in the hub repo
(`architect-council/docs/CANONICALIZATION.md`). Hash = sha256 over the canonical
serialization of `projection` from `GET /api/meeting/:id/transcript` — verified
2026-06-11 on both meetings. Not mirrored here: the doc's golden-vector hash trips
our secret-scan gate, and `docs/` is rightly outside the fixture-exemption path
contract (`^(test/|fixtures/)`). The gate wins.*
