import type { SlashCommandDefinition } from "../types";

/**
 * `/quiet` — brief section 3 / stakeholder decision: literal single-purpose
 * command alongside `/active`, for admins who'd rather run a one-word
 * command than remember `/mode value:quiet`. Same underlying
 * `MemoryStore.setGuildSettings` call as `mode.ts`'s `value:quiet` branch —
 * kept as a thin alias rather than duplicating logic.
 */
export const quietCommand: SlashCommandDefinition = {
  name: "quiet",
  description: "Switch the bot to quiet mode — only responds when explicitly addressed (@-mention/reply/name).",
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    await ctx.services.memory.setGuildSettings(ctx.guildId, { mode: "quiet" });
    await ctx.reply("Mode set to **quiet** — I'll only respond when directly addressed.");
  },
};
