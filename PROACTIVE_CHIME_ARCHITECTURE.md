# Proactive chime-in + tonal variety + cheap-gate rebalance — architecture (frodo round)

Scope: fix "doesn't talk when it should / talks when unaddressed / talks too
much or too little / every response feels the same." This doc covers the
whole plan; **frodo implemented items 1-3 fully** (pipeline core + cheap-gate
rebalance). Items 4-5 are handed to Sam (contract lock) and Merry (wiring +
prompt-variety + presence hookup).

## 1. Proactive trigger — mechanism

New `TriggerType` value `"proactive"` (`src/pipeline/types.ts`). Fired by a
new orchestrator method:

```ts
async maybeFireProactiveTurn(guildId: string, channelId: string): Promise<void>
```

Intended caller: something that tracks voice-channel presence, invoked
periodically (e.g. every 15-30s) **only** while the bot is connected to a
voice channel with at least one human present. That gate — "is anyone
actually in the channel" — lives with the caller (Merry:
`discord/voice/connectionManager.ts` or wherever presence is tracked), NOT
inside the orchestrator. Reasoning: the orchestrator's in-memory transcript
history (`historyFor(guildId)`) is already consent-filtered by construction
— `handleSegment` only ever appends segments from users who passed
`hasAcceptedConsent`/`!isOptedOut` — so re-deriving a participant list
inside `maybeFireProactiveTurn` would be redundant DB calls on every timer
tick for no extra safety. "Nothing to react to" is instead caught by a cheap
heuristic downstream (see section 2).

**Feeds through the existing per-guild `GuildTurnQueue`, not a bypass.**
`handleSegment`'s queue was generalized from `{segment, triggerType}` to a
`TurnWorkItem` (`{guildId, channelId, triggerType, triggeringUserId,
segment?}`) — `segment` is `undefined` for proactive turns. Same
`enqueueTurn`/`drainTurnQueue`/`runTurn` machinery handles both. The
"pending explicit mention outranks incoming non-explicit candidate" special
case (bugs/nazgul round fix) is preserved verbatim and now also protects
against a proactive candidate clobbering a queued explicit mention.

## 2. Does proactive bypass cooldown, or go through a lighter gate?

**Recommendation implemented: lighter gate, NOT a cooldown bypass.**
`isExplicitTrigger("proactive")` returns `false` — proactive turns are fully
subject to the rate limiter's per-minute cap AND min-gap cooldown, exactly
like ambient turns. On top of that, `TurnTakingEngine.decide` branches on
`triggerType === "proactive"` into a dedicated `decideProactive`:

1. **Per-guild cadence floor** (`proactiveIntervalSeconds`, config knob —
   see section 4): if less than this many seconds have elapsed since the
   last proactive *attempt* (success or not) for this guild, decline
   immediately — zero cost, no LLM call. Stamped as soon as an attempt
   clears this floor, before the heuristic/gate call resolves, so at most
   one attempt happens per interval regardless of how often the caller
   polls.
2. **Recent-human-activity heuristic** (no LLM call): scans
   `candidate.segments` (the same rolling history ambient turns see) for any
   non-bot, final, non-empty segment within the last 90s
   (`PROACTIVE_ACTIVITY_LOOKBACK_MS`, a local implementation constant, not a
   config knob). If nothing qualifies, decline — this is what stops the bot
   chiming into silence or an empty channel, at zero API cost.
3. **Lighter cheap-gate call**: reuses the same `llm.cheapGateCheck`
   interface/method the ambient path uses (no new LLMProvider method needed
   — see section 3 for why the shared prompt still works for both callers).

This was chosen over bypassing cooldown because the owner's complaint is
"talks too much" as much as "doesn't talk enough" — an unconditional-yes
proactive path stacked on top of organic ambient chatter would be the
single easiest way to regress the too-much side while fixing the
too-little side.

## 3. Cheap-gate prompt rebalance (`src/llm/claudeProvider.ts`)

The gate's system prompt previously opened with "Default strongly to YES...
say yes for almost anything... only say no in the rare case where jumping
in would clearly talk over someone" — a blanket yes-bias, likely root cause
of "talks when unaddressed / talks too much." This call is now shared by
**both** ambient_pause and proactive candidates, so the bias mattered even
more.

Rebalanced (kept, not reverted — the direct-address section that makes
implicit addressing like "what do you think?" resolve to yes was NOT
touched, that's a different failure mode and still needs to stay
yes-biased):
- Replaced the blanket "yes for almost anything" with named YES conditions
  (direct address, a joke/reaction opportunity, a group question, a fresh
  topic) and named NO conditions (nothing new since the bot's own last
  line, low-content filler, would talk over someone, genuinely
  serious/sensitive moment).
- Added an explicit tie-breaker: "when it's a genuinely close call... prefer
  staying quiet."
- Left the DIRECT ADDRESS section and the "don't repeat yourself" section
  untouched verbatim.

This is a single shared prompt for both call sites deliberately — no new
`CheapGateInput` field was added to distinguish "why am I being asked" (that
would be a Sam-owned contract change). The proactive path's own heuristic
pre-check (section 2, step 2) is what actually differentiates "is there
something to riff on" for that caller; the shared prompt just needs to not
be a blanket yes, which now serves both callers correctly.

## 4. Contract handoff → Sam

- **Lock `TriggerTypeSchema`'s new `"proactive"` value** (`src/pipeline/types.ts`)
  — implemented already (Zod enum + updated `isExplicitTrigger`, now an
  explicit allowlist instead of "everything except ambient_pause" — the old
  inverse form would have silently misclassified `"proactive"` as explicit).
  Please grep for any other `TriggerTypeSchema`/`TriggerType` consumer
  (admin dashboards, structured-log queries) that might assume the enum is
  closed to the original 4 values.
- **New config field**: process-wide (not per-guild — matches the existing
  `DEFAULT_AUTO_JOIN_ON_USER_ENTRY` precedent in `config/types.ts`) knob for
  proactive-chime cadence. Proposed name: `DEFAULT_PROACTIVE_CHIME_INTERVAL_SECONDS`
  env var → `AppConfig.defaults.proactiveChimeIntervalSeconds`, `z.coerce.number().int().positive()`,
  default `120`. A matching `FALLBACK_PROACTIVE_CHIME_INTERVAL_SECONDS = 120`
  in `config/constants.ts` would let `orchestrator.ts`'s local fallback
  constant (currently `DEFAULT_PROACTIVE_INTERVAL_SECONDS` in
  `turnTaking.ts`, chosen as 120 to match the owner's "~once per 2 minutes"
  ask) move there for consistency — not required, just tidier.
  `OrchestratorDeps.proactive?: { intervalSeconds: number }` is already
  **optional** precisely so this can land without a breaking change at the
  `index.ts` construction site.
- **No new `LLMRequest`/`CheapGateInput` field was added** for style hints
  — that's explicitly Merry's mechanism to design (tone-variety prompt
  work), but if Merry's implementation needs the generator to know "this is
  a proactive turn, not a direct reply," `LLMRequest.triggerReason` (already
  a free-text field, populated from `decision.reason`) already carries that
  signal today (e.g. `"no recent human activity to riff on"` never reaches
  generation since it's a decline, but a successful proactive decision's
  reason is the cheap-gate's own text) — flag to Merry whether that's
  sufficient or whether a structured `triggerType` field on `LLMRequest`
  would be cleaner.

## 5. Wiring handoff → Merry

- **Hook the timer to real presence tracking.** Nothing in
  `discord/voice/connectionManager.ts` currently tracks who's in a voice
  channel — `VoiceConnectionManager` only knows connect/disconnect, not
  member presence. You'll need either: (a) a `voiceStateUpdate` listener
  maintaining a per-guild active-speaker/member-count, or (b)
  `@discordjs/voice`'s connection + the underlying `VoiceChannel`'s
  `members` collection queried at each timer tick. Then run a per-guild
  `setInterval`/timer that calls
  `orchestrator.maybeFireProactiveTurn(guildId, channelId)` only while
  connected AND channel member count (excluding the bot itself) > 0. Clear
  the timer on `/leave` and on disconnect — no timer should outlive the
  voice connection.
- **Wire `OrchestratorDeps.proactive.intervalSeconds`** in `src/index.ts`
  from `config.defaults.proactiveChimeIntervalSeconds` once Sam's config
  field lands (currently omitted — falls back to `120` inside
  `TurnTakingEngine`, so `index.ts` compiles unchanged today).
- **Tone/style variety mechanism** — `LLMResponse.tone` exists but nothing
  reads it downstream, and `DEFAULT_PERSONA.systemPrompt` is one static
  string, so every response has the same shape. This is explicitly your
  design call, not implemented here — `claudeProvider.ts`'s
  `generateResponse` prompt content was deliberately left untouched. One
  option worth considering: track last-N `tone` values per guild
  (`historyByGuild` already threads the bot's own replies back into
  transcript history via `appendBotReply` — you could piggyback a small
  per-guild ring buffer of recent tones on the orchestrator, or thread it
  through `LLMRequest`) and instruct the generator to avoid repeating the
  same tone/style twice in a row.

## Files changed this round (frodo)

- `src/pipeline/types.ts` — new `"proactive"` `TriggerType`, `PROACTIVE_TRIGGER_USER_ID`
  sentinel, `isExplicitTrigger` rewritten as an explicit allowlist.
- `src/pipeline/turnTaking.ts` — `decideProactive` branch (cadence floor +
  activity heuristic + lighter cheap-gate call), `proactiveIntervalSeconds`
  constructor param with a local fallback default.
- `src/pipeline/orchestrator.ts` — `GuildTurnQueue`/`enqueueTurn`/
  `drainTurnQueue`/`runTurn` generalized from segment-only to `TurnWorkItem`
  (segment optional); new public `maybeFireProactiveTurn(guildId, channelId)`;
  `appendBotReply` signature changed to take `(guildId, channelId, text)`
  instead of a full segment; memory extraction and latency-warning logic
  guarded to only run when `item.segment` is present; `OrchestratorDeps`
  gained an optional `proactive?: { intervalSeconds: number }`.
- `src/pipeline/rateLimiter.ts` — **no change**. Verified it already supports
  this correctly as-is: `canRespond`/`recordResponse` are keyed only by
  `guildId`, not trigger type, so proactive responses share the same
  sliding-window per-minute cap as everything else — satisfies "can't stack
  with organic chatter to blow the budget" with zero new code.
- `src/llm/claudeProvider.ts` — `cheapGateCheck`'s system prompt rebalanced
  (see section 3). `generateResponse` and `extractMemoryFacts` untouched.

`npm run typecheck` — clean.
