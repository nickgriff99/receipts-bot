import type { SlashCommandDefinition } from "../types";

/**
 * `/optout` — brief section 8 (compliance/consent): excludes the invoking
 * user from transcription/memory. Wired to `MemoryStore.setOptOut`; the STT/
 * turn-taking layers also check `MemoryStore.isOptedOut` and drop that
 * user's segments entirely before they ever reach turn-taking (see
 * `pipeline/orchestrator.ts#handleSegment`), not just skip persistence.
 */
export const optoutCommand: SlashCommandDefinition = {
  name: "optout",
  description: "Exclude yourself from voice transcription and memory in this server.",
  async execute(ctx) {
    await ctx.services.memory.setOptOut(ctx.guildId, ctx.userId, true);
    await ctx.reply(
      "You're opted out — your voice won't be transcribed or remembered in this server anymore. Run `/optin` to reverse this.",
    );
  },
};
