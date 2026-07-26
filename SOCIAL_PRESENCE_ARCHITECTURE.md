# Persona rename + join/leave greetings + adaptive cadence — architecture (frodo round)

Scope: (1) persona actually named "Receipts" instead of the placeholder
"the bot"; (2) greet a new/returning person when they join a voice channel
the bot is already in, using their memory profile if they have one; (3) a
general "hey everyone" once per fresh `/join`/auto-join connection; (4) a
snarky (never mean) remark when someone leaves; (5) a lightweight,
non-ML adaptive-cadence signal that damps (and, for the proactive timer,
also relaxes) how eager the bot is to speak based on whether recent
ambient/proactive turns actually landed. This doc covers the whole plan;
**frodo implemented items 1, 2, 4 (backend half), 5 (backend half) fully**
(persona + pipeline core: `pipeline/types.ts`, `pipeline/orchestrator.ts`,
`pipeline/turnTaking.ts`, `memory/types.ts`, `memory/postgresStore.ts`).
Item 3's mechanism is implemented (`announceSessionStart`); its actual call
site inside `startVoicePipeline` and item 2/4's actual Discord
`VoiceStateUpdate` detection are handed to **Merry** (wiring). Item 5's
prompt-framing consumption (if any is wanted beyond what's already
implemented) and the "banter"/"argue" style-menu expansion are also
**Merry**'s. No new contract/config field is needed from **Sam** this
round *to make the feature work end-to-end* — the one genuinely new
storage surface (`MemoryStore.recordTurnOutcome`/`getRecentEngagementStats`)
already has a working (if non-durable) implementation; Sam's ask is to
promote it to real Postgres persistence when convenient, not to unblock
functionality.

## 1. Persona rename

`DEFAULT_PERSONA.name` → `"Receipts"` (`src/llm/persona.ts`). Verified every
consumer is already parameterized off `persona.name`, not hardcoded:
- `discord/bootstrap.ts`'s `mentionsPersonaName(text, this.deps.persona.name)`.
- `llm/claudeProvider.ts`'s cheap-gate and generation system prompts
  (`input.persona.name` / `request.persona.name`), both in the "DIRECT
  ADDRESS" and "own recent lines are labeled ...:" clauses.
- Transcript labeling — `appendBotReply` sets `displayName: this.deps.persona.name`.

So the rename alone flows through structurally, confirmed by grep + read,
not just asserted. Added one clause to `systemPrompt` regardless —
`"Your name is Receipts."` — up front, as a stated identity fact rather
than something only inferable from how the prompt happens to address the
persona elsewhere. Reasoning: models answer "what's your name?"/self-intro
requests (relevant now that greetings are a first-class feature) more
reliably from an explicit sentence than from field-level naming alone.

## 2. New-member / returning-member greeting — mechanism

New `TriggerType` value `"member_joined"` (`pipeline/types.ts`), fired by a
new orchestrator method:

```ts
async handleMemberJoinedVoice(guildId: string, channelId: string, userId: string, displayName: string): Promise<void>
```

**Design choice: real `triggeringUserId`, not a sentinel.** Unlike
`"proactive"` (which has no real speaker and uses `PROACTIVE_TRIGGER_USER_ID`),
this method attributes a **synthetic transcript segment** to the joining
user's actual Discord id:

```ts
{ id, guildId, channelId, userId, displayName, text: "(joined the voice channel)", isFinal: true, confidence: 1, startedAt: now, endedAt: now }
```

appended via the existing `appendHistory` (same mechanism `appendBotReply`
already uses to get the bot's own lines into history — this just reuses it
for a different attribution). Because `ContextAssembler.assemble` already
derives its per-speaker memory lookups from `userId`s appearing in the
recent transcript window (`speakerIds = ... recentTranscript.map(s => s.userId)`),
this synthetic segment makes the joining user's `UserMemoryProfile` show up
in `LLMRequest.memoryContext` **with zero new plumbing** — no new field on
any contract, no bypass path. This was the single biggest "reuse existing
plumbing beats inventing a parallel path" win this round.

**Is bypassing the cooldown right?** Yes — the brief explicitly asks for
this (rare, bounded, clearly-intentional event, not spam) — so
`"member_joined"` was added to `isExplicitTrigger`'s allowlist. This means:
skips the cheap gate entirely (always "speaks" once queued), bypasses the
min-gap cooldown, but **still fully respects the per-minute rate cap**
(`RateLimiter.canRespond`'s `bypassCooldown` only ever skips the gap, never
the cap — verified unchanged from last round). Gets `"explicit"` playback
priority too (`runTurn`'s `priority` line), same as a direct mention.

**Queue interaction (5 people joining at once):** `enqueueTurn`'s
newest-wins-depth-1 rule (unchanged) means if several `member_joined`
candidates arrive while a turn is in flight, only the **last** one survives
to actually run — earlier ones are silently dropped, same as any other
non-explicit-vs-non-explicit or explicit-vs-explicit collision today. This
satisfies "can't blow past the cap" but means not everyone joining in a
tight burst gets an individual greeting. Documented tradeoff, not
"solved" — matches the brief's own "still respect [the cap]" framing over
"greet literally everyone."

### Returning vs. new vs. never-consented — how the distinction actually happens

**No new LLM-contract field.** `TurnCandidateSchema` gained one new optional
field, `contextHint?: string` (`pipeline/types.ts`) — free text that,
when present, `TurnTakingEngine.decide`'s explicit-trigger branch uses
**verbatim** as `TurnDecision.reason` instead of the generic
`` `explicit trigger (${type})` `` string. `TurnDecision.reason` already
flows straight into `ContextAssembler.assemble`'s `triggerReason` param →
`LLMRequest.triggerReason` → the `"Why you're responding now: ..."` line in
`claudeProvider.ts`'s `generateResponse` user content. So the *entire*
returning-face/first-timer/never-consented distinction lives in
`contextHint`'s wording, computed once in `handleMemberJoinedVoice`:

```ts
const consented = await this.deps.memory.hasAcceptedConsent(guildId, userId);
const profile = consented ? await this.deps.memory.getProfile(guildId, userId) : undefined;
const hasMemory = !!profile && (profile.facts.length > 0 || profile.runningJokes.length > 0 || !!profile.sentimentNotes);
```

Three branches:
1. **Not consented yet** — "...has not accepted the voice-listening consent
   notice yet, so you have no real memory of them and must not invent
   any — give a brief, generic, friendly hello..., mention they can click
   Accept..."
2. **Consented, has memory** — "...you've talked with them before — greet
   them like a returning face, briefly referencing something you
   genuinely remember..."
3. **Consented, no memory yet** — "...you don't have anything memorable
   stored about them yet, give a brief, friendly first-time-style
   introduction..."

### Privacy gating — deliberately asymmetric join vs. leave (documented, not an oversight)

- **Opted-out** (`isOptedOut`): skip entirely, both join and leave. Same
  hard exclusion as the rest of the pipeline.
- **Never-consented, JOIN**: still greet, generically (branch 1 above).
  Reasoning: gating this the same hard way `handleSegment` gates STT would
  silence the exact "introduce yourself to someone new" scenario the
  brief asks for — a brand-new user's very first join is, structurally,
  *always* a never-consented join (they haven't seen the notice yet).
  Facts genuinely cannot exist for a never-consented user given this
  codebase's current write paths (`extractAndPersistMemory` only ever runs
  off a `handleSegment` call, which itself requires consent) — the
  explicit "must not invent any" instruction in the prompt is defense in
  depth on top of that structural guarantee, not the only thing preventing
  fabrication.
- **Never-consented, LEAVE**: skip entirely (see section 4) — the opposite
  choice from join, because a farewell has no onboarding upside for
  someone the bot never had standing to listen to.

## 3. Default `/join` greeting

```ts
async announceSessionStart(guildId: string, channelId: string): Promise<void>
```

New `TriggerType` `"session_start"` (also explicit — skip gate, bypass
cooldown, respect cap). Uses the `SESSION_START_TRIGGER_USER_ID` sentinel
(mirrors `PROACTIVE_TRIGGER_USER_ID`'s pattern) since there's no specific
person to attribute to — **no synthetic transcript segment is appended**
for this one, unlike join/leave. `contextHint`: "You just connected to this
voice channel via /join — give a brief, general hello to whoever's
listening. Don't address any one specific person or claim to remember
anyone yet."

**Recommended call site (Merry): inside `startVoicePipeline`** in
`discord/bootstrap.ts`, right after `state.proactiveTimer =
this.startProactiveTimer(guildId, channelId)` (i.e., once the connection +
playback are attached and per-guild state exists). This is one call site
covering **both** an explicit `/join` command (`commands/join.ts` →
`ctx.services.startVoicePipeline`) **and** auto-join-on-entry — deliberately
chosen over duplicating the hook in `commands/join.ts` alone, so behavior
stays consistent regardless of what caused the connection. Reuses the same
turn-queue/rate-limiter/logging path as everything else (recommended
explicitly by the brief) rather than a bare direct-TTS call — consistency,
and a rapid rejoin can't spam greetings past the shared per-minute cap
either.

## 4. Snarky farewell on leave

```ts
async handleMemberLeftVoice(guildId: string, channelId: string, userId: string, displayName: string): Promise<void>
```

New `TriggerType` `"member_left"` (explicit, same rules as `member_joined`).
Same synthetic-segment mechanism as join (`text: "(left the voice
channel)"`, real `userId`) — mostly so a farewell can still reference
something remembered ("well good, didn't want to hear about your fantasy
football team anyway" requires memory context) via the same
speaker-based lookup, not because a leave event itself needs a memory
profile to fire.

`contextHint`: "...give a brief, snarky/playful remark about it (never
genuinely mean, never targeting real sensitive traits...). If the recent
conversation felt genuinely serious or heavy, dial it back to something
warmer or lower-key instead, per your usual guardrail."

**Meanness guardrail — no special-case code.** The persona's existing
system-prompt guardrail (`llm/persona.ts`: "never genuinely mean... drop
the sarcasm and go warm if someone seems genuinely upset") already applies
uniformly to every `generateResponse` call, farewells included, since this
reuses the *exact* same generation path as everything else — no new
prompt logic was written for this. **Flagged as a nuance, not fully
solved**: judging "was the recent conversation genuinely serious" from
transcript context alone is imperfect model judgment, same category of
risk as last round's cheap-gate rebalance — needs live listening feedback,
not something `tsc` can verify.

## 5. Adaptive-cadence learning layer

**Scope, stated plainly: not a machine-learning pipeline.** A per-guild
rolling landed:flopped ratio that nudges an existing decision point.

### Operational definitions (exact)

For a **non-explicit** bot turn only — `"ambient_pause"` or `"proactive"`;
explicit triggers (direct request) and system events (member_joined/
member_left/session_start) are excluded, since none of those are a
"was this a good moment to speak" timing judgment:

- **landed**: within `ENGAGEMENT_FOLLOWUP_WINDOW_MS` (45s,
  `pipeline/orchestrator.ts` local constant) after the bot's reply finishes
  playing, a human (consented, non-opted-out — the only kind that ever
  reaches `handleSegment`) final transcript segment is observed that
  **started at or after** the bot's reply finished.
- **flopped**: either (a) the window elapses with no such segment
  (silence), or (b) a human segment arrives that **started before** the
  bot's reply finished playing (talked over) — this is deliberately
  classified as a flop even though a human *did* speak, per the brief's own
  wording ("silence followed, or someone talked over it").

### Where the bookkeeping lives (`pipeline/orchestrator.ts`)

One open window per guild, `pendingEngagementByGuild: Map<string,
{ botSpeechEndedAt, deadline }>`:
- **Set** in `runTurn`, right after the TTS/playback try/catch, only for
  `"ambient_pause"`/`"proactive"` turns. Overwrites (silently discards,
  unresolved) any still-open window from an earlier turn — a superseding
  bot turn makes the prior window's outcome ambiguous, so it's dropped
  rather than misattributed.
- **Resolved** by `resolveEngagementOnHumanSegment`, called from the top of
  every `handleSegment` — compares the incoming segment's `startedAt`
  against the pending window's `botSpeechEndedAt` to classify
  landed/flopped per the definitions above, then calls
  `memory.recordTurnOutcome`.
- **Expired** by `expireStaleEngagementIfNeeded`, called from the top of
  both `handleSegment` and `maybeFireProactiveTurn` (the latter ticks
  periodically while connected, independent of ambient activity, per
  bootstrap.ts's timer) — no dedicated background timer was added; these
  two existing call-frequency points are enough to catch an expired window
  in reasonable time. A soft learning signal resolving a little late during
  a fully silent stretch is an acceptable tradeoff.

### Storage — handoff to Sam

New `MemoryStore` methods (`memory/types.ts`), plus `TurnOutcomeSchema =
z.enum(["landed", "flopped"])`:

```ts
recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number): Promise<void>;
getRecentEngagementStats(guildId: string): Promise<{ landed: number; flopped: number }>;
```

**Already implemented and functional** in `PostgresMemoryStore` — but as a
**temporary in-process ring buffer** (`engagementOutcomes: Map<string,
TurnOutcome[]>`, capped at `ENGAGEMENT_RING_SIZE = 40` per guild), **not
yet persisted to Postgres**. It resets on every bot restart. This was a
deliberate choice to ship a fully working feature this round without
blocking on a new migration — Sam's ask, whenever convenient: promote to a
real table (e.g. `turn_outcomes(guild_id, outcome, occurred_at)`, or a
rolled-up counter row with periodic decay) so the signal survives restarts.
The interface/semantics above shouldn't need to change either way — the
consumer (`TurnTakingEngine`) only ever reads the two aggregate counts, and
already treats a low/zero sample count as "no signal yet" rather than an
implicit 0% landed rate (see below) — so a durable vs. in-process backing
store is a pure implementation-detail swap.

### Consumption — `pipeline/turnTaking.ts` (implemented)

```ts
const ENGAGEMENT_MIN_SAMPLES = 6;
const ENGAGEMENT_FLOP_RATIO_DAMPEN = 0.7;
const ENGAGEMENT_LANDED_RATIO_BOOST = 0.7;
const PROACTIVE_INTERVAL_DAMPEN_MULTIPLIER = 1.5;
const PROACTIVE_INTERVAL_BOOST_MULTIPLIER = 0.75;
const PROACTIVE_INTERVAL_BOOST_FLOOR_SECONDS = 60;
```

- **Ambient branch (`decide`)**: fetches `getRecentEngagementStats`,
  computes `flopRatio = flopped / (landed + flopped)` (only if
  `landed + flopped >= ENGAGEMENT_MIN_SAMPLES`, else treated as "no
  signal"). If `flopRatio >= 0.7`, decline **before** spending a cheap-gate
  call — "recent chime-ins mostly went unanswered — staying quieter for
  now." **One-directional deliberately**: no amplification lever exists for
  ambient (there's no interval to shrink, only a gate to skip) — forcing
  *more* ambient turns off a good streak risks regressing "talks too much,"
  which is exactly the complaint this whole feature line started from last
  round. Damping down is safe; amplifying is not, this round.
- **Proactive branch (`decideProactive`)**: rescales
  `effectiveIntervalSeconds` (the existing per-guild cadence floor) by the
  same ratio *before* checking it against time-since-last-attempt — ×1.5
  when flopping badly, ×0.75 (floored at 60s) when landing well.
  Two-directional here, since proactive already has an explicit numeric
  interval to stretch or shrink rather than a binary yes/no gate.

No `CheapGateInput`/`LLMRequest` field was added for this — the mechanism
is entirely a decision-layer (turnTaking.ts) concern, not a prompt-content
one, so it needed zero new LLM contract surface. If Merry wants the
cheap-gate's own prompt framing to *also* reflect the recent ratio (e.g.
softening the "default to reluctant" language further when things have
been landing well), that would be an *additional* enhancement on top of
what's shipped, not required for the mechanism to work — flag to Sam only
if that structured field actually gets added.

### What this round does NOT do (explicitly out of scope, flagged not solved)

- **Style-mode selection** ("compliment vs roast vs banter vs argue vs
  chiming in vs replying") is NOT part of this cadence layer — that's
  covered by last round's `RESPONSE_STYLE_MODES` menu + rolling
  `recentTones` history, and this round's ask to expand it with
  "banter"/"argue" (Merry, claudeProvider.ts). The learning signal here is
  purely about *when*, not *which move*.
- No per-guild persistence across restarts yet (see storage handoff above).
- No UI/admin surface to inspect the landed:flopped ratio — if that's
  wanted (e.g. an `/admin` HTTP route), that's a new, separate ask.

## Contract/config handoff → Sam

- **`MemoryStore.recordTurnOutcome`/`getRecentEngagementStats`**
  (`memory/types.ts`) — schema/method shape above is locked as far as
  `TurnTakingEngine`'s consumption is concerned; only the *storage backing*
  in `PostgresMemoryStore` needs upgrading from the temporary in-process
  ring buffer to real Postgres persistence, at your discretion on
  timing/priority.
- **No other schema/config changes this round** — `contextHint` lives on
  the in-memory `TurnCandidateSchema` only (never persisted), and the three
  new `TriggerType` values are additive to an existing Zod enum (same
  pattern as last round's `"proactive"` addition) — please grep for any
  `TriggerType`/`TriggerTypeSchema` consumer outside this repo's own
  pipeline (admin dashboards, structured-log queries) that might assume the
  enum is still closed to the pre-this-round set of 8 values.

## Wiring handoff → Merry

- **`discord/bootstrap.ts`'s `VoiceStateUpdate` listener** needs new
  branches alongside the existing auto-join-on-entry one:
  - A non-bot member's `channelId` transitions **into** a channel the bot
    is already connected to in that guild (`this.guildStates.has(guildId)
    && state.voiceChannelId === newState.channelId && oldState.channelId
    !== newState.channelId`) → resolve their display name (reuse the
    existing `resolveDisplayName`) → `await
    this.deps.orchestrator.handleMemberJoinedVoice(guildId, channelId,
    userId, displayName)`.
  - A non-bot member's `channelId` transitions **out of** that same
    channel (`oldState.channelId === state.voiceChannelId && newState.channelId
    !== oldState.channelId`) → `await
    this.deps.orchestrator.handleMemberLeftVoice(guildId, channelId,
    userId, displayName)`.
  - Filter `newState.member?.user.bot` / `oldState.member?.user.bot` in
    both, same as the existing auto-join branch.
  - **Open nuance, not solved**: when auto-join-on-entry fires
    `startVoicePipeline` *because of* a specific user's entry, that same
    user's join would also match the "member_joined" branch above,
    potentially producing two back-to-back bot lines (the general
    `announceSessionStart` hello + a personal greeting) for one event.
    Consider a small debounce (skip the personal greeting for the
    triggering `(guildId, userId)` for a few seconds after a fresh
    `startVoicePipeline` call) if that reads as redundant once you hear it
    live — flagged, not fully solved, same spirit as this round's other
    "needs live listening" items.
- **`startVoicePipeline`** — add the `announceSessionStart` call (see
  section 3's exact recommended placement).
- **Prompt content**:
  - Expand `RESPONSE_STYLE_MODES` (`claudeProvider.ts`) with explicit
    "banter" and "argue" modes, per the owner's wording — same named-menu
    pattern as the existing six.
  - Consider (optional, not required for correctness) a light addition to
    `generateResponse`'s system prompt noting that when `triggerReason`
    indicates a greeting/farewell/introduction moment, the model should
    actually say something rather than fall back to `{"text": ""}` — right
    now nothing distinguishes "this is a rare, expected moment to speak" in
    the prompt from "this is just another ambient turn where staying quiet
    is often correct." Not implemented here — `generateResponse`'s system
    prompt was deliberately left untouched by frodo, same precedent as last
    round.
  - Any additional cheap-gate prompt-framing tied to the engagement ratio,
    if wanted beyond the decision-layer damping already shipped (see
    Section 5's "what this round does NOT do").

## Files changed this round (frodo)

- `src/llm/persona.ts` — `DEFAULT_PERSONA.name` → `"Receipts"`, explicit
  "Your name is Receipts." clause added to `systemPrompt`.
- `src/pipeline/types.ts` — three new `TriggerType` values
  (`member_joined`/`member_left`/`session_start`), `SESSION_START_TRIGGER_USER_ID`
  sentinel, `TurnCandidateSchema.contextHint` (optional), `isExplicitTrigger`
  extended to the three new types.
- `src/pipeline/orchestrator.ts` — `TurnWorkItem.contextHint`,
  `handleMemberJoinedVoice`, `handleMemberLeftVoice`, `announceSessionStart`,
  `pendingEngagementByGuild` + `resolveEngagementOnHumanSegment` +
  `expireStaleEngagementIfNeeded` (adaptive-cadence bookkeeping), engagement
  window opened in `runTurn` for ambient/proactive turns only, `contextHint`
  threaded onto the `TurnCandidate` built in `runTurn`.
- `src/pipeline/turnTaking.ts` — `contextHint` used as the explicit-trigger
  `reason` override; engagement-ratio damping in `decide`'s ambient branch;
  engagement-ratio interval rescaling in `decideProactive`; `computeFlopRatio`
  helper.
- `src/memory/types.ts` — `TurnOutcomeSchema`/`TurnOutcome`,
  `MemoryStore.recordTurnOutcome`/`getRecentEngagementStats`.
- `src/memory/postgresStore.ts` — temporary in-process ring-buffer
  implementation of the two new methods (see Section 5's storage handoff).

`npm run typecheck` — clean.
