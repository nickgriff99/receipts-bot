# Architecture — receipts-bot (Discord AI Voice Companion)

Repo name is legacy/unrelated to receipts — this is the whole Neuro-Sama-style
ambient Discord voice co-host. See project brief for full requirements; this
doc covers the pipeline shape, module boundaries, and the barge-in/cost-control
design that make the "active/ambient by default, cooldown as the safety valve"
stakeholder decision actually hold together.

## Pipeline (end to end)

```
Discord voice channel (per user, Opus)
  │  discord/voice/receiver.ts — per-user subscribe + Opus decode (STUB, Merry)
  ▼
AudioFrame (PCM, tagged userId/guildId/channelId/timestamp)
  │  discord/voice/vad.ts — VADSegmenter (REAL: energy-threshold + silence hangover)
  ▼
VoiceSegment (per-user utterance-bounded PCM)
  │  stt/deepgramProvider.ts — streaming STT session (STUB, Merry)
  ▼
TranscriptSegment (partial + final, confidence, timestamps) ── filtered by confidenceThreshold
  │  (explicit-trigger text scan: name/@mention/reply — Merry, lives alongside receiver wiring)
  │  pipeline/turnTaking.ts — TurnTakingEngine (REAL)
  ▼
TurnDecision (shouldRespond, reason, bypassCooldown, cheapGateUsed)
  │  pipeline/rateLimiter.ts — InMemoryRateLimiter (REAL, the primary safety valve)
  │  pipeline/contextAssembler.ts — ContextAssembler (REAL: transcript window + memory + persona)
  ▼
LLMRequest
  │  llm/claudeProvider.ts — ClaudeHaikuProvider.generateResponse (STUB, Merry)
  ▼
LLMResponse { text, tone? }
  │  tts/elevenLabsProvider.ts — ElevenLabsTTSProvider.synthesizeStream (STUB, Merry)
  ▼
AsyncIterable<Buffer> (streaming audio)
  │  discord/voice/player.ts — DiscordPlaybackController (REAL @discordjs/voice plumbing;
  │                             barge-in/interrupt logic REAL, fed by a still-stubbed TTS stream)
  ▼
Voice channel playback
  │  (post-hoc, fire-and-forget from orchestrator)
  │  llm/claudeProvider.ts — ClaudeHaikuProvider.extractMemoryFacts (STUB, Merry)
  ▼
memory/postgresStore.ts — PostgresMemoryStore (REAL) → user_profiles / conversation_log / usage_log
```

`src/pipeline/orchestrator.ts` (`PipelineOrchestrator.handleSegment`) is the one
place that wires all of the above — every dependency is injected via
`OrchestratorDeps` and typed only against each module's `types.ts` interface,
never a concrete provider class. This is the seam Merry wires real
Deepgram/Anthropic/ElevenLabs/Discord implementations into without
re-architecting anything upstream or downstream of it.

## Module boundaries (directory ↔ responsibility)

| Directory | Owns | Status this round |
| --- | --- | --- |
| `src/config/` | Env loading (`AppConfig`), constants, per-guild `GuildSettings` type | Real — Zod-locked (Sam), fail-fast boot |
| `src/shared/` | id generation, structured JSON logger | Real |
| `src/stt/` | `STTProvider`/`STTSession` contract, Deepgram implementation | Interface real, impl stub |
| `src/llm/` | `LLMProvider` contract (cheap-gate + generate + memory-extract), persona | Interface real, impl stub |
| `src/tts/` | `TTSProvider` contract, ElevenLabs implementation | Interface real, impl stub |
| `src/memory/` | `MemoryStore` contract (async), PostgreSQL schema + implementation | Interface + impl real |
| `src/discord/` | Discord client bootstrap, slash commands, voice join/leave, per-user receive, VAD, playback/barge-in | Types + VAD + player + connection manager real; client/receiver/commands stubbed |
| `src/pipeline/` | Turn-taking engine, rate limiter, context assembler, top-level orchestrator | Real (pure logic + DI wiring) |
| `src/cli/` | Text-in → LLM+TTS-out test harness, no Discord/STT needed | Real harness, runs against stub providers until Merry wires them |

"Real" here means: compiles, has working control-flow/logic, and (for
memory/pipeline/discord-voice-plumbing) has no external network dependency, so
it was safe to implement fully rather than stub. "Stub" means: correct types
and constructor wiring against the actual current SDK API (verified against
each package's published `.d.ts`/README at the pinned version in
`package.json`), but the method bodies are `TODO(merry)` placeholders — this
round's job was interfaces + module boundaries, not full external-service
wiring (that's explicitly Merry's next pass).

## Barge-in / interrupt design

Locked decision: default mode is ACTIVE/AMBIENT, and the bot may occasionally
interject over ongoing chat or its own prior TTS. Because interruption is
allowed, **the rate limiter is the primary safety valve**, not turn-taking
politeness — see below.

Interrupt policy (`discord/voice/player.ts` + `pipeline/turnTaking.ts` +
`pipeline/orchestrator.ts` together):

1. Every `TurnCandidate` is tagged `explicit_mention` / `explicit_reply` /
   `explicit_name` / `ambient_pause`.
2. **Explicit triggers bypass the cheap gate** and the **min-gap cooldown**
   (but not the per-minute cap) — a direct "@bot" or name-mention always gets
   a prompt answer even mid-cooldown.
3. **Ambient triggers** always go through the haiku cheap-gate call first,
   then the *full* rate limiter (cap AND min-gap) — no exceptions.
4. If the bot is already speaking (`PlaybackController.isSpeaking`):
   - a new **explicit** candidate barges in — `interrupt()` aborts the TTS
     stream (via `AbortController`) and calls `AudioPlayer#stop(true)` before
     the new utterance starts playing.
   - a new **ambient** candidate does **not** barge in over the bot's own
     current speech — it's dropped as a no-op. This is a deliberate
     conservative default (`allowAmbientBargeIn` config flag exists in
     `GuildSettings`/`.env.example` for future tuning, default `false`) so
     ambient mode can't stack self-interruptions into a spam loop. Ambient
     chimes interrupting *human* conversation (talking during a lull) is
     fine and expected; the bot interrupting *itself* repeatedly is the
     failure mode this guards against.
5. Barge-in cuts generation as well as playback — `TTSProvider.synthesizeStream`
   takes an optional `AbortSignal` so Merry's real ElevenLabs wiring can cancel
   the upstream stream request too, not just stop consuming bytes locally.

## Cost control (the actual binding constraint)

Budget ceiling ~$20-30/mo combined. Enforcement points, in order of when
money would otherwise get spent:

1. **Cheap-gate first** (`llm/claudeProvider.ts#cheapGateCheck`, called from
   `pipeline/turnTaking.ts`) — every ambient candidate gets a short/cheap
   haiku yes-or-no call *before* any full generation. This is the main lever:
   most lulls should get gated out here, not generate a full response.
2. **Rate limiter is the hard backstop** (`pipeline/rateLimiter.ts`) —
   sliding 60s window cap (`maxResponsesPerMinute`, default 5) plus a min-gap
   cooldown (`minGapSeconds`, default 10) between any two bot utterances.
   This applies regardless of how chatty the cheap gate is, and regardless of
   ambient-vs-explicit (explicit only skips the min-gap half, never the cap).
3. **Usage logging** (`memory/postgresStore.ts` `usage_log` table,
   `MemoryStore.logUsage`/`getUsageSince`) — every LLM call (cheap-gate,
   generate, memory-extract) logs token counts; STT/TTS logging points exist
   in the same table (`service: 'stt' | 'tts'`) for Merry to call from the
   real Deepgram/ElevenLabs wiring, so the whole "$20-30/mo" budget is
   auditable per guild, not just asserted.

## Concurrency model (medium scale target: few guilds, ~10 concurrent speakers)

- One `VADSegmenter` per voice connection (guild), with independent
  per-`userId` state inside it — speakers never share a buffer, so 10
  simultaneous speakers segment independently.
- One `STTSession` per (guild, user) pair — `STTProvider.startSession` is
  designed to be called once per speaking user, not once per guild.
- `PipelineOrchestrator` keeps one rolling transcript history per guild
  (interleaved across all speakers, each `TranscriptSegment` tagged with
  `userId`/`displayName` so the LLM prompt can attribute who said what) —
  this is the "interleave transcript segments with per-speaker timestamps"
  requirement from the brief.
- `InMemoryRateLimiter` and `DiscordPlaybackController` key all state by
  `guildId`, so multiple guilds run fully independently within one process.
  This is a single-process design (fits the "medium scale, few guilds" v1
  target) — if horizontal scaling across processes is ever needed, the rate
  limiter state and playback state both need to move to a shared store
  (Redis, or the existing Postgres db); flagged here, not solved in v1.

## System prerequisites (confirmed while scaffolding, not just assumed)

- **Node.js >= 22.12.0** — `@discordjs/voice@0.19.2` declares this as its
  minimum engine (checked against the actual published package metadata,
  not guessed). `package.json#engines` reflects this. (`pg`, the Postgres
  driver, has no such constraint — pure JS, no native build step.)
- **A reachable PostgreSQL instance** (`DATABASE_URL`) — `docker-compose.yml`
  runs one (`postgres:16-alpine`) with a healthcheck the `bot` service
  `depends_on`, so `docker compose up` doesn't race Postgres startup. For
  local (non-Docker) `npm run dev`, point `DATABASE_URL` at any Postgres
  13+ instance; the store runs `CREATE TABLE IF NOT EXISTS` (`schema.ts`)
  against it at construction time, but does not create the database itself.
- **ffmpeg** on PATH (or `ffmpeg-static` installed) — `discord/voice/player.ts`
  uses `StreamType.Arbitrary` for the audio resource, which `prism-media`
  transcodes to Opus via ffmpeg under the hood.

## What's real vs. stubbed, and why (recap for the handoff)

Everything that is pure logic or touches only local resources (Postgres,
VAD math, rate limiting, turn-taking decisions, context assembly, DI wiring
in `index.ts`/`orchestrator.ts`) is implemented for real this round — it's
architecture, not integration, and there's no reason to leave it as a stub.

Everything that requires a live external API (Deepgram, Anthropic, ElevenLabs)
or live Discord gateway/voice-receive plumbing is a structurally-correct stub:
real imports, real constructor/client shapes (each verified against the
actual published SDK types/README at the pinned version — not guessed), but
`TODO(merry)`-marked method bodies. That is intentionally this round's
boundary; Merry's job next is filling those bodies in.

## Contract lock addendum (Sam)

Five shapes handed off by Frodo are now real Zod schemas, colocated with
their existing `types.ts` files (schema-adjacent, not a separate package —
this is a single-process bot, not a monorepo with a shared client/server
boundary):

- `TranscriptSegmentSchema` (`src/stt/types.ts`)
- `TriggerTypeSchema` / `TurnCandidateSchema` / `TurnDecisionSchema` (`src/pipeline/types.ts`)
- `LLMRequestSchema` / `LLMResponseSchema` / `CheapGateInputSchema` /
  `CheapGateResultSchema` / `MemoryExtractionInputSchema` /
  `MemoryExtractionResultSchema` (`src/llm/types.ts`) — plus three
  **raw-reply** schemas + lenient parsers (`parseLLMReply`,
  `parseCheapGateReply`, `parseMemoryExtractionReply`) for the untrusted
  raw JSON-or-prose a live Claude completion can return. See file-level
  doc comment in `src/llm/types.ts` for the full trust-boundary rationale.
- `UserMemoryProfileSchema` / `GuildSettingsSchema` / `UsageLogEntrySchema` /
  `ConversationLogEntrySchema` (`src/memory/types.ts`), matching DDL in
  `src/memory/schema.ts`
- `AppConfigSchema` (`src/config/types.ts`) — `env.ts` now calls
  `AppConfigSchema.safeParse(process.env)` and exits(1) with a readable
  issue list on failure, instead of silently defaulting missing keys to
  `""`.

**Schema-lock decision — facts/running_jokes storage:** JSON-encoded TEXT
columns (`facts_json`, `running_jokes_json`), NOT a normalized child table.
These lists are short and always read/written as a whole per profile in v1
— no per-item query/filter requirement exists yet, so a child table would
add join/write complexity without a matching payoff. The real risk of
blob storage (unbounded growth, since there's no per-row deletion) is
closed by hard caps: `MAX_FACTS_PER_PROFILE` (40) /
`MAX_RUNNING_JOKES_PER_PROFILE` (20) / `MAX_FACT_LENGTH` (240 chars) in
`src/config/constants.ts`, enforced at the Zod boundary AND in
`sqliteStore.ts#dedupeAppend` (truncates to the newest N on every write —
belt and braces, not just documentation). Revisit as a v2 migration if a
feature ever needs to query/search individual facts.

**Schema-lock decision — enum columns get `CHECK` constraints too:**
`guild_settings.mode` and `usage_log.service`/`unit_type` now have
`CHECK (... IN (...))` constraints matching their Zod enum schemas — belt
and braces at the DB layer, not just app-layer validation. Caveat: `CREATE
TABLE IF NOT EXISTS` does not retroactively add constraints to
already-existing tables (same caveat applied under the old SQLite
implementation, still true under Postgres); harmless for v1 (no production
data yet), but if a dev has an old dev database from before this change,
drop and recreate it rather than expecting the CHECK to appear.

**Postgres migration (Gollum):** memory layer moved from `better-sqlite3`
(local file, synchronous API) to PostgreSQL via `pg` (network I/O,
inherently async), per owner's known-stack preference. Table/column names
and `ON CONFLICT ... DO UPDATE` upsert semantics ported near-verbatim —
see `src/memory/schema.ts` for the full type-mapping writeup (`JSONB`
instead of `TEXT`-with-`JSON.parse`, native `BOOLEAN` instead of
SQLite's `INTEGER 0/1`, `BIGINT` instead of untyped `INTEGER` for
timestamp columns). The `MemoryStore` interface itself changed — every
method now returns a `Promise`, since sync-only was an artifact of
better-sqlite3's API, not a real property of the contract. This is a
real breaking change to `src/memory/types.ts`; every call site
(`pipeline/orchestrator.ts`, `pipeline/rateLimiter.ts`,
`pipeline/turnTaking.ts`, `pipeline/contextAssembler.ts`,
`discord/bootstrap.ts`, `discord/commands/*.ts`, `src/index.ts`) was
updated to `await` it. No ORM used (project constraint) — plain
parameterized SQL via `pg`'s `Pool.query`.

**`AppConfig` locked defaults** (all overridable via env, matching the
brief's budget-driven stakeholder decisions): `ANTHROPIC_MODEL` defaults to
`claude-haiku-4-5-20251001`; `DEFAULT_MODE` defaults to `active`
(ambient-by-default); `DEFAULT_MAX_RESPONSES_PER_MINUTE` defaults to `8`;
`DEFAULT_MIN_GAP_SECONDS` defaults to `6`. Boolean env flags (e.g.
`DEFAULT_ALLOW_AMBIENT_BARGE_IN`) use an explicit string-preprocess step,
NOT `z.coerce.boolean()` — the latter treats the literal string `"false"`
as truthy (any non-empty string coerces to `true`), which would have
silently inverted the barge-in-safety default.

No shapes changed from Frodo's draft beyond what's necessary for Zod (e.g.
`TranscriptSegment.text` explicitly allows empty string for in-flight
partials) — see the handoff notes in the fullstack round for the full
diff-vs-draft list.

## Wiring round addendum (Merry)

Every module the tables above marked "impl stub" is now real: Deepgram v5
(`client.listen.v1.connect`), Anthropic (`messages.create` + Sam's lenient
parsers), ElevenLabs (`textToSpeech.stream` → `Readable.fromWeb` →
`AsyncIterable<Buffer>`), and the full discord.js v14 client/bootstrap
(login, slash command registration + dispatch, `voiceStateUpdate` auto-join,
`messageCreate` explicit-trigger detection, consent notice on join). Every
SDK call site was checked against the installed `.d.ts` at the pinned
version (not guessed) — `V1Client.ConnectArgs`/`V1Socket` for Deepgram,
`TextToSpeechClient.stream`/`HttpResponsePromise<T> extends Promise<T>` for
ElevenLabs, `Message.usage.input_tokens: number | null` for Anthropic,
`GuildMemberManager.fetch(userId)` (single-member REST overload, no
privileged intent) vs. `fetch()` (no-args, gateway "request guild members",
DOES need `GUILD_MEMBERS`) for discord.js.

Bugs found and fixed in this pass (none required touching Sam's locked
schemas):

- **`resolveDisplayName` cache-only bug** — the original synchronous
  `guild.members.cache.get(userId)` silently fell back to the raw Discord ID
  as the "display name" for any user who was already in the voice channel
  before the bot's `/join` (i.e. never triggered a cache-populating gateway
  event). Fixed by making display-name resolution async with a
  single-member REST fetch fallback (`discord/bootstrap.ts#resolveDisplayName`),
  gated by a `pendingSttUsers` set per guild so a second rapid speaking-start
  event can't race in and spin up a duplicate STT session while the first
  resolution is in flight. Cost: one REST round-trip per (guild, user) per
  bot session, not per utterance.
- **CLI test harness required Discord/Deepgram env** — `src/cli/testMode.ts`
  originally called the shared `config/env.ts#loadConfig()`, which validates
  Sam's locked `AppConfigSchema` end-to-end (all keys `min(1)`, no
  Discord/Deepgram defaults). That meant the brief's literal "should
  actually run if user supplies ANTHROPIC_API_KEY and ELEVENLABS_API_KEY"
  silently also required a Discord bot application + Deepgram account.
  Not a defect in `AppConfigSchema` itself (that's correctly strict for the
  live bot process) — just the wrong loader for an isolated LLM+TTS smoke
  test. Fixed with a small dedicated Zod schema in `testMode.ts` covering
  only the 4 keys that harness actually touches.
- **Dockerfile `npm install --omit=dev=false`** — invalid npm flag syntax
  (`--omit` only accepts `dev`/`optional`/`peer`); npm warns and ignores it
  rather than erroring, so the build still worked by accident (default omit
  is empty pre-`NODE_ENV=production`), but it read as intentional and was
  fragile. Replaced with plain `npm ci` (lockfile-exact, matches the
  already-committed `package-lock.json`), verified locally with
  `npm ci --dry-run`.

Not fixed / flagged as known v1 limitations, not bugs:

- `/mode value:<active|quiet>` was already implemented (Frodo/Sam scaffold)
  as the mechanism for the brief's "`/quiet`/`/active` slash commands (or
  config)" ask. Added literal one-word `/quiet` and `/active` command
  aliases alongside it (same `MemoryStore.setGuildSettings` call) so both
  phrasings from the brief are satisfied without duplicating logic.
- Single-process rate limiter / playback state (already flagged above under
  "Concurrency model") — still true, not revisited this round.
- No automatic `conversation_log` retention cron — `pruneOldLogs` exists and
  is exercised by tests conceptually but nothing calls it on a schedule yet;
  an operator needs to wire a cron/job runner call themselves (README now
  states this explicitly rather than implying it's automatic).
