import type { SlashCommandDefinition } from "../types";

/**
 * `/active` — brief section 3 / stakeholder decision: literal single-purpose
 * command alongside `/quiet` (default mode is active/ambient — see
 * ARCHITECTURE.md). Same underlying `MemoryStore.setGuildSettings` call as
 * `mode.ts`'s `value:active` branch — kept as a thin alias rather than
 * duplicating logic.
 */
export const activeCommand: SlashCommandDefinition = {
  name: "active",
  description: "Switch the bot to active mode — chimes in ambiently during pauses, not just when addressed.",
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    await ctx.services.memory.setGuildSettings(ctx.guildId, { mode: "active" });
    await ctx.reply("Mode set to **active** — I'll chime in ambiently during natural pauses again.");
  },
};
