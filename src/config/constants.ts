/**
 * Hard-coded fallbacks. Real defaults are env-driven (see .env.example);
 * these exist so every module has a safe value even if env parsing is
 * incomplete during early bring-up / unit tests.
 */

export const FALLBACK_MAX_RESPONSES_PER_MINUTE = 5;
export const FALLBACK_MIN_GAP_SECONDS = 10;
export const FALLBACK_STT_CONFIDENCE_THRESHOLD = 0.6;
export const FALLBACK_ALLOW_AMBIENT_BARGE_IN = false;
export const FALLBACK_AUTO_JOIN_ON_USER_ENTRY = false;
/** Timer-driven proactive-chime cadence floor, seconds (brief: "~once per 2 minutes"). */
export const FALLBACK_PROACTIVE_CHIME_INTERVAL_SECONDS = 120;
/** Master on/off switch for the proactive-chime feature, independent of cadence. */
export const FALLBACK_PROACTIVE_CHIME_ENABLED = true;

/** How many recent transcript segments the context assembler pulls into an LLM request. */
export const CONTEXT_WINDOW_UTTERANCES = 15;

/**
 * Sentinel userId used for the bot's OWN replies when they are threaded back
 * into the in-memory transcript history. This lets the ambient cheap-gate and
 * response generator see what the bot already said (labeled with its persona
 * name), so it stops repeating itself and can tell the conversation has moved
 * on. Not a real user — context assembly skips profile lookups for this id.
 */
export const BOT_SPEAKER_ID = "__bot__";

/** Max sentences the persona is asked to keep responses to, absent an explicit "say more" ask. */
export const DEFAULT_MAX_RESPONSE_SENTENCES = 3;

/** Warn threshold for speech-end -> bot-starts-speaking latency (ms), per brief section 7. */
export const LATENCY_WARN_THRESHOLD_MS = 2500;

/**
 * Defense-in-depth bound on `playback.play()`'s await in `orchestrator.ts`'s
 * `runTurn` — a hang in playback (any cause) must not permanently deadlock a
 * guild's serialized turn queue (`drainTurnQueue` awaits turns one at a
 * time). Generous relative to any real TTS clip length; only exists to cap
 * the worst case, not to interrupt normal playback.
 */
export const PLAYBACK_AWAIT_TIMEOUT_MS = 30_000;

/**
 * Memory schema lock (Sam): `facts`/`running_jokes` stay JSON-encoded TEXT
 * columns (see memory/schema.ts for the tradeoff writeup), NOT normalized
 * child tables. Since that means the whole array round-trips on every
 * write, these caps are what actually enforces "periodic pruning so it
 * doesn't grow unbounded" (brief section 5) at the schema/store layer —
 * `postgresStore.ts#dedupeAppend` truncates to the newest N entries.
 */
export const MAX_FACTS_PER_PROFILE = 40;
export const MAX_RUNNING_JOKES_PER_PROFILE = 20;
export const MAX_FACT_LENGTH = 240;
export const MAX_SENTIMENT_NOTES_LENGTH = 500;

/**
 * Adaptive-cadence learning signal (Sam, durability round — see
 * memory/schema.ts's `turn_outcomes` table): how many of the most recent
 * resolved turn outcomes `PostgresMemoryStore` keeps per guild. Same number
 * (40) and same "newest N, oldest dropped" semantics as frodo's original
 * in-process ring buffer (`ENGAGEMENT_RING_SIZE`), just enforced at the SQL
 * layer now — every `recordTurnOutcome` write prunes back down to this cap
 * so the table can't grow unbounded, same "cap enforced at the write site"
 * philosophy as `MAX_FACTS_PER_PROFILE` above, not the passive/manual
 * `pruneOldLogs` pattern `conversation_log` uses (that table needs full
 * history for its own reasons; this signal only ever needs the last N).
 */
export const MAX_ENGAGEMENT_OUTCOMES_PER_GUILD = 40;

/**
 * Tone-variety round (Merry): how many of the bot's own most-recent reply
 * `tone` tags `PipelineOrchestrator` keeps per guild, oldest dropped first.
 * Fed into `LLMRequest.recentTones` so `generateResponse`'s prompt can say
 * "don't repeat the mode you just used" — small on purpose, this is a
 * short-term anti-repetition nudge, not a style-preference profile.
 */
export const MAX_RECENT_TONES_PER_GUILD = 4;

/**
 * Conversation-continuity round (frodo, brief section 1/task 1): how long
 * after the bot speaks TO a specific person (`PipelineOrchestrator`'s
 * `activeThreadByGuild`) that person's next `ambient_pause` segment is
 * treated as at least as reliable as an explicit trigger, skipping the
 * cheap gate entirely.
 *
 * Picked 75s as the midpoint of the brief's suggested 60-90s starting band:
 * long enough to cover a real person pausing to think/type/gesture before
 * replying (a plain "yes" 20s later shouldn't have to re-say the bot's
 * name), short enough that an unrelated thing that same person says a
 * few minutes later — after the conversation has genuinely moved on — does
 * NOT get grandfathered in as "still talking to the bot". Not exposed as an
 * env-tunable config knob this round (same "implementation heuristic, not a
 * stakeholder-tunable value" call as `PROACTIVE_ACTIVITY_LOOKBACK_MS` in
 * turnTaking.ts) — revisit if live testing shows the window is
 * mistimed either direction.
 */
export const ACTIVE_THREAD_TTL_MS = 75_000;

/**
 * Conversation-continuity round (frodo, task 5 — quick-gap interjection):
 * minimum seconds between INTERJECTION-CHECK attempts per guild (not just
 * successes), mirroring `TurnTakingEngine`'s existing
 * `lastProactiveAttemptAt` pattern for the proactive path. Deliberately much
 * shorter than the proactive cadence floor (~2-3min) — brief: "decoupled...
 * from waiting for the proactive timer's cadence floor" — but still bounds
 * the extra cheap-gate-call cost of trying an interjection every single time
 * the generic ambient gate says no, which would otherwise roughly double
 * cheap-gate call volume during any quiet-ish stretch.
 */
export const INTERJECTION_MIN_INTERVAL_SECONDS = 30;

/**
 * Organic-cadence round (frodo, task 4): jitter band applied as a
 * multiplier on the (possibly engagement-rescaled) proactive interval floor
 * so consecutive proactive gaps stop feeling like a metronome. Centered
 * slightly above 1.0 (not symmetric around it) because the owner also asked
 * the bot to generally feel a bit more willing to speak up rather than
 * ultra-rare — see `PROACTIVE_JITTER_MIN_MULTIPLIER`'s doc note in
 * turnTaking.ts for why jitter has to live in the cadence-floor check rather
 * than the fixed-tick timer that drives it.
 */
export const PROACTIVE_JITTER_MIN_MULTIPLIER = 0.75;
export const PROACTIVE_JITTER_MAX_MULTIPLIER = 1.5;

/**
 * Persona/web-search round (frodo, task 3): master on/off switch fallback
 * for Claude's native `web_search` server tool in `generateResponse` — same
 * "independent kill switch, redeployable without a code change" precedent as
 * `FALLBACK_PROACTIVE_CHIME_ENABLED`. Owner confirmed adding real web lookup
 * this round; this flag exists so a deployment can turn it off (e.g.
 * unexpected cost spike mid-incident) without touching code.
 */
export const FALLBACK_WEB_SEARCH_ENABLED = true;

/**
 * Ceiling on how many times Claude's web_search tool may actually fire
 * WITHIN a single `generateResponse` call (Anthropic's `max_uses` tool
 * param). One is enough for "answer the factual question that was just
 * asked" — the brief's ask is a quick factual lookup mid-conversation, not
 * open-ended multi-step research, and every extra allowed use is both
 * latency and cost this is a live voice pipeline can't spend generously.
 */
export const WEB_SEARCH_MAX_USES_PER_TURN = 1;

/**
 * Explicit request timeout (ms) for `generateResponse`'s `messages.create`
 * call — previously uncapped (relied on the SDK's own default). Needed now
 * because enabling the web_search tool means a single call can include a
 * server-side search round-trip before Claude finishes composing its answer;
 * Anthropic's web_search tool executes INSIDE the same request, so there is
 * no way to give "search" and "generation" separate budgets — only one
 * timeout for the whole call. Applied unconditionally (not just when the
 * tool is enabled) since an uncapped LLM call blocking a guild's serialized
 * turn queue (`PipelineOrchestrator.drainTurnQueue`) was always a latent
 * risk, not just a web-search-specific one. On timeout, the existing
 * try/catch in `generateResponse` already degrades to `{text: ""}` (no new
 * failure path needed) — orchestrator.ts already skips TTS/playback for
 * empty text, so a slow search never hangs the voice pipeline, it just
 * results in the bot silently not answering that turn.
 */
export const LLM_GENERATE_TIMEOUT_MS = 15_000;

/**
 * Guild-wide running jokes/lore round (frodo, task 4): how many final human
 * transcript segments accumulate per guild (`PipelineOrchestrator`) before a
 * periodic guild-level joke-extraction pass fires. Deliberately NOT
 * per-exchange like `extractMemoryFacts` (see `MemoryStore.appendGuildRunningJokes`'s
 * doc comment / the round handoff for the full reasoning) — mirrors Neuro's
 * `modules/memory.py` reflect-every-~20-messages cadence, which fits
 * "collective, emerges-over-many-exchanges" jokes better than a per-turn
 * check tied to one person's exchange with the bot.
 */
export const GUILD_JOKE_EXTRACTION_INTERVAL_SEGMENTS = 20;

/** How many recent transcript segments the periodic guild-joke extraction pass reads over — wider than CONTEXT_WINDOW_UTTERANCES since it's summarizing a whole recent stretch, not just the current exchange. */
export const GUILD_JOKE_EXTRACTION_HISTORY_WINDOW = 40;

/** Cap on guild-wide running jokes, mirroring `MAX_RUNNING_JOKES_PER_PROFILE`'s per-user cap/reasoning (schema-lock: short list, always read/written whole, enforced at both the Zod boundary and the store's dedupe-append truncation). */
export const MAX_GUILD_RUNNING_JOKES = 20;

/**
 * Live-steering admin injection round (frodo, task 5): default and max
 * time-to-live for `GuildSettings.liveContextOverride`. Neuro's
 * `modules/customPrompt.py` precedent this is modeled on is clearable by the
 * operator, but nothing stops an operator from forgetting to clear it —
 * `MemoryStore.setLiveContextOverride` computes `expiresAt` server-side as
 * `min(requested ttl, MAX)`, so a forgotten override always self-expires
 * (lazily, on next read — see `ContextAssembler`) rather than silently
 * steering every future conversation forever.
 */
export const LIVE_CONTEXT_OVERRIDE_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h
export const LIVE_CONTEXT_OVERRIDE_MAX_TTL_MS = 12 * 60 * 60 * 1000; // 12h safety cap
