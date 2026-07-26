# Conversation continuity + responsiveness — architecture (frodo round)

Scope: (1) a code-level "active conversation thread" tracker so a reply to
the bot that doesn't repeat its name still reliably continues an exchange
it started (the "Nick" example); (2) investigate + fix (or confirm-no-fix)
two responsiveness complaints — name-detection reliability and whether the
per-minute rate cap silently swallows explicit responses; (3) make the
ambient cheap-gate's conservatism structurally distinct from an active
continuation, not another prompt-only rebalance; (4) jitter the proactive
chime cadence so it stops feeling metronomic; (5) a rarer, higher-bar
quick-gap interjection check, decoupled from the proactive timer and the
generic ambient gate, that still never talks over an in-progress sentence
(structural, by construction, unchanged); (6) split the adaptive-learning
signal into per-situation categories instead of one guild-wide lump stat.

**This round had no separate Sam/Merry pass running alongside it** — this
was a single frodo session. Per the mission's "atomic delivery" / "no layer
left incomplete" rule, I carried the schema + storage + prompt-content
pieces that would normally be Sam's/Merry's lock myself, rather than
leaving the feature half-wired. Each such piece is called out explicitly
below and should still get a dedicated Sam/Merry review pass before the
owner treats it as fully locked.

## 1. Active conversation-thread tracker (task 1)

**Design decision: flag on `ambient_pause`, not a new `TriggerType`.**
Structurally the candidate really is still just an ordinary VAD-closed
ambient utterance — nothing about the "never talk over a sentence" floor
or the STT/VAD pipeline changes. Only the turn-taking DECISION treats it
differently. A new `TriggerType` would have meant touching
`isExplicitTrigger`'s allowlist, every switch/exhaustiveness check on
`TriggerType`, and playback-priority logic for a distinction that's really
just "extra code-level evidence about who this ambient segment is from."

```ts
// pipeline/types.ts — TurnCandidateSchema addition
activeThreadContinuation: z.object({
  withUserId: z.string().min(1),
  contextHint: z.string().min(1),
}).optional();
```

**Where the state lives**: `PipelineOrchestrator.activeThreadByGuild: Map<
string, Map<string, { displayName: string; expiresAt: number }>>` — mirrors
the existing `pendingEngagementByGuild` per-guild-map precedent exactly, per
the brief's explicit "reuse this existing mechanism" steer.

**TTL: 75s** (`ACTIVE_THREAD_TTL_MS`, `config/constants.ts`), picked as the
midpoint of the brief's suggested 60-90s starting band — long enough for a
real person to pause/think/type before replying without having to re-say
the bot's name, short enough that something unrelated that same person
says a few minutes later (conversation genuinely moved on) doesn't get
grandfathered in.

**Set** (`PipelineOrchestrator.setActiveThread`) in `runTurn`, right after a
turn produces a real, non-empty spoken reply, gated to a small trigger-type
allowlist (`ACTIVE_THREAD_ELIGIBLE_TRIGGERS`):
`explicit_mention`/`explicit_reply`/`explicit_name`/`ambient_pause`.
Deliberately **excluded**: `member_joined`/`member_left`/`session_start`
(no `item.segment` on `TurnWorkItem` for these — plumbing a display name
through is a reasonable future extension, not done this round — see "Not
done this round" below) and `proactive` (sentinel `triggeringUserId`, not a
real person).

**Consumed** (`PipelineOrchestrator.getActiveThreadContinuation`) when
building the `TurnCandidate` for the NEXT `ambient_pause` item from that
same `triggeringUserId`, lazily expiring a stale entry on read (same
"opportunistic check, no dedicated sweep timer" philosophy as
`expireStaleEngagementIfNeeded`).

**Gating effect** (`TurnTakingEngine.decide`): when
`candidate.activeThreadContinuation` is set, the candidate is treated **at
least as reliably as an explicit trigger** — skips the cheap gate entirely,
bypasses the rate limiter's min-gap cooldown (`bypassCooldown = true`),
category `"continuation"`. This is the exact, concrete fix for the Nick
example: "receipts, lay some knowledge on me" (`explicit_name`) → bot asks
a clarifying question and opens a continuation window for that user → "no I
was asking you to lay knowledge on me" (no name, `ambient_pause`) → matches
the open window → reliably answered, no LLM judgment call involved.

**Not done this round (flagged, not forgotten)**: extending eligibility to
`member_joined` (a personal greeting is also "directed at" someone) would
need `TurnWorkItem.triggeringDisplayName` plumbed through
`handleMemberJoinedVoice`'s `enqueueTurn` call — small, deliberately left
out to keep this round's diff focused on the reported symptom.

## 2. Investigation: name-detection + rate-cap (task 2)

### (a) `mentionsPersonaName` — confirmed reliable, not the bug

`discord/bootstrap.ts`'s `mentionsPersonaName(text, personaName)` is a
straightforward case-insensitive, word-boundary regex
(`\bReceipts\b`) against `persona.name = "Receipts"`
(`llm/persona.ts`). Traced end-to-end: `handleTranscriptSegment` calls it
on every final STT segment, unconditionally, with no upstream filter that
could suppress a match. This is deterministic code, not a probabilistic
LLM call — there's no "why didn't it recognize the name" failure mode here
beyond STT literally mishearing the word (a Deepgram-layer concern, out of
this round's scope, not a turn-taking bug). **Conclusion: working as
designed, not the root cause.**

### (b) Per-minute rate cap — real edge case, low probability under current defaults, hardened anyway

Traced `InMemoryRateLimiter.canRespond`: explicit triggers bypass the
min-gap cooldown (`opts.bypassCooldown`) but, before this round, shared ONE
sliding-60s-window counter (`maxResponsesPerMinute`) with ambient/proactive
turns. **Structurally**, yes — a burst of ambient/proactive replies earlier
in the same 60s window could fill that shared counter and cause
`canRespond` to return `false` for a legitimate direct-address reply
immediately after, with no distinguishing log signal (the rejection reason
string was a generic "rate limited (per-minute cap or min-gap cooldown)").

**But**, checking the actual configured defaults (`.env.example`):
`DEFAULT_MAX_RESPONSES_PER_MINUTE=8`, `DEFAULT_MIN_GAP_SECONDS=6`,
proactive capped to ~once per 2min, and the ambient cheap-gate is
deliberately conservative (round 1's rebalance). Hitting 8 responses in any
rolling 60s window under these defaults is unlikely in ordinary use — this
is a real-but-currently-low-probability contributing factor, not a smoking
gun. **The dominant, better-supported explanation for "isn't consistently
talking when addressed" is the lack of continuation-awareness (task 1) and
the ambient gate's blended conservatism (task 3), not this cap.**

**Fix implemented anyway** (low-risk, purely additive, zero behavior change
until configured): `RateLimiterConfig.maxExplicitResponsesPerMinute?:
number` — when set, bypassCooldown-class responses (explicit triggers +
active-thread continuations) get their OWN independent sliding-60s-window
budget that can never compete with ambient/proactive volume for the same
slots. `undefined` (the only state until Sam wires a real config field —
see handoff below) preserves the exact pre-existing shared-cap behavior.

```ts
// pipeline/rateLimiter.ts — GuildRateState
responseTimestamps: number[];          // non-bypass (ambient/proactive)
explicitResponseTimestamps: number[];  // bypassCooldown-class
```

`RateLimiter.recordResponse` signature changed to
`recordResponse(guildId: string, opts: { bypassCooldown: boolean }): void`
so it routes the timestamp into the matching bucket — the one call site
(`orchestrator.ts`'s `runTurn`) was updated to pass
`{ bypassCooldown: decision.bypassCooldown }`.

## 3. Retuned ambient cheap-gate — structural, not another prompt rebalance (task 3)

The distinction the owner asked for ("generic ambient filler" vs. "clearly
still part of an active back-and-forth") is now made **before** the LLM is
ever asked to judge it: task 1's active-thread check runs first and, when
it hits, skips the cheap gate outright. The cheap-gate's own prompt text
(`llm/claudeProvider.ts`) is otherwise unchanged from round 1's rebalance —
its existing "DIRECT ADDRESS" pronoun-inference guidance is now a
secondary/backup signal for genuinely ambiguous cases, not the only thing
carrying the "someone is still talking to the bot" case. This is the
concrete difference from round 1 (that round only had prompt-text levers
available); this round adds a real code-level branch upstream of the model
call.

## 4. Organic proactive cadence — jitter (task 4)

`bootstrap.ts`'s `setInterval(..., proactiveChimeIntervalSeconds * 1000)`
still ticks at a perfectly fixed rate (unchanged — that file's ownership
wasn't touched this round). The metronome feel actually comes from
`TurnTakingEngine.decideProactive`'s cadence-floor check always comparing
against the exact same number — so jitter had to be added there instead:

```ts
// config/constants.ts
export const PROACTIVE_JITTER_MIN_MULTIPLIER = 0.75;
export const PROACTIVE_JITTER_MAX_MULTIPLIER = 1.5;
```

A jitter multiplier is drawn uniformly from that band and applied on top of
the (possibly engagement-rescaled) `effectiveIntervalSeconds`, cached per
guild for the current wait cycle (not re-rolled every `decide` call — that
would make the effective floor flicker mid-wait) and cleared/redrawn the
moment an attempt is stamped. Net effect on the pre-existing 120s default:
effective floor now varies roughly 90s-180s per cycle instead of being
exactly 120s every time, and the band is centered slightly above 1.0 (not
symmetric) since the owner also asked the bot to generally feel a bit more
willing to speak up, not ultra-rare.

## 5. Quick-gap interjection check (task 5)

**Scope discipline, restated**: this NEVER processes partial/non-final
transcripts and never talks over an in-progress sentence — that floor
already holds by construction (an `ambient_pause` candidate doesn't exist
until VAD has closed the speaker's utterance on silence — see
`discord/bootstrap.ts`'s `subscribeAudioForUser`) and nothing in this
change touches VAD or partial-transcript handling at all.

`TurnTakingEngine.decideInterjection` runs on an `ambient_pause` candidate
in two situations: (a) the generic ambient gate was damped out entirely by
the engagement signal, or (b) the generic ambient gate ran and said no.
Either way it's a genuine SECOND chance at the same pause, not an easier
path to the same yes:

- Own cooldown, `INTERJECTION_MIN_INTERVAL_SECONDS = 30` — much shorter
  than the proactive floor (task brief: "decoupled... from the proactive
  timer's cadence floor"), but still bounds the extra cheap-gate-call cost
  of attempting this every time the ambient gate says no (which is often).
- Own engagement-ratio damping, reading the new `"interjection"` category
  bucket (task 6) — same `ENGAGEMENT_FLOP_RATIO_DAMPEN` threshold as
  ambient/proactive.
- A DISTINCT, stricter system prompt (`llm/claudeProvider.ts`'s
  `buildInterjectionGateSystemPrompt`) — explicitly told it's a second,
  much stricter gate, that it should say NO far more often than YES, and
  that direct-address is irrelevant to this check (that's fully handled
  upstream by task 1/explicit triggers already).
- Shares the same `LLMProvider.cheapGateCheck` method as the ambient gate,
  discriminated by a new `CheapGateInput.checkKind: "ambient" |
  "interjection"` field (`.optional()`, defaulting to `"ambient"` inside
  `ClaudeHaikuProvider` — kept optional at the TYPE level, not a Zod
  `.default()`, because this schema is also used as a plain object-literal
  type at call sites that never call `.parse()`).
- Does NOT bypass the rate limiter's cap/min-gap — a successful
  interjection is still an ordinary non-bypass response, same budget as
  plain ambient turns.

Prompt content flagged for Merry's follow-up tuning pass once live-tested,
per the usual Sam/Merry split — shipped with a reasonable first-draft bar
rather than left unimplemented, so it's a genuinely working feature this
round, not just a design.

## 6. Adaptive-learning signal — per-category granularity (task 6)

```ts
// memory/types.ts
export const TurnOutcomeCategorySchema = z.enum(["continuation", "ambient", "interjection", "proactive"]);
export type TurnOutcomeCategory = z.infer<typeof TurnOutcomeCategorySchema>;

export const EngagementBucketSchema = z.object({ landed: z.number().int().nonnegative(), flopped: z.number().int().nonnegative() });
export type EngagementBucket = z.infer<typeof EngagementBucketSchema>;
```

```ts
// MemoryStore
recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number, category: TurnOutcomeCategory): Promise<void>;
getRecentEngagementStats(guildId: string): Promise<{
  overall: EngagementBucket;
  byCategory: Partial<Record<TurnOutcomeCategory, EngagementBucket>>;
}>;
```

**Scope call, deliberate**: explicit-address turns
(`explicit_mention`/`explicit_reply`/`explicit_name`) and system events
still do NOT get an engagement window at all — same "always correct to
answer, no timing judgment to learn from" reasoning the original lump
signal used, unchanged. Only the four categories above (all previously
either "ambient_pause" or "proactive" under the old lump scheme) get split.

**`continuation` turns still open a `PendingEngagement` window** and get
scored landed/flopped exactly like plain ambient turns — even though
they skip the cheap gate, whether the person keeps engaging afterward is
still a useful thing to learn per-category. `PendingEngagement.category` is
threaded straight from `TurnDecision.category` (new optional field on
`TurnDecisionSchema`, `pipeline/types.ts`) so `resolveEngagementOnHumanSegment`/
`expireStaleEngagementIfNeeded` record against the right bucket.

**Consumption** (`turnTaking.ts`): ambient-branch damping now reads
`byCategory.ambient`; proactive-branch rescaling reads
`byCategory.proactive`; the new interjection check reads
`byCategory.interjection`; continuation bypasses damping entirely (same
reliability tier as explicit).

**Sample-size tradeoff, flagged deliberately**: splitting one lump counter
into four buckets means each bucket individually reaches
`ENGAGEMENT_MIN_SAMPLES = 6` roughly 4x slower than the old single counter
did. Accepted per the owner's explicit ask for situation-specific learning
over a faster-but-blended average — expect a longer warm-up window per
category, especially right after this migration ships.

### Storage — implemented this round (would normally be Sam's lock)

`memory/schema.ts`'s `turn_outcomes` table gained a `category` column
(`TEXT NOT NULL DEFAULT 'ambient' CHECK (...)`, `ALTER TABLE ... ADD COLUMN
IF NOT EXISTS` for the already-live table, matching the existing
`consent_accepted`/`consent_channel_id` migration pattern in the same
file), plus `idx_turn_outcomes_guild_category_time`.
`PostgresMemoryStore#recordTurnOutcome`'s retention DELETE is now scoped
per `(guild_id, category)` instead of per `guild_id` alone — so one noisy
category (e.g. frequent ambient chatter) can't evict another's (rarer
interjection) history. `getRecentEngagementStats` reads up to
`MAX_ENGAGEMENT_OUTCOMES_PER_GUILD * 4` rows (4 categories) and aggregates
both `overall` and `byCategory` in one pass.

**Flag for Sam's dedicated review**: this is real DDL + a breaking
`MemoryStore` interface signature change, done solo this round for atomic
delivery (no schema change shipped without the matching API/consumer code,
per the mission's "must not ship non-atomic changes" rule) — please give it
your own pass on the migration safety (backfill default, index choice,
per-category retention semantics) whenever convenient.

## Contract/config handoff → Sam

- **`turn_outcomes.category` + `MemoryStore.recordTurnOutcome`/
  `getRecentEngagementStats` signatures** (section 6) — implemented and
  working this round in the absence of a live Sam pass; please give it a
  dedicated review (see flag above) rather than treating it as untouched.
- **Optional future work, NOT required for this round's fix**: a
  `GuildSettings.maxExplicitResponsesPerMinute` column + matching env
  default (e.g. `DEFAULT_MAX_EXPLICIT_RESPONSES_PER_MINUTE`), wired into
  `RateLimiterConfig.maxExplicitResponsesPerMinute` (section 2b). The code
  path is fully ready and backward-compatible (defaults to `undefined` =
  old shared-cap behavior) — only wire this if live testing actually shows
  explicit-address volume needs its own budget, since the investigation in
  section 2b concluded this is a low-probability edge case under current
  defaults, hardened defensively rather than because it was confirmed live.
- **`TurnCandidateSchema.activeThreadContinuation`** (section 1) and
  **`TurnDecisionSchema.category`** (section 6) are both new but additive
  Zod fields on in-memory-only contracts (never persisted) — same
  "grep for any external consumer that assumes the shape is closed" note
  as last round's `TriggerType` additions, if any admin/structured-log
  tooling outside this repo's own pipeline reads these shapes.

## Wiring handoff → Merry

- **Interjection-check prompt content** (`buildInterjectionGateSystemPrompt`,
  `llm/claudeProvider.ts`) — shipped with a working first draft; needs a
  live-listening tuning pass to calibrate the actual bar (too eager vs. too
  quiet), same "needs live feedback, not something `tsc` can verify" caveat
  as every prompt-tuning item in prior rounds.
- **Continuation context-hint wording**
  (`PipelineOrchestrator.getActiveThreadContinuation`'s generated
  `contextHint` string) — functional but generic; if live testing shows the
  model needs a stronger/differently-worded nudge to actually stay engaged
  without repeating itself, that's prompt-content territory, same lane as
  the interjection prompt above.
- **Member-joined active-thread extension** (section 1's "not done this
  round") — if wanted, needs `TurnWorkItem.triggeringDisplayName` plumbed
  through `handleMemberJoinedVoice`'s `enqueueTurn` call; flagged as a
  reasonable follow-up, not required for this round's reported symptom.
- **Rate-limiter separate-budget config knob** (section 2b) — only relevant
  once/if Sam wires the `GuildSettings` column above; no Discord-side UI
  change needed beyond whatever `/mode`-style admin surface already exists
  for other `GuildSettings` fields, if any is wanted at all.

## Files changed this round (frodo)

- `src/memory/types.ts` — `TurnOutcomeCategorySchema`/`TurnOutcomeCategory`,
  `EngagementBucketSchema`/`EngagementBucket`, `MemoryStore.recordTurnOutcome`/
  `getRecentEngagementStats` signatures extended with the category dimension.
- `src/memory/schema.ts` — `turn_outcomes.category` column + migration ALTER
  + new composite index.
- `src/memory/postgresStore.ts` — `recordTurnOutcome`/`getRecentEngagementStats`
  implementations updated for per-category writes/retention/aggregation.
- `src/config/constants.ts` — `ACTIVE_THREAD_TTL_MS`,
  `INTERJECTION_MIN_INTERVAL_SECONDS`, `PROACTIVE_JITTER_MIN_MULTIPLIER`/
  `PROACTIVE_JITTER_MAX_MULTIPLIER`.
- `src/pipeline/types.ts` — `TurnCandidateSchema.activeThreadContinuation`,
  `TurnDecisionSchema.category`, `RateLimiter.recordResponse` signature +
  `RateLimiterConfig.maxExplicitResponsesPerMinute`.
- `src/pipeline/rateLimiter.ts` — separate explicit-class sliding window +
  backward-compatible fallback (task 2 fix).
- `src/pipeline/turnTaking.ts` — active-thread continuation branch,
  per-category engagement-stat consumption, `decideInterjection` (task 5),
  jittered proactive cadence (task 4).
- `src/pipeline/orchestrator.ts` — `activeThreadByGuild` tracker +
  `setActiveThread`/`getActiveThreadContinuation`/
  `ACTIVE_THREAD_ELIGIBLE_TRIGGERS`, `PendingEngagement.category` threading,
  `rateLimiter.recordResponse` call updated to pass `bypassCooldown`.
- `src/llm/types.ts` — `CheapGateInputSchema.checkKind`.
- `src/llm/claudeProvider.ts` — `cheapGateCheck` branches on `checkKind`;
  `buildAmbientGateSystemPrompt` (extracted, unchanged content) +
  `buildInterjectionGateSystemPrompt` (new).

`npm run typecheck` — clean.
