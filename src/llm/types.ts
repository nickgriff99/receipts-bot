import { z } from "zod";
import { TranscriptSegmentSchema } from "../stt/types";
import { logger } from "../shared/logger";

const log = logger.child("llm:parse");

/**
 * LLM module boundary.
 *
 * Two different trust levels live in this file:
 *  - "Internal" shapes (`LLMRequest`, `CheapGateInput`, `MemoryExtractionInput`,
 *    `PersonaConfig`, `MemoryContextSlice`) are built by our own code
 *    (context assembler, orchestrator) — plain Zod object schemas, parsed
 *    the normal strict way.
 *  - "Raw reply" shapes (`CheapGateRawReply`, `LLMRawReply`,
 *    `MemoryExtractionRawReply`) are what we ASK Claude Haiku to return as
 *    JSON, but a raw LLM completion is not a trusted client payload — it
 *    can be malformed JSON, prose with a JSON blob buried in it, or plain
 *    text with no JSON at all. Every raw-reply parser below is
 *    lenient-parse-with-fallback: try strict JSON parse + Zod validation
 *    first, and on ANY failure fall back to a safe, conservative default
 *    (never respond / no new facts) rather than throwing — a hallucinated
 *    or truncated reply must never crash the pipeline or get spoken
 *    verbatim to a voice channel.
 */

export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  maxResponseSentences: z.number().int().positive(),
});
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

export const MemoryContextSliceSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  facts: z.array(z.string()),
  runningJokes: z.array(z.string()),
  sentimentNotes: z.string().optional(),
  lastInteractionAt: z.number().int().nonnegative().optional(),
});
export type MemoryContextSlice = z.infer<typeof MemoryContextSliceSchema>;

export const LLMRequestSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  persona: PersonaConfigSchema,
  /** Rolling window, oldest first — see CONTEXT_WINDOW_UTTERANCES. */
  recentTranscript: z.array(TranscriptSegmentSchema),
  memoryContext: z.array(MemoryContextSliceSchema),
  /** Why this turn is happening — explicit mention text, or the cheap-gate's reason. Fed into the prompt for continuity, not shown to end users. */
  triggerReason: z.string(),
  /**
   * Tone-variety mechanism (Merry): the bot's own last few `LLMResponse.tone`
   * values for this guild, oldest first, capped at `MAX_RECENT_TONES_PER_GUILD`
   * (orchestrator.ts). `generateResponse` feeds this back into the prompt as
   * "here's what you just did, don't do it again" alongside a named menu of
   * style modes (see `RESPONSE_STYLE_MODES` in claudeProvider.ts) — a rolling
   * anti-repetition signal beats a vague "vary your style" instruction, which
   * models tend to ignore in isolation over many turns. Empty array is the
   * normal state for a guild's first few turns.
   */
  recentTones: z.array(z.string()),
  /**
   * Guild-wide running jokes/lore round (frodo, task 4) — collective jokes
   * NOT tied to one person, distinct from `MemoryContextSlice.runningJokes`
   * (per-user). Always supplied (empty array is the normal early-guild
   * state), same "required field, ContextAssembler is the sole builder"
   * convention as `recentTones` — see that field's doc comment for why this
   * schema isn't used with `.default()` here.
   */
  guildRunningJokes: z.array(z.string()),
  /**
   * Live-steering admin injection round (frodo, task 5) — operator-set
   * temporary context (`GuildSettings.liveContextOverride`), already
   * TTL-filtered by `ContextAssembler` (undefined here means either nothing
   * is set, or it expired — callers never need to re-check the expiry
   * themselves). `undefined` in the overwhelming common case (no active
   * override).
   */
  liveContextOverride: z.string().optional(),
});
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * Web-lookup round (frodo, task 3) — how many times Claude's native
   * `web_search` server tool actually fired during this call (from
   * `Message.usage.server_tool_use.web_search_requests`), `undefined` when
   * the web_search tool wasn't enabled/offered for this call at all (not the
   * same as "enabled but unused", which is `0`).
   *
   * Sam's contract-lock decision: persisted to `usage_log` as its own
   * service (`UsageServiceSchema`'s `"web_search"` member, unit
   * `"searches"`) rather than folded into the `'llm'`/`'tokens'` row (would
   * misrepresent cost) — a genuinely different billing unit gets a
   * genuinely different row, same reasoning `'stt'`/`'tts'` already use for
   * their own character-count rows. `pipeline/orchestrator.ts#runTurn`
   * writes this row only when `webSearchCount` is truthy (0/undefined both
   * skip the write — no zero-unit rows), and also still logs it to the
   * structured logger for real-time observability alongside the persisted
   * audit row.
   */
  webSearchCount: z.number().int().nonnegative().optional(),
});

/** Internal, validated response shape — what `LLMProvider.generateResponse` returns after lenient-parsing the raw model reply. */
export const LLMResponseSchema = z.object({
  text: z.string(),
  /** Optional emotion/delivery tag for future TTS style-control or avatar work — brief section 4. Not guaranteed present. */
  tone: z.string().optional(),
  usage: UsageSchema,
});
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

/** The JSON shape we prompt Claude to reply with for full generation. */
export const LLMRawReplySchema = z.object({
  text: z.string().min(1),
  tone: z.string().optional(),
});
export type LLMRawReply = z.infer<typeof LLMRawReplySchema>;

/**
 * Lenient-parse a raw Claude completion for `generateResponse`.
 *
 * Order of attempts:
 *  1. Strict JSON.parse + `LLMRawReplySchema` — the persona is asked for
 *     `{"text": ..., "tone": ...}` and usually complies.
 *  2. Salvage pass (bug-fix round, task 1) — if the reply isn't valid JSON
 *     but LOOKS like a failed structured attempt (`looksLikeFailedStructuredReply`:
 *     starts with `{`, or carries a `text:`/`tone:`-style label), it is a
 *     different case than genuine plain prose and must not be trusted
 *     verbatim — this is the exact shape of the owner's reported bug
 *     ("text... tone... observation" spoken aloud). Try to salvage just the
 *     `text` (and `tone`) field VALUES out of it (`extractLabeledField`)
 *     instead of speaking the labels too. If a text value can be salvaged,
 *     return it (still passed through `llm/sanitize.ts#sanitizeSpokenText`
 *     by the caller, same as every other path — this function only owns
 *     parse-fidelity, not TTS-speakability). If nothing salvageable is
 *     found, this is treated as a genuine failure (empty text, same
 *     contract as case 4 below) rather than falling through to case 3 and
 *     speaking the raw broken completion.
 *  3. Plain-text fallback — ONLY reached when the reply doesn't look like a
 *     failed structured attempt at all: treat the whole trimmed completion
 *     as `text` with no `tone`. This is deliberate: persona prompt allows
 *     plain text too (brief section 4), so a genuine non-JSON reply is not
 *     an error case.
 *  4. Empty-string guard — if even the trimmed fallback is empty, this is
 *     a genuine failure (e.g. the model returned only whitespace); caller
 *     should treat that as "nothing to say" rather than play a blank/silent
 *     TTS clip. `generateResponse`/`orchestrator.ts` skip playback in that
 *     case, not synthesize an empty utterance.
 *
 * One-shot retry-with-stricter-instruction was considered instead of/in
 * addition to this salvage-and-sanitize approach and deliberately NOT
 * implemented this round: a retry adds a full extra API round-trip (real
 * latency in a live voice pipeline, real added cost) and is not actually
 * guaranteed to fix anything — the model could fail the same way twice.
 * Salvage-and-sanitize is strictly cheaper (zero added latency/cost) and
 * deterministic (string parsing, not dependent on the model behaving
 * better on a second attempt). Revisit if live-listening logs show the
 * salvage path failing open too often (i.e. genuinely losing good replies,
 * not just broken ones) — that would be the actual signal a retry is worth
 * the cost, not a guess made up front.
 */
export function parseLLMReply(raw: string): { text: string; tone?: string } {
  const jsonCandidate = extractJsonObject(raw);
  if (jsonCandidate) {
    const parsed = LLMRawReplySchema.safeParse(jsonCandidate);
    if (parsed.success) {
      return { text: parsed.data.text.trim(), tone: parsed.data.tone };
    }
    log.warn("LLM reply looked like JSON but failed schema validation, falling back to plain text", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }

  if (looksLikeFailedStructuredReply(raw)) {
    const salvagedText = extractLabeledField(raw, "text");
    if (salvagedText) {
      const salvagedTone = extractLabeledField(raw, "tone");
      log.warn("LLM reply looked like a failed JSON/labeled-field attempt — salvaged the text field instead of speaking labels verbatim", {
        raw: raw.slice(0, 200),
      });
      return { text: salvagedText, tone: salvagedTone };
    }
    log.warn("LLM reply looked like a failed structured attempt with no salvageable text field — treating as nothing to say", {
      raw: raw.slice(0, 200),
    });
    return { text: "" };
  }

  const text = raw.trim();
  return { text };
}

/**
 * True if `raw` looks like a failed attempt at the requested
 * `{"text": ..., "tone": ...}` shape rather than genuine plain spoken
 * prose — a real spoken line essentially never starts with a literal `{` or
 * the word `text` followed by a colon, or carries a `tone: <mode-name>`
 * fragment. Deliberately conservative (checks for the SPECIFIC shapes this
 * prompt asks for, not a generic "contains a colon" heuristic) so it doesn't
 * misfire on ordinary prose that happens to contain a colon (e.g. "Fine,
 * three options: pizza, tacos, or regret").
 */
function looksLikeFailedStructuredReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("{")) return true; // truncated/malformed JSON — already failed extractJsonObject above
  if (/^["']?\btext\b["']?\s*:/i.test(trimmed)) return true;
  if (/["']?\btone\b["']?\s*:\s*["']?[a-z_]+["']?/i.test(trimmed)) return true;
  return false;
}

const KNOWN_RAW_REPLY_LABELS = ["text", "tone", "reason", "respond"];

/**
 * Best-effort extraction of one labeled field's VALUE from a raw completion
 * that looks like a failed structured attempt (see
 * `looksLikeFailedStructuredReply`) — handles both a `key: value` plain
 * labeled format and a truncated/malformed `"key": "value"` JSON fragment.
 * Returns `undefined` (never throws) if the label isn't present or its
 * value is empty after cleanup.
 */
function extractLabeledField(raw: string, field: string): string | undefined {
  const labelRe = new RegExp(`["']?\\b${field}\\b["']?\\s*:\\s*`, "i");
  const match = labelRe.exec(raw);
  if (!match) return undefined;

  let rest = raw.slice(match.index + match[0].length);

  const quoted = /^["']([\s\S]*?)["']\s*(?:[,}]|$)/.exec(rest);
  if (quoted) {
    const value = quoted[1].trim();
    return value.length > 0 ? value : undefined;
  }

  const otherLabels = KNOWN_RAW_REPLY_LABELS.filter((label) => label !== field);
  const nextLabelRe = new RegExp(`["']?\\b(?:${otherLabels.join("|")})\\b["']?\\s*:`, "i");
  const nextMatch = nextLabelRe.exec(rest);
  if (nextMatch) rest = rest.slice(0, nextMatch.index);

  const value = rest.replace(/[{}"']/g, "").trim();
  return value.length > 0 ? value : undefined;
}

/** The JSON shape we prompt Claude to reply with for the ambient cheap-gate check. */
export const CheapGateRawReplySchema = z.object({
  respond: z.boolean(),
  reason: z.string().min(1),
});
export type CheapGateRawReply = z.infer<typeof CheapGateRawReplySchema>;

/**
 * Lenient-parse a raw Claude completion for `cheapGateCheck`. Unlike
 * `parseLLMReply`, there is no safe "plain text" fallback here — the
 * cheap-gate MUST reply with structured yes/no JSON, so any parse failure
 * falls back to `shouldRespond: false` (the conservative, budget-safe
 * default: brief section 3/7 — an ambiguous gate reply should never turn
 * into an unintended full-generation call).
 */
export function parseCheapGateReply(raw: string): { shouldRespond: boolean; reason: string } {
  const jsonCandidate = extractJsonObject(raw);
  if (jsonCandidate) {
    const parsed = CheapGateRawReplySchema.safeParse(jsonCandidate);
    if (parsed.success) {
      return { shouldRespond: parsed.data.respond, reason: parsed.data.reason };
    }
    log.warn("cheap-gate reply failed schema validation, defaulting to no-respond", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  } else {
    log.warn("cheap-gate reply was not parseable JSON, defaulting to no-respond", { raw: raw.slice(0, 200) });
  }
  return { shouldRespond: false, reason: "cheap-gate reply unparseable — defaulted to no-respond" };
}

/** The JSON shape we prompt Claude to reply with for post-hoc memory extraction. */
export const MemoryExtractionRawReplySchema = z.object({
  facts: z.array(z.string().min(1)).default([]),
  sentiment: z.string().optional(),
});
export type MemoryExtractionRawReply = z.infer<typeof MemoryExtractionRawReplySchema>;

/**
 * Lenient-parse a raw Claude completion for `extractMemoryFacts`. Parse
 * failure falls back to "nothing memory-worthy this exchange" — losing a
 * fact occasionally is a fine failure mode; inventing/mangling one is not.
 */
export function parseMemoryExtractionReply(raw: string): { newFacts: string[]; sentimentNotes?: string } {
  const jsonCandidate = extractJsonObject(raw);
  if (jsonCandidate) {
    const parsed = MemoryExtractionRawReplySchema.safeParse(jsonCandidate);
    if (parsed.success) {
      return { newFacts: parsed.data.facts, sentimentNotes: parsed.data.sentiment };
    }
    log.warn("memory-extraction reply failed schema validation, defaulting to no new facts", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  return { newFacts: [] };
}

/** Best-effort extraction of a JSON object from a raw completion (handles bare JSON and JSON wrapped in prose/code-fences). Returns `undefined` (never throws) if nothing parseable is found. */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace-scan below
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export const CheapGateInputSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  persona: PersonaConfigSchema,
  /** Short recent window — this call is deliberately token-thin, it does NOT get the full memory context. */
  recentTranscript: z.array(TranscriptSegmentSchema),
  /**
   * Conversation-continuity round (frodo, task 5) — which gate prompt
   * variant to run. `"ambient"` (the default, and every existing call site
   * before this round) is the pre-existing "does this add something worth
   * saying" check. `"interjection"` is a distinct, rarer, higher-bar
   * "is THIS SPECIFIC pause strongly worth jumping into" check
   * (`TurnTakingEngine.decideInterjection`) that can fire even after the
   * ambient variant already said no for the same candidate — see that
   * method's doc comment. Kept as one shared method + a discriminator field
   * rather than a second `LLMProvider` method: same request/response shape,
   * same token-thin transcript-only context, only the system prompt differs
   * — a whole parallel interface would just duplicate the usage-logging and
   * lenient-parse plumbing around it for no real benefit.
   *
   * `.optional()`, not `.default("ambient")`: this schema is also used as a
   * plain TypeScript type at call sites that build the object literal
   * directly (never call `.parse()`), so a Zod-level default would still
   * leave the field required at the TYPE level. `ClaudeHaikuProvider`
   * resolves the default itself (`input.checkKind ?? "ambient"`).
   */
  checkKind: z.enum(["ambient", "interjection"]).optional(),
});
export type CheapGateInput = z.infer<typeof CheapGateInputSchema>;

export type CheapGateReason = string;

export const CheapGateResultSchema = z.object({
  shouldRespond: z.boolean(),
  reason: z.string(),
  usage: UsageSchema,
});
export type CheapGateResult = z.infer<typeof CheapGateResultSchema>;

export const MemoryExtractionInputSchema = z.object({
  guildId: z.string().min(1),
  userId: z.string().min(1),
  displayName: z.string().min(1),
  /** The exchange just completed: the trigger utterance(s) + the bot's reply. */
  exchange: z.array(TranscriptSegmentSchema),
  botReplyText: z.string(),
  existingFacts: z.array(z.string()),
});
export type MemoryExtractionInput = z.infer<typeof MemoryExtractionInputSchema>;

export const MemoryExtractionResultSchema = z.object({
  /** New/updated facts worth persisting (running jokes, notable info, sentiment shifts). Empty array = nothing memory-worthy this exchange. */
  newFacts: z.array(z.string()),
  sentimentNotes: z.string().optional(),
  usage: UsageSchema,
});
export type MemoryExtractionResult = z.infer<typeof MemoryExtractionResultSchema>;

/**
 * Guild-wide running jokes/lore round (frodo, task 4) — a SEPARATE periodic
 * pass, not a per-exchange one like `extractMemoryFacts` above. Decision,
 * documented here rather than left implicit: guild-wide jokes are
 * collective (often nobody's individual exchange with the bot — they emerge
 * from humans talking among themselves), so tying extraction to "the
 * exchange that just finished between the bot and one person"
 * (`extractMemoryFacts`'s trigger) would structurally miss most of them, and
 * would also mean paying the extra prompt-context cost of the existing
 * guild-jokes list on every single bot turn regardless of whether anything
 * guild-worthy happened. Instead, `PipelineOrchestrator` counts final human
 * transcript segments per guild and fires this over a wider recent-history
 * window every `GUILD_JOKE_EXTRACTION_INTERVAL_SEGMENTS` segments
 * (config/constants.ts) — mirrors Neuro's `modules/memory.py` reflect-every-
 * ~20-messages cadence, which is a better fit for "collective, emerges over
 * many exchanges" than a per-turn check.
 */
export const GuildJokeExtractionInputSchema = z.object({
  guildId: z.string().min(1),
  /** Recent multi-speaker window, oldest first — wider than a single exchange (see GUILD_JOKE_EXTRACTION_HISTORY_WINDOW). */
  recentTranscript: z.array(TranscriptSegmentSchema),
  existingJokes: z.array(z.string()),
});
export type GuildJokeExtractionInput = z.infer<typeof GuildJokeExtractionInputSchema>;

export const GuildJokeExtractionResultSchema = z.object({
  /** New guild-wide running jokes worth persisting. Empty array = nothing new this pass — the common case. */
  newJokes: z.array(z.string()),
  usage: UsageSchema,
});
export type GuildJokeExtractionResult = z.infer<typeof GuildJokeExtractionResultSchema>;

/** The JSON shape we prompt Claude to reply with for guild-joke extraction. */
export const GuildJokeExtractionRawReplySchema = z.object({
  jokes: z.array(z.string().min(1)).default([]),
});
export type GuildJokeExtractionRawReply = z.infer<typeof GuildJokeExtractionRawReplySchema>;

/**
 * Lenient-parse a raw Claude completion for `extractGuildJokes` — same
 * fail-safe-to-nothing-new contract as `parseMemoryExtractionReply` (losing
 * a joke occasionally is fine; inventing one is not).
 */
export function parseGuildJokeExtractionReply(raw: string): { newJokes: string[] } {
  const jsonCandidate = extractJsonObject(raw);
  if (jsonCandidate) {
    const parsed = GuildJokeExtractionRawReplySchema.safeParse(jsonCandidate);
    if (parsed.success) {
      return { newJokes: parsed.data.jokes };
    }
    log.warn("guild-joke-extraction reply failed schema validation, defaulting to no new jokes", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  return { newJokes: [] };
}

/**
 * Every LLM backend implements this. v1 only ships `ClaudeHaikuProvider`
 * (both the cheap gate and full generation use the same haiku model per
 * locked stakeholder decision — no dual-model split), but keeping the
 * interface swappable costs nothing.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  cheapGateCheck(input: CheapGateInput): Promise<CheapGateResult>;
  generateResponse(request: LLMRequest): Promise<LLMResponse>;
  extractMemoryFacts(input: MemoryExtractionInput): Promise<MemoryExtractionResult>;
  /** Guild-wide running-jokes/lore periodic pass (task 4) — see `GuildJokeExtractionInputSchema`'s doc comment for why this is separate from `extractMemoryFacts`. */
  extractGuildJokes(input: GuildJokeExtractionInput): Promise<GuildJokeExtractionResult>;
}
