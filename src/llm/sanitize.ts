import { DEFAULT_BLACKLIST } from "../config/blacklist";
import { logger } from "../shared/logger";

const log = logger.child("llm:sanitize");

/**
 * Deterministic, final-mile safety/cleanliness pass on text about to be
 * spoken by TTS (persona round, task 1 bug fix + task 2 blacklist).
 *
 * Root cause this closes: `parseLLMReply` (llm/types.ts) has always had a
 * "trust the raw completion as plain prose" fallback for genuinely
 * non-JSON replies (deliberate — the persona prompt allows plain text) —
 * but nothing downstream of ANY parse path (JSON success, salvaged labeled-
 * field fallback, or the plain-prose fallback) ever verified the result was
 * actually clean, speakable text. A reply like `text: ... tone: observation`
 * used to get spoken verbatim, literal field-name labels and all — that's
 * the owner's reported bug. `generateResponse` now runs the result of
 * EVERY path through this function before returning, so the guarantee lives
 * in one place instead of depending on every parse branch getting it right.
 *
 * Order matters:
 *  1. Strip `*stage directions*` (content and asterisks both — persona.ts
 *     already claimed "no stage directions" as a rule, nothing enforced it).
 *  2. Strip remaining markdown emphasis/code markers and heading/bullet/link
 *     syntax (TTS reads a literal `#`/`*`/`` ` `` verbatim, which sounds
 *     broken).
 *  3. Strip leftover `text:`/`"tone":`-style leading labels — belt and
 *     braces on top of `parseLLMReply`'s own salvage logic, in case a label
 *     survives (e.g. mid-string rather than leading).
 *  4. Collapse whitespace left behind by the strips above.
 *  5. Banned-phrase backstop (task 2) — whole-utterance drop on any match,
 *     not partial redaction (see `DEFAULT_BLACKLIST`'s doc comment).
 *
 * Returns `""` when nothing salvageable/safe remains — callers must treat
 * that exactly like the pre-existing "empty LLM response" case
 * (`orchestrator.ts` already skips TTS/playback for empty text; this
 * function does not invent a second empty-text convention).
 */
export function sanitizeSpokenText(raw: string, options?: { blacklist?: readonly string[] }): string {
  let text = raw;

  // *stage directions* / *asterisked actions* — drop the whole bracketed
  // span, not just the asterisks (the content is almost always a non-spoken
  // action cue, e.g. "*laughs*", "*rolls eyes*").
  text = text.replace(/\*[^*]*\*/g, " ");
  // Any remaining lone emphasis/code markers.
  text = text.replace(/[*_`]+/g, "");
  // Markdown headings / bullet markers -> drop the markup, keep the words.
  text = text.replace(/^#{1,6}\s*/gm, "");
  text = text.replace(/^[-*+]\s+/gm, "");
  // Markdown links -> link text only.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  text = stripLeftoverLabelPrefixes(text);

  text = text.replace(/\s+/g, " ").trim();

  if (text.length === 0) return "";

  const blacklist = options?.blacklist ?? DEFAULT_BLACKLIST;
  const lowerText = text.toLowerCase();
  for (const phrase of blacklist) {
    const needle = phrase.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (lowerText.includes(needle)) {
      log.warn("sanitizer dropped a response — matched banned-phrase blacklist", { matchedPhraseLength: needle.length });
      return "";
    }
  }

  return text;
}

const LEADING_LABEL_RE = /^["']?\b(?:text|tone|reason|respond)\b["']?\s*:\s*/i;
const MAX_LABEL_STRIP_PASSES = 3;

/**
 * Strips a leading `text:`/`"tone":`/etc field-name label, repeatedly (a
 * salvaged value can still carry a second stacked label in rare cases).
 * Belt-and-braces on top of `parseLLMReply`'s own salvage logic in
 * llm/types.ts — this runs on the output of every parse path, not just the
 * one that already tried to strip labels.
 */
function stripLeftoverLabelPrefixes(text: string): string {
  let out = text.trim();
  for (let i = 0; i < MAX_LABEL_STRIP_PASSES && LEADING_LABEL_RE.test(out); i++) {
    out = out.replace(LEADING_LABEL_RE, "");
  }
  return out.trim();
}
