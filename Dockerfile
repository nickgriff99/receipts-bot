FROM node:22-bookworm-slim

# ffmpeg: required by @discordjs/voice/prism-media to transcode arbitrary
# audio to Opus for playback (see ARCHITECTURE.md "System prerequisites").
# build-essential/python3: the memory layer's better-sqlite3 native build is
# gone (replaced by pure-JS `pg`), but @discordjs/opus still ships no
# prebuilt binary for this image's glibc/Node ABI combo and falls back to a
# node-gyp source build on `npm ci` — these are still required, not optional.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      build-essential \
      python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# Plain `npm ci` (no --omit flag): NODE_ENV isn't set yet at this point in the
# build (it's set to production further below, after `npm run build`), so
# npm's default omit list is empty and devDependencies (typescript, tsx —
# needed for the `npm run build` step right after) install alongside prod
# deps. A previous `--omit=dev=false` here was invalid npm syntax (npm just
# warns "invalid config" and ignores it — harmless today since the default
# already includes dev deps pre-NODE_ENV=production, but worth not shipping
# a nonsense flag that reads as intentional).
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
