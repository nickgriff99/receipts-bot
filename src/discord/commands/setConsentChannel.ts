import type { SlashCommandDefinition } from "../types";

/**
 * `/setconsentchannel` — lets a server admin pin the consent notice
 * (`bootstrap.ts#postConsentNotice`) to a specific channel instead of
 * relying on `resolveTextChannelId`'s auto-detection (same-name voice/text
 * pair -> system channel -> first sendable channel). Gated on Manage Server,
 * same pattern as `/mode`. Wired to `MemoryStore.setGuildSettings`'s
 * `consentChannelId` field.
 */
export const setConsentChannelCommand: SlashCommandDefinition = {
  name: "setconsentchannel",
  description: "Pin the consent notice to a specific text channel instead of auto-detecting one.",
  options: [
    {
      name: "channel",
      description: "Text channel to post the consent notice in",
      required: true,
      type: "channel",
    },
  ],
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    const channelId = ctx.options.channel;
    if (!channelId) {
      await ctx.reply("Usage: `/setconsentchannel channel:#your-channel`.");
      return;
    }
    await ctx.services.memory.setGuildSettings(ctx.guildId, { consentChannelId: channelId });
    await ctx.reply(`Consent notice channel set to <#${channelId}>.`);
  },
};
