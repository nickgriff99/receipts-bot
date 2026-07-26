import { Client, GatewayIntentBits, Partials } from "discord.js";
import { logger } from "../shared/logger";

const log = logger.child("discord:client");

/**
 * Discord client bootstrap.
 *
 * Just the `Client` construction + login — everything else (slash command
 * registration/dispatch, `voiceStateUpdate` auto-join,`messageCreate`
 * explicit-trigger detection, the compliance/consent notice on join) is real
 * wiring in `discord/bootstrap.ts#DiscordBotRuntime`, which owns the actual
 * event listeners and calls `loginDiscordClient` as its first step.
 *
 * Intents: `Guilds` (baseline guild/channel caching) + `GuildVoiceStates`
 * (required by `@discordjs/voice` for any voice connection at all) +
 * `GuildMessages` + `MessageContent` (both needed to read `message.content`
 * in the paired text channel for @-mention/reply/name-trigger detection —
 * `MessageContent` is a privileged intent that must be toggled on in the
 * Discord Developer Portal, see README "Discord application setup").
 */
export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  log.info("discord client constructed (not yet logged in)");
  return client;
}

/** Called by `DiscordBotRuntime.start()` after listeners are attached, before slash command registration. */
export async function loginDiscordClient(client: Client, botToken: string): Promise<void> {
  await client.login(botToken);
}
