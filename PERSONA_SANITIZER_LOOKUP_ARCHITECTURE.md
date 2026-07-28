# Architecture addendum — persona/sanitizer/web-lookup/guild-lore/live-steering round (frodo, solo)

Durable record of this round's decisions — read this first if the round resumes, not agent memory.

## 1. Bug fix — sanitizer stage (root cause confirmed, not guessed)

Owner's "text... tone... observation" complaint: `parseLLMReply` (`src/llm/types.ts`)
always had a "trust the raw completion as plain prose" fallback for genuinely
non-JSON replies — deliberate, since the persona prompt allows plain text.
Nothing distinguished that from a *failed structured attempt* (Haiku
replying `text: ... tone: observation` instead of real JSON), so the whole
raw string — labels and all — got spoken verbatim.

Fix, two layers:

1. **`parseLLMReply` tightened** (`src/llm/types.ts`): `looksLikeFailedStructuredReply(raw)`
   detects the specific shapes a failed structured attempt takes (starts with
   `{`, or carries a `text:`/`tone:`-style label) — deliberately narrow so it
   doesn't misfire on ordinary prose containing a colon. When detected,
   `extractLabeledField` salvages just the `text`/`tone` VALUES instead of
   trusting the raw string; if nothing salvageable is found, returns empty
   text (same contract as any other genuine failure) rather than falling
   through to the plain-prose path.
2. **`sanitizeSpokenText`** (new file, `src/llm/sanitize.ts`) — applied to
   the FINAL text in `claudeProvider.ts#generateResponse`, unconditionally,
   regardless of which parse path produced it. Strips `*stage directions*`,
   markdown, and any leftover label prefixes (belt-and-braces on top of
   case 1 above), then runs the banned-phrase blacklist (task 2). Empty
   after sanitizing = nothing salvageable/safe, same contract as the
   pre-existing empty-response case — `orchestrator.ts` already skips
   TTS/playback for empty text, no new code needed there.

**Retry tradeoff, decided**: no one-shot retry-with-stricter-instruction
this round. Reasoning: a retry adds a full extra API round-trip (real
latency in a live voice pipeline, real cost) with no guarantee of success
(the model can fail the same way twice); salvage-and-sanitize is strictly
cheaper and deterministic. Revisit only if live-listening logs show the
salvage path failing OPEN too often (losing genuinely good replies, not
just broken ones) — that would be the actual signal a retry is worth it.

## 2. Persona rewrite + blacklist

`src/llm/persona.ts` — added few-shot example exchanges (Neuro-sama's
`constants.py` precedent: demonstrate personality with actual lines, not
just adjectives), explicitly framed "tone only, don't reuse verbatim" so
the model treats them as calibration, not a script. Examples show the exact
blend the owner asked for: trash-talk landing alongside a correct/useful
answer, a running-joke callback, and "drop the bite, go warm" actually
demonstrated. Ported the "if a bit doesn't land, drop it and move on"
instruction into `claudeProvider.ts`'s EXISTING don't-repeat-yourself system
prompt clause (extended, not duplicated, per the manager's brief).

`src/config/blacklist.ts` (new) — small, deliberately NOT a guessed
slur/hate-speech list (shipping one unreviewed would read as an
authoritative moderation policy the owner never actually approved). Ships
two real self-harm-adjacent phrases as a working example of the mechanism,
with clear extension instructions. Wired into `sanitizeSpokenText`
(whole-utterance drop on match, not partial redaction — a redacted-around
match can still read as endorsing/completing the bad phrase).

## 3. Web lookup

`ClaudeHaikuProvider.generateResponse` now offers Claude's native
`web_search_20250305` server tool (verified against the installed
`@anthropic-ai/sdk@0.115.0` `.d.ts`, not guessed — `WebSearchTool20250305`,
`name: 'web_search'`, `max_uses`). Model decides autonomously whether to use
it (`tool_choice` left at default `auto`) — satisfies "only fire when
actually needed" without any code-level gating; the system prompt also
explicitly instructs it's for genuine factual questions only, never
reflexive.

- **`max_uses: 1`** (`WEB_SEARCH_MAX_USES_PER_TURN`) — one search per turn is
  enough for "answer the question just asked", bounds latency/cost.
- **Timeout**: `LLM_GENERATE_TIMEOUT_MS` (15s), passed as the SDK's
  per-request `{ timeout }` option, applied to EVERY `generateResponse` call
  (not just web-search-enabled ones — an uncapped LLM call blocking the
  guild's serialized turn queue was always a latent risk). Anthropic's
  web_search tool executes server-side WITHIN the same request, so there is
  structurally no way to give search and generation separate budgets — only
  one timeout for the whole call. On timeout, the existing catch block
  already degrades to `{text: ""}`, which `orchestrator.ts` already skips
  playback for — no new failure path needed.
- **Master switch**: `DEFAULT_WEB_SEARCH_ENABLED` env / `AppConfig.defaults.webSearchEnabled`
  / `ClaudeHaikuProviderOptions.webSearchEnabled` (default `true`) — same
  "independent kill switch, redeployable without a code change" precedent as
  `DEFAULT_PROACTIVE_CHIME_ENABLED`.
- **Usage/cost logging — flagged for Sam, not decided silently**: `Message.usage.server_tool_use.web_search_requests`
  (confirmed present in the installed SDK's types) is threaded onto
  `LLMResponse.usage.webSearchCount` (optional field, additive). Web search
  is billed PER-SEARCH, a genuinely different unit than the token-count
  `usage_log` row already written for the same call — `UsageServiceSchema`/
  `UsageUnitTypeSchema` (`memory/types.ts`) don't have a unit for it.
  `orchestrator.ts#runTurn` logs it to the structured logger for now (real
  observability) rather than silently folding it into the `'llm'`/`'tokens'`
  row (would misrepresent cost) or silently adding a new enum value (Sam's
  lock to make). **Sam: decide whether this needs its own `UsageService`
  member or a new `UsageUnitType` before it becomes a persisted cost-audit
  row.**

## 4. Guild-wide running jokes/lore

New `guild_memory` table (`src/memory/schema.ts`), one row per guild —
deliberately a SEPARATE table from `guild_settings`, not another JSON
column on it, despite the identical shape: `guild_settings` is documented as
"admin-mutable config", jokes here are bot-LEARNED collective memory, a
different concern. Same JSON-blob-column + cap pattern as
`user_profiles.running_jokes_json` (`MAX_GUILD_RUNNING_JOKES`, both Zod- and
`dedupeAppend`-enforced — `dedupeAppend` generalized to take an explicit cap
parameter instead of hardcoding `MAX_FACTS_PER_PROFILE`).

**Extraction cadence, decided**: a SEPARATE periodic pass
(`PipelineOrchestrator#maybeExtractGuildJokes`), NOT an extension of
`extractMemoryFacts`. Reasoning: guild jokes are collective — they often
emerge from humans talking among themselves, not from a specific
bot-exchange — so tying extraction to "the exchange that just finished
between the bot and one person" would structurally miss most of them, and
would pay the extra prompt-context cost of the guild-jokes list on every
single bot turn regardless of relevance. Instead, `PipelineOrchestrator`
counts final human transcript segments per guild
(`guildJokeSegmentCounterByGuild`) and fires a wider-window extraction
(`GUILD_JOKE_EXTRACTION_HISTORY_WINDOW` = 40 segments) every
`GUILD_JOKE_EXTRACTION_INTERVAL_SEGMENTS` (= 20) — mirrors Neuro's
`modules/memory.py` reflect-every-~20-messages cadence, a better fit for
"collective, emerges over many exchanges."

New `LLMProvider.extractGuildJokes` method + `GuildJokeExtractionInputSchema`/
`ResultSchema`/raw-reply schema + `parseGuildJokeExtractionReply` (same
lenient-fallback convention as the other extraction parsers). Context
assembly: `ContextAssembler.assemble` now also reads `MemoryStore.getGuildMemory`
and threads `guildRunningJokes: string[]` onto `LLMRequest` (new required
field — `ContextAssembler` is the sole builder, same convention as
`recentTones`). `claudeProvider.ts#generateResponse` formats them into the
user content as a separate "server-wide lore, not tied to one person" block.

## 5. Live-steering admin injection

`GuildSettings.liveContextOverride` (string) + `liveContextOverrideExpiresAt`
(epoch ms) — new nullable columns on the already-live `guild_settings` table
(`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, matching this project's
established live-DB-migration pattern).

**Write path, decided**: two dedicated `MemoryStore` methods —
`setLiveContextOverride(guildId, text, ttlMs?)` / `clearLiveContextOverride(guildId)`
— NOT the generic `setGuildSettings` patch that every other optional
override (`voiceId`/`consentChannelId`) uses. Reason: `setGuildSettings`'s
merge semantics are `patch.x ?? current?.x`, which has no way to express
"clear this field" — passing `undefined` just means "leave it alone." The
brief explicitly wants this override clearable, so a dedicated method
sidesteps the ambiguity entirely rather than inventing new null-vs-undefined
patch semantics that would also silently apply to the other optional
fields. `PostgresMemoryStore#setGuildSettings`'s merge ALSO ignores
`patch.liveContextOverride`/`patch.liveContextOverrideExpiresAt` even if a
caller passes them, and `http/routes/admin.ts#GuildSettingsPatchSchema` now
explicitly `.omit()`s both fields — so there is no path (HTTP or in-process)
that can set/clear an override without going through the TTL-capping logic.

**Expiry, decided**: `setLiveContextOverride` computes
`expiresAt = now + min(ttlMs ?? LIVE_CONTEXT_OVERRIDE_DEFAULT_TTL_MS (2h), LIVE_CONTEXT_OVERRIDE_MAX_TTL_MS (12h))`
server-side, so the cap holds regardless of what a caller requests — a
forgotten override always self-expires. Lazily filtered on READ
(`ContextAssembler.assemble` checks `Date.now() < expiresAt`), not swept
server-side — same "lazy expire on read, no dedicated sweep timer"
precedent as `PipelineOrchestrator#getActiveThreadContinuation`'s
active-thread TTL. No numeric "priority" field — v1 is a single override
slot per guild (not a list), so priority is expressed as prompt emphasis
("takes priority over your own guess at what's going on") rather than a
numeric field with nothing to rank against.

Wired into `generateResponse`'s prompt only (per the brief's explicit
scope) — NOT into the cheap-gate prompts. Possible follow-up, not done this
round: an active override (e.g. "we're watching a movie") plausibly should
also inform the cheap-gate's yes/no judgment, not just the full generation's
content.

## Handoff

**Contract shapes for Sam to lock:**

- `UsageSchema.webSearchCount` (`src/llm/types.ts`, optional, additive) —
  decide whether web-search usage needs its own `UsageService`/`UsageUnitType`
  member before persisting to `usage_log` (see section 3 above). Currently
  only structured-logged, not DB-persisted.
- `GuildMemorySchema` + `guild_memory` table (`src/memory/types.ts` /
  `schema.ts`) — new table, DDL as written; review for lock.
- `GuildSettingsSchema.liveContextOverride` / `liveContextOverrideExpiresAt`
  (optional pair) + the two new nullable `guild_settings` columns — review
  the "dedicated write methods, excluded from the generic patch" design
  above for lock; flag if a different shape is preferred.
- `LLMRequestSchema.guildRunningJokes` (required `string[]`) and
  `.liveContextOverride` (optional `string`) — new fields on the existing
  locked `LLMRequest` contract.
- `GuildJokeExtractionInputSchema`/`ResultSchema`/`GuildJokeExtractionRawReplySchema`
  (`src/llm/types.ts`) — new extraction contract, same shape-family as
  `MemoryExtractionInputSchema`/`ResultSchema`.
- `MemoryStore` interface additions: `setLiveContextOverride`,
  `clearLiveContextOverride`, `getGuildMemory`, `appendGuildRunningJokes`.

**Wiring for Merry:**

- Admin surface for live-steering (task 5) — a real slash command
  (`/setcontext <text> [duration]` style) and/or an HTTP route
  (`PUT/POST /admin/guilds/:guildId/live-context` + a clear/`DELETE`
  counterpart) calling `MemoryStore.setLiveContextOverride`/
  `clearLiveContextOverride`. `discord/commands/setConsentChannel.ts` is the
  closest existing pattern to follow (Manage Server gated).
- Whether the live-context override should also flow into the cheap-gate
  prompts (flagged above as a possible follow-up, not done this round).
- Any pipeline/orchestrator observability pass specifically for web-search
  timeout/error behavior beyond what's here (current behavior: timeout ->
  caught -> logged -> empty response -> skipped playback, verified by
  reading the code path, not live-tested against a real slow search).
- Live-listening confirmation of the persona few-shot examples' actual
  effect on tone (calibration prompts are a first draft, same "needs live
  confirmation, `tsc` can't verify it" caveat as every prior prompt-tuning
  change in this project).

**Files touched:** `src/config/constants.ts`, `src/config/blacklist.ts`
(new), `src/config/types.ts`, `src/llm/sanitize.ts` (new),
`src/llm/types.ts`, `src/llm/persona.ts`, `src/llm/claudeProvider.ts`,
`src/memory/types.ts`, `src/memory/schema.ts`, `src/memory/postgresStore.ts`,
`src/pipeline/contextAssembler.ts`, `src/pipeline/orchestrator.ts`,
`src/http/routes/admin.ts`, `src/index.ts`, `src/cli/testMode.ts`,
`.env.example`.

`npm run typecheck` — clean.

## Sam's contract-lock addendum (this round)

Reviewed all five flagged shapes against the doc above — four locked as
written (`GuildMemorySchema`/`guild_memory` DDL match exactly, cap enforced
both Zod + `dedupeAppend`; `liveContextOverride`/`liveContextOverrideExpiresAt`
dedicated-write-path design holds — grepped `admin.ts`'s `.omit()` and
`postgresStore.ts#setGuildSettings`'s merge to confirm no bypass exists, and
`ContextAssembler.assemble` is confirmed the sole, correctly-TTL-filtered read
site; `LLMRequestSchema.guildRunningJokes`/`.liveContextOverride` flow
end-to-end with no dead fields/dupes; the guild-joke extraction contract
already follows the lenient-parse-with-fallback convention; the four new
`MemoryStore` methods are in sync across interface/implementation/call sites —
`setLiveContextOverride`/`clearLiveContextOverride` correctly have zero call
sites yet, that's Merry's admin-surface wiring, not a bug).

One shape got a real decision instead of a rubber stamp:

- **`UsageSchema.webSearchCount` now persists.** Added `"web_search"` to
  `UsageServiceSchema` and `"searches"` to `UsageUnitTypeSchema`
  (memory/types.ts) rather than leaving it structured-log-only — this is a
  real, distinctly-billed cost signal and the project already has a
  cost-audit table built exactly for this (`usage_log`, brief section 7's
  "$20-30/mo" budget tracking); logging it nowhere durable would silently
  under-report actual spend the moment web search fires. `usage_log`'s
  `service`/`unit_type` CHECK constraints updated in `memory/schema.ts` with
  a `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair (same
  already-live-table-needs-a-real-ALTER precedent as every other schema
  change in this table, just for a CHECK instead of a column — Postgres has
  no "ADD CHECK VALUE IF NOT EXISTS" shorthand). `pipeline/orchestrator.ts#runTurn`
  now writes a `usage_log` row alongside the existing structured log line,
  only when `webSearchCount` is truthy (no zero-unit rows).
