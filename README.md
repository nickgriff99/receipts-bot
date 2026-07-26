# receipts-bot

Discord AI voice companion bot (Neuro-Sama-style ambient co-host). The repo
name is legacy/unrelated to receipts — this **is** the whole bot.

See `ARCHITECTURE.md` for the full pipeline, module boundaries, and the
barge-in/cost-control design. This file covers setup + running.

## Status

**Wired end-to-end (Merry's pass; memory layer since migrated to PostgreSQL
by Gollum).** Every stage in the pipeline — Discord voice receive (per-user
Opus decode), VAD segmentation, Deepgram streaming STT, Claude Haiku
(cheap-gate + full response + memory extraction), ElevenLabs streaming TTS,
`@discordjs/voice` playback with barge-in, PostgreSQL-backed memory/usage
logging, rate limiting, and all slash commands — is real code
against each SDK's actual documented API, not a stub. What's **not**
possible to verify in this environment (no live bot token / paid API keys):
an actual Discord gateway connection and actual paid API responses. Every
call site was checked against the installed `.d.ts` for the pinned package
version (see `ARCHITECTURE.md`'s wiring-round addendum for specifics), so
this should be structurally correct, not just compiling.

## Prerequisites

- **Node.js >= 22.12.0** (required by `@discordjs/voice` — see
  `ARCHITECTURE.md`). If your local machine is on an older Node (this repo
  was developed against Node 20 locally), `npm install` may fail outside
  Docker — use the Docker path below instead of fighting a local toolchain.
- **A PostgreSQL instance** — memory/usage/conversation-log storage (see
  `src/memory/schema.ts`). `docker compose up` starts one for you
  (`postgres:16-alpine` service, healthchecked); for local (non-Docker)
  `npm run dev`, point `DATABASE_URL` at any reachable Postgres 13+ instance.
- **ffmpeg** on `PATH` — used by `@discordjs/voice`/`prism-media` to
  transcode arbitrary audio streams (ElevenLabs mp3 output) into Opus for
  playback.
- API keys: Anthropic, Deepgram, ElevenLabs (see `.env.example`).

### Discord application setup (Developer Portal)

1. Create an application + bot user at https://discord.com/developers/applications.
2. **Privileged Gateway Intents** — toggle ON:
   - **Message Content Intent** — required to read `message.content` in the
     paired text channel for @-mention/reply/name-trigger detection
     (`discord/bootstrap.ts#handleMessageCreate`).

   `Server Members Intent` is **NOT** required — display-name resolution for
   speakers uses a single-user REST fetch (`guild.members.fetch(userId)`),
   which doesn't need that privileged intent, rather than requesting the
   full member list.
3. **Gateway intents requested by the code** (`discord/client.ts`, exact
   list — every intent the bot asks for and why):
   | Intent | Why |
   | --- | --- |
   | `Guilds` | Baseline guild/channel caching; required by almost everything else. |
   | `GuildVoiceStates` | Required by `@discordjs/voice` for any voice connection at all (join/leave, receive). |
   | `GuildMessages` | Receive `messageCreate` events in guild text channels. |
   | `MessageContent` | Read the actual text of messages in the paired text channel (privileged — Developer Portal toggle above). |
4. **Bot permissions** (invite URL / OAuth2 scope `bot applications.commands`):
   `View Channels`, `Send Messages`, `Connect`, `Speak`, `Use Voice Activity`.
   No `Administrator` needed.
5. Note the **Application ID** and **Bot Token** for `.env`.

## Setup

```bash
cp .env.example .env
# fill in DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, ANTHROPIC_API_KEY,
# DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, DATABASE_URL
npm install
```

`DATABASE_URL` must point at a running Postgres instance before the bot
(or `npm run dev`) will boot — the store runs `CREATE TABLE IF NOT EXISTS`
against it on construction (`src/memory/postgresStore.ts`), it does not
create the database itself. Easiest local option: `docker compose up postgres`
to start just the DB service, then run `npm run dev` against
`DATABASE_URL=postgres://receipts_bot:receipts_bot@localhost:5432/receipts_bot`.

## Run (local)

```bash
npm run dev          # tsx watch — full live bot process (Discord login, voice, everything)
npm run cli:test -- "say something witty"   # LLM+TTS smoke test, no Discord/STT/Deepgram needed —
                                             # only needs ANTHROPIC_API_KEY + ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID in .env
npm run typecheck    # tsc --noEmit
npm run build && npm start   # compiled run
```

## Run (Docker)

```bash
docker compose up --build
```

The `Dockerfile` uses `node:22-bookworm-slim` with `ffmpeg` preinstalled, so
audio playback works out of the box regardless of the host OS/Node version
(no native build toolchain needed — `pg`, the Postgres driver, is pure JS).
`docker-compose.yml` also starts a `postgres:16-alpine` service with a
named volume (`postgres-data` → `/var/lib/postgresql/data`, survives
container rebuilds/restarts) and a healthcheck; the `bot` service
`depends_on: postgres: condition: service_healthy` so it never races
Postgres on startup, and its `DATABASE_URL` is pointed at the `postgres`
service by name (not `localhost`) via a compose-level `environment`
override. The bot's other secrets (`DISCORD_BOT_TOKEN`, API keys, etc.)
still come from `.env` via `env_file`.

## Slash commands

| Command | Effect |
| --- | --- |
| `/join` | Bot joins your current voice channel and starts listening. |
| `/leave` | Bot leaves its current voice channel. |
| `/mode value:<active\|quiet>` | Set ambient (default) vs. addressed-only mode. |
| `/quiet` / `/active` | Same as `/mode`, one-word aliases (both call the same underlying setting). |
| `/optout` | Exclude yourself from transcription/memory in this server. |
| `/optin` | Reverse `/optout`. |

All settings/opt-out writes go through `MemoryStore.setGuildSettings` /
`MemoryStore.setOptOut` — never raw SQL from a command handler.

## Compliance / consent (read before deploying to a real server)

Two independent gates, both must pass before a user's voice/text is
processed:

- **`consentAccepted`** — has this user ever clicked **Accept**? Starts
  `false` for everyone. On joining a voice channel, the bot posts a visible
  notice with an Accept button in the paired text channel
  (`discord/bootstrap.ts#postConsentNotice`, fires every `/join` /
  auto-join). Until a user clicks it, the bot does **not** subscribe to
  their audio at all — no STT session is started for them
  (`startSttSessionForUser`), so nothing is captured or sent to Deepgram —
  and their explicit @mention/reply text triggers are dropped
  (`handleMessageCreate`). Clicking Accept sets the flag via
  `MemoryStore.setConsentAccepted`.
- **`optedOut`** — did a user who already accepted later ask to be
  excluded? `/optout` lets any user who has accepted exclude themselves
  from transcription/memory — checked **after** the consent gate, in the
  same two call sites (`handleUserSpeakingStart` / `startSttSessionForUser`
  and `handleMessageCreate`), not just before persistence. `/optin`
  reverses it (does not re-grant `consentAccepted` — that's a one-way
  click, separate from opt-out/opt-in toggling).
- Both gates are also re-checked as a safety net in
  `pipeline/orchestrator.ts#handleSegment` (`hasAcceptedConsent` then
  `isOptedOut`), mirroring each other — defense in depth in case a future
  caller reaches the orchestrator without going through
  `discord/bootstrap.ts`'s gates.
- **Raw audio is never persisted** — only transcripts and derived memory
  facts are stored in PostgreSQL (`memory/schema.ts`). `conversation_log` (raw rolling
  transcript) rows are prunable via `MemoryStore.pruneOldLogs` for a stated
  retention policy; `user_profiles` (durable memory: facts, running jokes,
  sentiment notes) is capped per-user (`MAX_FACTS_PER_PROFILE` = 40,
  `MAX_RUNNING_JOKES_PER_PROFILE` = 20) rather than growing unbounded — see
  `config/constants.ts`. No retention job is scheduled automatically in v1;
  `pruneOldLogs(beforeTimestamp)` is exposed on `MemoryStore` for an operator
  to call on a cron/cadence of their choosing (e.g. keep 30 days of raw
  `conversation_log`).
- **Recording consent is the deploying admin's legal responsibility** —
  requirements vary by jurisdiction and are also governed by Discord's own
  ToS. This software does not provide legal advice or guaranteed compliance;
  it gives you the mechanical pieces (visible notice, opt-out, no raw-audio
  persistence, prunable logs) to build a compliant deployment on top of.

## Cost / usage auditing

Every Deepgram (characters, proxy for STT activity — Deepgram itself bills
by audio duration, see `pipeline/orchestrator.ts` comment), Claude
(input+output tokens, across cheap-gate + generate + memory-extract calls),
and ElevenLabs (characters synthesized) call is logged to the `usage_log`
PostgreSQL table via `MemoryStore.logUsage`/`getUsageSince`. Rate limiting
(`pipeline/rateLimiter.ts`) is the hard cost backstop — sliding 60s
per-guild cap (`maxResponsesPerMinute`, default 5) + min-gap cooldown
(`minGapSeconds`, default 10s), with explicit @-mention/reply/name triggers
bypassing only the min-gap half, never the cap. Latency
(speech-end → bot-starts-speaking) is logged as a `warn` if it exceeds
`LATENCY_WARN_THRESHOLD_MS` (2.5s, `config/constants.ts`).

## Project layout

```
src/
  config/     env + constants + GuildSettings/AppConfig types
  shared/     id generation, structured logger
  stt/        STTProvider contract + Deepgram implementation
  llm/        LLMProvider contract (cheap-gate/generate/memory-extract) + persona + Claude Haiku implementation
  tts/        TTSProvider contract + ElevenLabs implementation
  memory/     MemoryStore contract (async) + PostgreSQL schema + implementation
  discord/    client bootstrap, slash commands, voice join/leave/receive/playback
  pipeline/   turn-taking engine, rate limiter, context assembler, orchestrator
  cli/        text-in / LLM+TTS-out test harness (no Discord/STT needed)
  index.ts    process entrypoint
```
