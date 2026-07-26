import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  CheapGateInput,
  CheapGateResult,
  MemoryExtractionInput,
  MemoryExtractionResult,
} from "./types";
import { parseLLMReply, parseCheapGateReply, parseMemoryExtractionReply } from "./types";
import { logger } from "../shared/logger";

const log = logger.child("llm:claude");

/**
 * Tone-variety mechanism (Merry) — named delivery modes `generateResponse`
 * rotates through, fed into the prompt alongside `LLMRequest.recentTones`
 * (the bot's own last few picks for this guild). Concrete named modes,
 * instead of a vague "vary your style" instruction, are what actually make
 * an LLM rotate over many turns rather than drifting back into one register
 * — a bare "be varied" ask tends to get ignored in isolation.
 *
 * `tone` stays a free-form optional string end-to-end (`LLMRawReplySchema`,
 * llm/types.ts) rather than a closed Zod enum deliberately: if the model
 * replies with something outside this list, or omits tone entirely, that
 * must never fail the whole reply's schema validation and fall back to
 * losing the "text" field too (see parseLLMReply's lenient-fallback
 * contract). This list is a prompt-side menu, not a wire-format contract.
 */
const RESPONSE_STYLE_MODES = [
  "roast — needle them (lightly) about something they actually just said or did",
  "compliment — a genuine, non-sarcastic point of praise or appreciation",
  "genuine_question — ask something you actually want to know, no punchline attached",
  "blunt — say the blunt or slightly mean thing straight, without cruelty",
  "observation — a dry, off-hand comment on the moment, not addressed to anyone in particular",
  "riff — just riff or joke on the topic, low-stakes, no target",
  "banter — light, playful back-and-forth teasing, quick and low-stakes, clearly all in good fun",
  "argue — play up a mock disagreement or friendly-contrarian bit on whatever's being discussed; this is a bit, not real hostility — you don't actually need to be right, just committed to the joke",
].join("; ");

/**
 * Claude Haiku provider — used for BOTH the cheap ambient pre-check gate
 * AND full response generation (locked decision: no dual-model split,
 * budget is the binding constraint). Model id comes from AppConfig
 * (default "claude-haiku-4-5-20251001").
 *
 * Every raw completion is fed through Sam's lenient `parse*` helpers
 * (llm/types.ts) rather than hand-rolled `JSON.parse` — those already own
 * the safe-fallback behavior on malformed/prose replies.
 *
 * Token usage: every call returns `usage` (input/output tokens) so the
 * caller (pipeline/orchestrator.ts + pipeline/turnTaking.ts) can log it to
 * `usage_log` — this provider does not persist anything itself, it has no
 * MemoryStore dependency by design (keeps the LLM/memory module boundary
 * clean, see ARCHITECTURE.md).
 */
export class ClaudeHaikuProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async cheapGateCheck(input: CheapGateInput): Promise<CheapGateResult> {
    const transcriptText = formatTranscript(input.recentTranscript);
    const checkKind = input.checkKind ?? "ambient";
    const system =
      checkKind === "interjection"
        ? buildInterjectionGateSystemPrompt(input.persona.name)
        : buildAmbientGateSystemPrompt(input.persona.name);

    const userContent = transcriptText.length > 0 ? transcriptText : "(no recent transcript)";

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 40,
        system,
        messages: [{ role: "user", content: userContent }],
      });

      const raw = extractText(message);
      const parsed = parseCheapGateReply(raw);
      return {
        shouldRespond: parsed.shouldRespond,
        reason: parsed.reason,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        },
      };
    } catch (err) {
      log.error("cheapGateCheck call failed", {
        guildId: input.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail safe/quiet — a broken gate call must never turn into an unintended full generation.
      return {
        shouldRespond: false,
        reason: "cheap-gate call failed — defaulted to no-respond",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    const transcriptText = formatTranscript(request.recentTranscript);
    const memoryText = formatMemory(request.memoryContext);

    // Tone-variety mechanism (Merry) — named menu + "what you just did"
    // history, built fresh per request from `request.recentTones` (oldest
    // first, capped in orchestrator.ts). See RESPONSE_STYLE_MODES doc
    // comment for why this is concrete named modes rather than a vague
    // "be varied" instruction.
    const recentTonesLine =
      request.recentTones.length > 0
        ? `Your last few replies used these modes, oldest first: ${request.recentTones.join(", ")}. Do NOT use that most-recent mode again right now — pick a genuinely different one from the menu below, unless staying warm/gentle is clearly still the right call (e.g. someone is still visibly upset).`
        : "You have no recent-mode history yet for this conversation — pick whichever mode below actually fits the moment.";

    const system = [
      request.persona.systemPrompt,
      `Your own recent lines appear in the transcript labeled "${request.persona.name}:". Do NOT repeat points`,
      "you already made or rephrase a reaction you already gave — if you've already addressed the current topic,",
      "either add a genuinely new angle or reply with empty text. Track where the conversation is RIGHT NOW and",
      "respond to the latest thing being discussed, not something already handled a few lines ago.",
      `Vary your delivery style turn to turn using this menu of named modes: ${RESPONSE_STYLE_MODES}.`,
      recentTonesLine,
      "Pick whichever mode genuinely fits what's happening right now — never force a roast or blunt line into a",
      "moment that calls for something else, and the hard line from your persona above (never target real sensitive",
      "traits like appearance/identity/ability, always drop the bite and go warm if someone seems genuinely upset)",
      "applies to every mode, roast/blunt/banter/argue included, with no exceptions. \"argue\" specifically means a",
      "played-up, obviously-a-bit mock disagreement or friendly-contrarian stance — never genuine hostility, never",
      "escalate it into a real fight, and drop it immediately (same as any other mode) if the moment turns genuinely",
      "serious.",
      'Reply with ONLY compact JSON: {"text": "your spoken reply", "tone": "the mode name you picked, e.g. roast/compliment/genuine_question/blunt/observation/riff/banter/argue"}.',
      `Keep "text" to at most ${request.persona.maxResponseSentences} sentences.`,
      "If there is truly nothing worth saying, reply with {\"text\": \"\"} — but this escape hatch is for ordinary",
      "ambient/proactive turns only. If the \"Why you're responding now\" reason below says someone specifically just",
      "joined the voice channel, just left the voice channel, or that you just connected to the channel, that is a",
      "rare, deliberate moment meant for you to actually speak — always give a real, on-topic spoken line for those",
      "(even a brief one), never fall back to empty text for them.",
    ].join(" ");

    const userContent = [
      `Recent voice chat transcript:\n${transcriptText.length > 0 ? transcriptText : "(no recent transcript)"}`,
      memoryText.length > 0 ? `\nWhat you remember about people here:\n${memoryText}` : "",
      `\nWhy you're responding now: ${request.triggerReason}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: userContent }],
      });

      const raw = extractText(message);
      const parsed = parseLLMReply(raw);
      return {
        text: parsed.text,
        tone: parsed.tone,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        },
      };
    } catch (err) {
      log.error("generateResponse call failed", {
        guildId: request.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Empty text — orchestrator.ts skips TTS/playback for empty responses
      // rather than speaking a hardcoded fallback line into the channel.
      return { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }

  async extractMemoryFacts(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const exchangeText = formatTranscript(input.exchange);
    const system = [
      "You extract durable, memory-worthy facts about a Discord user from one short voice-chat exchange.",
      "Only extract things worth remembering long-term: stable facts, running jokes/callbacks, or a clear sentiment shift.",
      "Do NOT extract small talk, one-off jokes with no callback value, or anything already in the existing facts list.",
      'Reply with ONLY compact JSON: {"facts": ["short fact", ...], "sentiment": "optional short note"}.',
      "Empty facts array is the right answer most of the time.",
    ].join(" ");

    const userContent = [
      `User: ${input.displayName}`,
      `Existing facts: ${input.existingFacts.length > 0 ? input.existingFacts.join("; ") : "(none yet)"}`,
      `Exchange:\n${exchangeText}`,
      `Bot's reply: ${input.botReplyText}`,
    ].join("\n");

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 150,
        system,
        messages: [{ role: "user", content: userContent }],
      });

      const raw = extractText(message);
      const parsed = parseMemoryExtractionReply(raw);
      return {
        newFacts: parsed.newFacts,
        sentimentNotes: parsed.sentimentNotes,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        },
      };
    } catch (err) {
      log.error("extractMemoryFacts call failed", {
        guildId: input.guildId,
        userId: input.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { newFacts: [], usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }
}

/**
 * Ambient cheap-gate system prompt — pre-existing behavior, unchanged from
 * before this round, just extracted into a named function so
 * `cheapGateCheck` can pick between it and the new interjection variant
 * below (task 5, conversation-continuity round). Rebalanced (frodo,
 * proactive-chime round): the prior version defaulted strongly to YES for
 * almost everything, which was the likely root cause of "talks when it
 * isn't addressed / talks too much" — this call is also shared by
 * ambient-pause AND timer-driven proactive candidates
 * (pipeline/turnTaking.ts), so an unconditional yes-bias would be even more
 * likely to fire into low-content moments. Direct-address handling below is
 * deliberately KEPT strongly yes-biased — that's a different failure mode
 * (under-triggering when clearly addressed) and must not regress. Note:
 * as of the conversation-continuity round, the strongest form of
 * direct-address reliability (a reply to the bot's own last line, from the
 * SAME person it was just talking to) is handled structurally upstream by
 * `TurnTakingEngine`'s active-thread continuation check — that path skips
 * this gate call entirely, so this prompt no longer needs to be the only
 * thing carrying that specific case.
 */
function buildAmbientGateSystemPrompt(personaName: string): string {
  return [
    `You are the response gate for "${personaName}", a witty Discord voice co-host who banters, reacts,`,
    "asks questions, and comments on the conversation — but only when it actually adds something in the moment.",
    "Given the most recent snippet of live voice-chat transcript, decide whether the bot should speak RIGHT NOW.",
    "Say YES when: someone is directly addressing the bot (see DIRECT ADDRESS below — always yes there); a joke or",
    "strong reaction opportunity just landed; someone asked the group a question worth answering; or the",
    "conversation moved to a fresh topic worth a genuine comment. Say NO when: nothing new has happened since the",
    "bot's own last line; the snippet is low-content filler (short acknowledgements, half a sentence, background",
    "noise transcribed as words) with nothing to actually react to; jumping in would clearly talk over someone",
    "still mid-sentence; or the moment is genuinely serious/sensitive and a quip would land badly. When it's a",
    "genuinely close call between a real reaction and staying quiet, prefer staying quiet — this bot should feel",
    "like an attentive participant who picks real moments, not a chatbot replying to every line.",
    `DIRECT ADDRESS: people often talk to the bot WITHOUT using its name — with "you" ("what do you think?", "you`,
    `agree?"), or by referring to it as "him"/"it"/"this guy" ("ask him", "what's it say", "tell this guy"). Use the`,
    `conversation flow to judge who is being addressed — the bot's own recent lines are labeled "${personaName}:",`,
    "so a question right after it spoke, or a reply to something it said, is almost certainly aimed at it. If someone is",
    "clearly talking TO the bot — by name OR by pronoun in context — that is ALWAYS a yes, even mid-serious-moment. But",
    "if a pronoun clearly refers to another real person and the humans are talking among themselves, don't assume it",
    "means the bot.",
    `IMPORTANT: the bot's own recent lines appear in the transcript labeled "${personaName}:". Say NO if the`,
    "bot would just be repeating a point it already made or beating a topic it has already reacted to — in that case",
    "let the conversation move on and wait for something new. Prefer chiming in on the newest thing being said.",
    'Reply with ONLY compact JSON: {"respond": boolean, "reason": "one short phrase"}. No other text.',
  ].join(" ");
}

/**
 * Quick-gap interjection gate (task 5, conversation-continuity round) — a
 * DISTINCT, deliberately rarer/higher-bar check than the ambient gate
 * above. `TurnTakingEngine.decideInterjection` only calls this after the
 * ambient gate has already said no (or was itself damped by the engagement
 * signal) for the exact same candidate — this is the bot's second, much
 * choosier chance to speak into the same pause, not an easier path to the
 * same yes. Never asked to weigh in on direct address at all (that's
 * already fully covered upstream — explicit triggers and active-thread
 * continuations never even reach either gate) — this prompt is purely about
 * "is this specific ambient moment special enough to interrupt the quiet
 * for", independent of who's being talked to.
 *
 * Tuned (Merry, conversation-continuity round, wiring pass): the first draft
 * conveyed "higher bar" but had no explicit recency requirement — nothing
 * stopped it saying YES to a funny moment from several exchanges back that
 * the conversation had already moved past. Added a dedicated RECENCY clause
 * (must react to the newest line or two, not resurrect something stale) plus
 * an explicit "on the fence -> NO" tie-breaker to push the calibration
 * further toward rare. Everything else (higher-bar framing, direct-address
 * carve-out, mid-sentence guard mirrored from the ambient gate per this
 * project's documented redundant-check precedent) is unchanged from the
 * first draft.
 */
function buildInterjectionGateSystemPrompt(personaName: string): string {
  return [
    `You are a SECOND, much stricter gate for "${personaName}", a witty Discord voice co-host. The ordinary`,
    "response gate already looked at this exact moment and said NOT to speak (or was skipped entirely because the",
    "conversation has been flat lately). You get one narrow, rare exception: say YES only if THIS SPECIFIC pause is",
    "genuinely special enough that staying quiet would be a missed opportunity — something unusually funny just",
    "happened, something random and delightful worth a quick reaction, or something clearly important enough (a real",
    "question hanging unanswered, a notable moment) that it deserves a comment even though it's not the bot's",
    "ordinary turn to speak. This is a MUCH higher bar than the normal gate, not a second roll of the same dice —",
    "most pauses, even ones with something mildly worth adding, should still get a NO here. Reserve YES for moments",
    "that would feel like a genuinely missed beat if the bot said nothing. If you're on the fence at all, the answer",
    "is NO.",
    "RECENCY: only say YES if you're reacting to something that JUST happened — the newest line or two of the",
    "transcript. If the funny/notable moment already passed a few exchanges ago and the conversation has since moved",
    "on to something else, that moment is stale now — say NO, even if it was genuinely a good one at the time. The",
    "whole point of this check is feeling snappy in the gap right after something lands, not resurrecting an old",
    "moment.",
    "Say NO whenever: the moment is merely fine/pleasant/ordinary; it's simply more small talk or filler; the",
    "notable thing isn't the most recent thing said; you're not confident it's genuinely worth interrupting the",
    "quiet for; or jumping in would clearly talk over someone still mid-sentence. This check has nothing to do with",
    "whether the bot is being addressed — that is handled elsewhere and is never the reason to say yes here.",
    'Reply with ONLY compact JSON: {"respond": boolean, "reason": "one short phrase"}. No other text.',
  ].join(" ");
}

/** Pull the concatenated text out of an Anthropic `messages.create` response's content blocks. */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function formatTranscript(segments: readonly { displayName: string; text: string; isFinal: boolean }[]): string {
  return segments
    .filter((s) => s.isFinal && s.text.trim().length > 0)
    .map((s) => `${s.displayName}: ${s.text}`)
    .join("\n");
}

function formatMemory(
  slices: readonly { displayName: string; facts: string[]; runningJokes: string[]; sentimentNotes?: string }[],
): string {
  return slices
    .filter((s) => s.facts.length > 0 || s.runningJokes.length > 0 || s.sentimentNotes)
    .map((s) => {
      const parts = [
        s.facts.length > 0 ? `facts: ${s.facts.join("; ")}` : "",
        s.runningJokes.length > 0 ? `running jokes: ${s.runningJokes.join("; ")}` : "",
        s.sentimentNotes ? `sentiment: ${s.sentimentNotes}` : "",
      ].filter(Boolean);
      return `${s.displayName} — ${parts.join(" | ")}`;
    })
    .join("\n");
}
