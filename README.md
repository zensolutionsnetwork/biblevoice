# BibleVoice — God AI

A free, no-friction portal to the Holy Bible: a warm, Scripture-grounded **AI chat + voice agent** you can talk or type to. Ask anything, hear it read aloud, and draw near to God. Live at **biblevoice.net**.

> Part of the **God AI** project. See `../God-AI_Strategy.md` and `../Canon-Manifest.md`.

## Stack
- **Node + TypeScript + Express** (mirrors the Zen AI stack)
- **Anthropic Messages API** for the chat/voice agent (dedicated pay-as-you-go key; Haiku by default to stay cheap for a free public app)
- **Web Speech API** for in-browser voice (speak + listen); HelloAO audio Bible per chapter
- Deploys on **Railway** (`railway.json`), DNS → biblevoice.net

## Scripture data
Tier 1a (this build): the full **66-book protocanon**, Berean Standard Bible (Public Domain), assembled from the [HelloAO Free Use Bible API](https://bible.helloao.org) — 31,086 verses, all chapters with audio. Tier 1b/Tier 3 (deuterocanon, Enoch, Jubilees, Meqabyan, …) are sourced separately per `Canon-Manifest.md`.

Re-assemble anytime: `npm run assemble`.

## Run locally
```bash
npm install
npm run assemble        # downloads + normalizes Scripture into data/ (already committed)
cp .env.example .env    # add ANTHROPIC_API_KEY for the live AI (optional; works without)
npm run dev             # http://localhost:3000
```
Without an API key the site still runs and returns relevant verses (demo mode); the live AI companion turns on when `ANTHROPIC_API_KEY` is set.

## API
- `GET /api/health`
- `GET /api/canon` — book index
- `GET /api/bible/:book/:chapter` — e.g. `/api/bible/JHN/3` (verses + audio links)
- `GET /api/search?q=forgiveness`
- `GET /api/vod` — verse of the day
- `POST /api/chat` — `{ messages: [{role,content}] }`

## Guardrails
Scripture-grounded and cited; points to Jesus and never poses as the Holy Spirit; gracious across traditions; gentle with anyone in crisis; honest that it's an AI tool. See `src/chat.ts`.
