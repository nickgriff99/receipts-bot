import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, type AudioPlayer, type VoiceConnection } from "@discordjs/voice";
import { Readable } from "node:stream";
import type { PlaybackController, PlaybackPriority } from "../types";
import { logger } from "../../shared/logger";

const log = logger.child("voice:player");

interface GuildPlaybackState {
  player: AudioPlayer;
  currentAbort?: AbortController;
}

/**
 * Playback + barge-in controller — the "AudioPlayer playback (with barge-
 * in/interrupt support)" stage of the pipeline. See ARCHITECTURE.md
 * "Barge-in design" for the full interrupt policy.
 *
 * The AudioPlayer wiring itself (createAudioPlayer/createAudioResource/
 * subscribe/stop) is real, generic @discordjs/voice plumbing with no
 * external-service dependency, so it's implemented for real here. What's
 * still a stub is the TTS byte stream this gets fed (tts/elevenLabsProvider
 * .ts) and the actual `connection.subscribe(player)` call site, both of
 * which land in Merry's Discord-wiring pass alongside the receiver.
 */
export class DiscordPlaybackController implements PlaybackController {
  private readonly guildStates = new Map<string, GuildPlaybackState>();

  /** Merry: call once per guild after `VoiceSessionManager.join()` succeeds. */
  attach(guildId: string, connection: VoiceConnection): AudioPlayer {
    const existing = this.guildStates.get(guildId);
    if (existing) {
      // Reused player from a prior join/leave cycle — its old subscription
      // died with the old (destroyed) VoiceConnection. Without this, the
      // player has zero subscribers, defaults to noSubscriber: "pause", and
      // silently never reaches Idle — see player.ts bug writeup.
      connection.subscribe(existing.player);
      return existing.player;
    }

    const player = createAudioPlayer();
    connection.subscribe(player);
    this.guildStates.set(guildId, { player });

    player.on("error", (err) => log.error("audio player error", { guildId, error: err.message }));
    return player;
  }

  async play(guildId: string, audio: AsyncIterable<Buffer>, opts: { priority: PlaybackPriority }): Promise<void> {
    const state = this.guildStates.get(guildId);
    if (!state) {
      log.warn("play() called before attach() — no voice connection for guild", { guildId });
      return;
    }

    if (this.isSpeaking(guildId)) {
      if (opts.priority === "explicit") {
        log.info("barge-in: explicit trigger interrupting current playback", { guildId });
        this.interrupt(guildId);
      } else {
        // Ambient chimes do not interrupt the bot's own current speech —
        // conservative default, see ARCHITECTURE.md. Caller (orchestrator)
        // should generally not even reach here for ambient while speaking,
        // this is a defensive no-op.
        log.debug("ambient playback request skipped — bot already speaking", { guildId });
        return;
      }
    }

    const abortController = new AbortController();
    state.currentAbort = abortController;

    const resource = createAudioResource(Readable.from(audio, { signal: abortController.signal }), {
      inputType: StreamType.Arbitrary,
    });
    state.player.play(resource);
    log.info("audio resource handed to player", { guildId });

    await new Promise<void>((resolve) => {
      const onStateChange = (oldState: { status: string }, newState: { status: string }) => {
        log.debug("audio player state change", { guildId, from: oldState.status, to: newState.status });
      };
      const onIdle = () => {
        state.player.off(AudioPlayerStatus.Idle, onIdle);
        state.player.off("stateChange", onStateChange);
        log.info("playback finished (player idle)", { guildId, playedMs: resource.playbackDuration });
        resolve();
      };
      state.player.on(AudioPlayerStatus.Idle, onIdle);
      state.player.on("stateChange", onStateChange);
    });
  }

  interrupt(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;
    state.currentAbort?.abort();
    state.player.stop(true);
  }

  isSpeaking(guildId: string): boolean {
    const state = this.guildStates.get(guildId);
    return state?.player.state.status === AudioPlayerStatus.Playing;
  }
}
