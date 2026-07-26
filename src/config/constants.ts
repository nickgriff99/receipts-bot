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
