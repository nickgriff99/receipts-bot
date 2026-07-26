/**
 * Process entrypoint — builds the full dependency graph and starts the
 * live Discord bot: login, slash command registration, voice join/leave,
 * per-user receive -> VAD -> STT -> pipeline orchestrator, and TTS
 * playback with barge-in.
 *
 * Run `npm run cli:test` instead for a live-Discord-free smoke test of the
 * LLM+TTS stages only.
 */
import { createDiscordClient } from "./discord/client";
import { DiscordPlaybackController } from "./discord/voice/player";
import { DiscordBotRuntime } from "./discord/bootstrap";
import { loadConfig } from "./config/env";
import { DeepgramSTTProvider } from "./stt/deepgramProvider";
import { ClaudeHaikuProvider } from "./llm/claudeProvider";
import { DEFAULT_PERSONA } from "./llm/persona";
import { ElevenLabsTTSProvider } from "./tts/elevenLabsProvider";
import { PostgresMemoryStore } from "./memory/postgresStore";
import { InMemoryRateLimiter } from "./pipeline/rateLimiter";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { buildHttpApp, startHttpServer } from "./http/server";
import { logger } from "./shared/logger";

const log = logger.child("bootstrap");

async function main(): Promise<void> {
  const config = loadConfig();

  const memory = new PostgresMemoryStore(config.storage.databaseUrl, config.defaults);
  const llm = new ClaudeHaikuProvider(config.anthropic.apiKey, config.anthropic.model);
  const tts = new ElevenLabsTTSProvider(config.elevenlabs.apiKey);
  const playback = new DiscordPlaybackController();
  const rateLimiter = new InMemoryRateLimiter(async (guildId) => {
    const settings = await memory.getGuildSettings(guildId);
    return { maxResponsesPerMinute: settings.maxResponsesPerMinute, minGapSeconds: settings.minGapSeconds };
  });

  const orchestrator = new PipelineOrchestrator({
    llm,
    tts,
    memory,
    playback,
    rateLimiter,
    persona: DEFAULT_PERSONA,
    voiceId: config.elevenlabs.defaultVoiceId,
  });

  const stt = new DeepgramSTTProvider(config.deepgram.apiKey);
  const client = createDiscordClient();

  const runtime = new DiscordBotRuntime({
    client,
    config,
    memory,
    stt,
    orchestrator,
    persona: DEFAULT_PERSONA,
    playback,
  });

  const httpApp = buildHttpApp({ memory, mode: config.defaults.mode, adminApiToken: config.http.adminApiToken });
  const httpServer = startHttpServer(httpApp, config.http.port);

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    try {
      await runtime.shutdown();
    } catch (err) {
      log.error("error during runtime shutdown", { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await memory.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runtime.start();

  log.info("receipts-bot running", { mode: config.defaults.mode, httpPort: config.http.port });
}

main().catch((err) => {
  logger.child("bootstrap").error("fatal startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exitCode = 1;
});
