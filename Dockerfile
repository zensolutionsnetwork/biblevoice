# BibleVoice (God AI) — Railway build. Mirrors the Zen AI pattern: tsx runtime, no compile step.
FROM node:20-slim
WORKDIR /app

# Install runtime deps only (tsx, express, @anthropic-ai/sdk).
COPY package.json ./
RUN npm install --omit=dev

# App code + Scripture data.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY BACKLOG.md ./

# Railway provides PORT at runtime; server reads process.env.PORT.
CMD ["npm", "start"]
