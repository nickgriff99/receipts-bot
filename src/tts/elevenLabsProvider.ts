import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { TTSProvider, TTSRequest } from "./types";
import { logger } from "../shared/logger";

const log = logger.child("tts:elevenlabs");

/** Low-latency streaming model — fits the "must stream, not wait for full file" + budget/latency targets (brief section 6/7). */
const STREAMING_MODEL_ID = "eleven_flash_v2_5";

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

/** Spoken plain-text fallback played when ElevenLabs fails after retries — never leaves the bot silently mute mid-conversation. */
export const TTS_FALLBACK_MESSAGE = "Sorry, I'm having trouble finding my voice right now.";

/**
 * ElevenLabs streaming TTS provider — real `@elevenlabs/elevenlabs-js` v2
 * wiring.
 *
 * `textToSpeech.stream()` returns a web `ReadableStream<Uint8Array>`
 * (`HttpResponsePromise<ReadableStream<Uint8Array>>`, which is itself a
 * thenable) — adapted here to `AsyncIterable<Buffer>` via
 * `Readable.fromWeb` so `discord/voice/player.ts` can pipe it straight into
 * an `@discordjs/voice` audio resource without buffering the whole
 * utterance.
 *
 * Retry: transient failures (network blip, momentary rate limit) get a
 * couple of short backoff retries before giving up; a genuine failure after
 * retries raises so the orchestrator can fall back rather than silently
 * producing zero audio — callers that want a spoken apology instead of a
 * thrown error should catch and speak `TTS_FALLBACK_MESSAGE` themselves (see
 * `pipeline/orchestrator.ts`).
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = "elevenlabs";
  private readonly client: ElevenLabsClient;

  constructor(apiKey: string) {
    this.client = new ElevenLabsClient({ apiKey });
  }

  async *synthesizeStream(request: TTSRequest, signal?: AbortSignal): AsyncIterable<Buffer> {
    log.debug("synthesizing speech", { voiceId: request.voiceId, textLength: request.text.length });

    if (request.text.trim().length === 0) {
      log.debug("skipping synthesis for empty text");
      return;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) return;
      try {
        const webStream = await this.client.textToSpeech.stream(
          request.voiceId,
          {
            text: request.text,
            modelId: STREAMING_MODEL_ID,
            // mp3 (not a Pro-tier-gated raw PCM format) — @discordjs/voice's
            // StreamType.Arbitrary runs this through ffmpeg/prism-media,
            // which auto-probes containerized formats like mp3 reliably;
            // headerless raw PCM would need an explicit format hint ffmpeg
            // doesn't get here, so mp3 is the safer choice for arbitrary
            // playback regardless of ElevenLabs plan tier.
            outputFormat: "mp3_44100_128",
          },
          { abortSignal: signal },
        );

        const nodeStream = Readable.fromWeb(webStream, { signal });
        for await (const chunk of nodeStream) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        }
        return;
      } catch (err) {
        if (signal?.aborted) return; // barge-in cut the request short — not a real failure
        lastError = err;
        log.warn("elevenlabs stream attempt failed", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < MAX_RETRIES) {
          await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        }
      }
    }

    log.error("elevenlabs synthesis failed after retries", {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof Error ? lastError : new Error("ElevenLabs synthesis failed");
  }
}
