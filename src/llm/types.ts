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
});
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
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
 *  2. Plain-text fallback — treat the whole trimmed completion as `text`
 *     with no `tone`. This is deliberate: persona prompt allows plain text
 *     too (brief section 4), so a non-JSON reply is not an error case.
 *  3. Empty-string guard — if even the trimmed fallback is empty, this is
 *     a genuine failure (e.g. the model returned only whitespace); caller
 *     should treat that as "nothing to say" rather than play a blank/silent
 *     TTS clip. Merry: `generateResponse` should skip playback in that case,
 *     not synthesize an empty utterance.
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
  const text = raw.trim();
  return { text };
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
}
