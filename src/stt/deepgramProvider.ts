import { DeepgramClient } from "@deepgram/sdk";
import type { STTProvider, STTSession, STTSessionOptions } from "./types";
import type { TranscriptSegment } from "./types";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";

const log = logger.child("stt:deepgram");

/** Narrow shape of the Deepgram `Results` streaming message we actually read (SDK types the full union; we only need these fields). */
interface DeepgramResultsMessage {
  type: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

/**
 * Deepgram real-time streaming STT provider — real `@deepgram/sdk` v5 wiring.
 *
 * One `client.listen.v1.connect(...)` websocket session per (guild, user)
 * pair (per `STTProvider.startSession` contract). `Authorization` is passed
 * explicitly rather than relying on the wrapped client's implicit apiKey
 * fallback — belt and braces, and matches what the raw `V1Client.ConnectArgs`
 * type requires.
 *
 * Reconnect: the underlying `core.ReconnectingWebSocket` already retries
 * transport-level drops (default `maxRetries: 30`) without losing the
 * session, so we don't need to reimplement reconnect/backoff here — we do
 * surface `close`/`error` to `options.onError` so the caller (voice
 * receiver) can decide whether to tear the session down for real.
 */
export class DeepgramSTTProvider implements STTProvider {
  readonly name = "deepgram";
  private readonly client: DeepgramClient;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new DeepgramClient({ apiKey });
  }

  startSession(options: STTSessionOptions): STTSession {
    const streamStartedAt = Date.now();
    let isOpen = false;
    let intentionallyClosed = false;

    const socketPromise = this.client.listen.v1.connect({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: options.sampleRateHz,
      channels: options.channels,
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: 300,
      Authorization: `Token ${this.apiKey}`,
    });

    socketPromise
      .then((socket) => {
        socket.on("open", () => {
          isOpen = true;
          log.debug("deepgram socket open", { guildId: options.guildId, userId: options.userId });
        });

        socket.on("message", (data) => {
          const message = data as DeepgramResultsMessage;
          if (message.type !== "Results") return;

          const alt = message.channel?.alternatives?.[0];
          if (!alt) return;
          const text = alt.transcript ?? "";
          const isFinal = !!message.is_final;

          // Interim results with no words yet are pure noise — nothing to segment.
          if (!isFinal && text.length === 0) return;

          const confidence = alt.confidence ?? 0;
          if (isFinal && confidence < options.confidenceThreshold) {
            log.debug("dropping low-confidence final segment", {
              confidence,
              threshold: options.confidenceThreshold,
              guildId: options.guildId,
              userId: options.userId,
            });
            return;
          }

          const startedAt = streamStartedAt + Math.round((message.start ?? 0) * 1000);
          const endedAt = Math.max(startedAt, startedAt + Math.round((message.duration ?? 0) * 1000));

          const segment: TranscriptSegment = {
            id: newId(),
            guildId: options.guildId,
            channelId: options.channelId,
            userId: options.userId,
            displayName: options.displayName,
            text,
            isFinal,
            confidence,
            startedAt,
            endedAt,
            language: "en",
          };
          options.onSegment(segment);
        });

        socket.on("error", (err) => {
          log.error("deepgram socket error", {
            error: err.message,
            guildId: options.guildId,
            userId: options.userId,
          });
          options.onError(err);
        });

        socket.on("close", () => {
          isOpen = false;
          if (!intentionallyClosed) {
            log.warn("deepgram socket closed unexpectedly", { guildId: options.guildId, userId: options.userId });
          }
        });

        socket.connect();
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("failed to open deepgram connection", {
          error: error.message,
          guildId: options.guildId,
          userId: options.userId,
        });
        options.onError(error);
      });

    return {
      sendAudio(chunk: Buffer) {
        if (!isOpen) return; // drop audio while (re)connecting rather than buffering unbounded
        socketPromise
          .then((socket) => {
            try {
              socket.sendMedia(chunk);
            } catch (err) {
              log.debug("failed to send audio chunk to deepgram", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })
          .catch(() => {
            // connection never opened — sendAudio is a no-op in that case, onError already fired above
          });
      },
      async finish(): Promise<void> {
        intentionallyClosed = true;
        try {
          const socket = await socketPromise;
          socket.sendCloseStream({ type: "CloseStream" });
          socket.close();
        } catch {
          // connection never opened successfully — nothing to close
        }
      },
    };
  }
}
