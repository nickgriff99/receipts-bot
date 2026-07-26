/**
 * CLI test mode — brief deliverable #9: "pipes a text transcript through
 * LLM+TTS stages without needing a live Discord connection", for testing
 * persona/latency in isolation.
 *
 * Usage:
 *   npm run cli:test -- "hey bot, settle a debate for us"
 *   echo "some line of chat" | npm run cli:test
 *
 * Runs against the real `ClaudeHaikuProvider`/`ElevenLabsTTSProvider` (no
 * Discord client, no STT, no Postgres) — genuinely calls the Anthropic and
 * ElevenLabs APIs given a real `ANTHROPIC_API_KEY`/`ELEVENLABS_API_KEY` in
 * `.env`, and reports real token/byte counts and wall-clock latency.
 *
 * Deliberately does NOT call `config/env.ts#loadConfig()` — that loader
 * validates Sam's locked `AppConfigSchema`, which also requires
 * `DISCORD_BOT_TOKEN`/`DISCORD_APPLICATION_ID`/`DEEPGRAM_API_KEY` (all
 * `min(1)`, no defaults). Routing this harness through it would mean the
 * brief's literal ask — "actually run if user supplies ANTHROPIC_API_KEY and
 * ELEVENLABS_API_KEY" — silently also requires a Discord bot application and
 * a Deepgram account to exist first, just to smoke-test persona/latency in
 * isolation. Not a bug in `AppConfigSchema` (that schema is validating the
 * full live-bot process's env correctly, its actual job) — just the wrong
 * loader for this one entrypoint. Reads only the two keys this harness
 * actually uses, with its own minimal Zod schema.
 */
import "dotenv/config";
import { z } from "zod";
import { ClaudeHaikuProvider } from "../llm/claudeProvider";
import { DEFAULT_PERSONA } from "../llm/persona";
import { ElevenLabsTTSProvider } from "../tts/elevenLabsProvider";
import type { TranscriptSegment } from "../stt/types";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";

const log = logger.child("cli:test-mode");

const CliConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required (see .env.example)"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
  ELEVENLABS_API_KEY: z.string().min(1, "ELEVENLABS_API_KEY is required (see .env.example)"),
  ELEVENLABS_VOICE_ID: z.string().min(1, "ELEVENLABS_VOICE_ID is required (see .env.example)"),
});

function loadCliConfig(): z.infer<typeof CliConfigSchema> {
  const result = CliConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    console.error(`\nMissing/invalid CLI test mode config:\n${issues}\n\nSee .env.example.\n`);
    process.exit(1);
  }
  return result.data;
}

async function main(): Promise<void> {
  const config = loadCliConfig();
  const inputText = process.argv.slice(2).join(" ").trim() || (await readStdin());

  if (!inputText) {
    console.error('Usage: npm run cli:test -- "some line of chat"  (or pipe text via stdin)');
    process.exitCode = 1;
    return;
  }

  const llm = new ClaudeHaikuProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  const tts = new ElevenLabsTTSProvider(config.ELEVENLABS_API_KEY);

  const now = Date.now();
  const segment: TranscriptSegment = {
    id: newId(),
    guildId: "cli-test-guild",
    channelId: "cli-test-channel",
    userId: "cli-test-user",
    displayName: "CLI Tester",
    text: inputText,
    isFinal: true,
    confidence: 1,
    startedAt: now - 1000,
    endedAt: now,
  };

  const speechEndAt = segment.endedAt;

  log.info("generating response", { inputText });
  const response = await llm.generateResponse({
    guildId: segment.guildId,
    channelId: segment.channelId,
    persona: DEFAULT_PERSONA,
    recentTranscript: [segment],
    memoryContext: [],
    triggerReason: "cli explicit test input",
  });

  console.log(`\nBot text: ${response.text}`);
  if (response.tone) console.log(`Bot tone: ${response.tone}`);
  console.log(`LLM tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);

  if (response.text.trim().length === 0) {
    console.log("(empty response — nothing to synthesize, matches orchestrator.ts's skip-TTS-on-empty-text behavior)");
    return;
  }

  log.info("synthesizing speech");
  let totalBytes = 0;
  for await (const chunk of tts.synthesizeStream({ text: response.text, tone: response.tone, voiceId: config.ELEVENLABS_VOICE_ID })) {
    totalBytes += chunk.length;
  }
  const latencyMs = Date.now() - speechEndAt;
  console.log(`Synthesized audio bytes: ${totalBytes}`);
  console.log(`End-to-end latency (mock speech-end -> synthesis complete): ${latencyMs}ms`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

main().catch((err) => {
  log.error("cli test mode failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
