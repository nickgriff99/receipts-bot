import type { SlashCommandDefinition } from "../types";

/**
 * `/clearcontext` — clears whatever `/setcontext` (or the HTTP admin route)
 * set, before its TTL would otherwise expire it. Wired to
 * `MemoryStore.clearLiveContextOverride`. Gated on Manage Server, same as
 * `/setcontext`.
 */
export const clearContextCommand: SlashCommandDefinition = {
  name: "clearcontext",
  description: "Clear the bot's temporary live-context override, if one is set.",
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    await ctx.services.memory.clearLiveContextOverride(ctx.guildId);
    await ctx.reply("Live context override cleared.");
  },
};
