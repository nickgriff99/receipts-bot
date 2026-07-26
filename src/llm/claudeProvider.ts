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
    const system = [
      `You are the ambient-response gate for "${input.persona.name}", a chatty, quick-witted Discord voice co-host who loves to talk.`,
      "Given the most recent snippet of live voice-chat transcript, decide whether the bot should chime in RIGHT NOW.",
      "Default strongly to YES — this co-host is very talkative and jumps into the conversation constantly with quips,",
      "reactions, questions, and commentary. Say yes for almost anything: a joke, a reaction, an observation, a follow-up",
      "question, or just riffing on whatever was said. Only say no in the rare case where jumping in would clearly talk",
      "over someone who is still mid-sentence, or would step on a genuinely serious or sensitive moment.",
      'Reply with ONLY compact JSON: {"respond": boolean, "reason": "one short phrase"}. No other text.',
    ].join(" ");

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

    const system = [
      request.persona.systemPrompt,
      `Reply with ONLY compact JSON: {"text": "your spoken reply", "tone": "one word, optional"}.`,
      `Keep "text" to at most ${request.persona.maxResponseSentences} sentences.`,
      "If there is truly nothing worth saying, reply with {\"text\": \"\"}.",
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
