# Deploying BibleVoice → Railway → biblevoice.net

The app is complete and tested locally. These are the only steps that need your logged-in
accounts (my sandbox has no stored GitHub/Railway credentials, so I can't run them blind).
I can **drive each one in your browser with you**, or you can do them in a few minutes.

## 1. Put the code on GitHub
The mounted folder can't host a git repo, but I built a clean committed repo and a zip
(`biblevoice.zip`). Two options:

**A — push from your machine (fastest):** unzip `biblevoice.zip`, then:
```bash
cd biblevoice
git init && git add -A && git commit -m "Initial BibleVoice"
git branch -M main
git remote add origin https://github.com/<you>/biblevoice.git   # create the empty repo first
git push -u origin main
```

**B — let me drive your browser:** I create the GitHub repo, generate a short-lived token,
and push for you. (Touches a secret, so we do it together.)

## 2. Deploy on Railway
1. Railway → **New Project → Deploy from GitHub repo → biblevoice**.
2. Railway auto-detects Node and uses `railway.json` (`npm ci && npm run build`, then `npm start`).
3. **Variables** to add:
   - `ANTHROPIC_API_KEY` = your dedicated pay-as-you-go key (create with a low spend cap)
   - `ANTHROPIC_MODEL` = `claude-haiku-4-5-20251001`
   - `PORT` is provided by Railway automatically.
4. Deploy → confirm the build succeeds and the service is live on the `*.up.railway.app` URL.

## 3. Point biblevoice.net at it
1. Railway → service → **Settings → Networking → Custom Domain → add `biblevoice.net`**
   (and `www.biblevoice.net`). Railway shows a **CNAME target** (e.g. `xxxx.up.railway.app`).
2. At your **domain registrar** (where you bought biblevoice.net) → DNS settings:
   - `www` → CNAME → the Railway target.
   - root `@` → use the registrar's ANAME/ALIAS/"CNAME flattening" to the Railway target,
     or a redirect from `@` to `www`. (Exact control depends on the registrar — tell me which
     one and I'll give the precise records / drive it.)
3. Wait for DNS + Railway's automatic TLS certificate (usually minutes to an hour).

## Notes
- Scripture data (`data/`) is committed, so the deploy is self-contained — no build-time fetch.
- Without `ANTHROPIC_API_KEY` the site still runs in demo mode (returns relevant verses).
- To refresh/extend Scripture later: `npm run assemble` (and add Tier 1b/Tier 3 books per `../Canon-Manifest.md`).
