import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, type VoiceConnection } from "@discordjs/voice";
import type { VoiceSessionManager } from "../types";
import { logger } from "../../shared/logger";

const log = logger.child("voice:connection");

/**
 * Voice channel join/leave — brief section 1 (`/join`, `/leave`,
 * configurable auto-join-on-user-entry).
 *
 * STUB-ish: `joinVoiceChannel` needs a real `adapterCreator`, which only
 * exists on a discord.js `Guild` object (`guild.voiceAdapterCreator`) — so
 * this class takes an adapter-creator resolver function rather than
 * importing discord.js's `Client`/`Guild` types directly, keeping this
 * module testable without a live gateway connection. Merry wires the
 * resolver against the real client + hooks up `/join`, `/leave`, and
 * voiceStateUpdate-based auto-join to call these methods.
 */
export class VoiceConnectionManager implements VoiceSessionManager {
  constructor(
    private readonly resolveAdapterCreator: (guildId: string) => unknown /* discord.js DiscordGatewayAdapterCreator */,
  ) {}

  async join(guildId: string, channelId: string): Promise<VoiceConnection> {
    const existing = getVoiceConnection(guildId);
    if (existing && existing.joinConfig.channelId === channelId) return existing;

    const connection = joinVoiceChannel({
      guildId,
      channelId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapterCreator: this.resolveAdapterCreator(guildId) as any,
      selfDeaf: false, // must hear users to transcribe them
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    log.info("joined voice channel", { guildId, channelId });
    return connection;
  }

  leave(guildId: string): void {
    const connection = getVoiceConnection(guildId);
    if (!connection) return;
    connection.destroy();
    log.info("left voice channel", { guildId });
  }

  isConnected(guildId: string): boolean {
    return getVoiceConnection(guildId) !== undefined;
  }

  getConnection(guildId: string): VoiceConnection | undefined {
    return getVoiceConnection(guildId);
  }
}
