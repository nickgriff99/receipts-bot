import type { TranscriptSegment } from "../stt/types";
import type { LLMProvider, PersonaConfig } from "../llm/types";
import type { TTSProvider } from "../tts/types";
import type { MemoryStore, TurnOutcome, TurnOutcomeCategory } from "../memory/types";
import type { PlaybackController, PlaybackPriority } from "../discord/types";
import type { RateLimiter } from "./types";
import type { TriggerType, TurnCandidate } from "./types";
import { isExplicitTrigger, PROACTIVE_TRIGGER_USER_ID, SESSION_START_TRIGGER_USER_ID } from "./types";
import { TurnTakingEngine } from "./turnTaking";
import { ContextAssembler } from "./contextAssembler";
import {
  ACTIVE_THREAD_TTL_MS,
  BOT_SPEAKER_ID,
  CONTEXT_WINDOW_UTTERANCES,
  LATENCY_WARN_THRESHOLD_MS,
  MAX_RECENT_TONES_PER_GUILD,
  PLAYBACK_AWAIT_TIMEOUT_MS,
} from "../config/constants";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:orchestrator");

/**
 * One unit of work for a guild's serialized turn queue. `segment` is
 * present for STT/text-mention-driven turns (everything that comes through
 * `handleSegment`) and `undefined` for timer-driven proactive turns
 * (`maybeFireProactiveTurn`) — there is no real utterance to anchor those
 * to. `runTurn` uses its presence/absence to decide whether segment-only
 * bookkeeping (memory-fact extraction attributed to a speaker, speech-end
 * latency measurement) applies to this turn.
 */
interface TurnWorkItem {
  guildId: string;
  channelId: string;
  triggerType: TriggerType;
  triggeringUserId: string;
  segment?: TranscriptSegment;
  /**
   * Social-presence round — free-text override threaded onto
   * `TurnCandidate.contextHint` for member_joined/member_left/session_start
   * turns (see pipeline/types.ts's doc comment on that field). `undefined`
   * for every other trigger type.
   */
  contextHint?: string;
  /**
   * Conversation-continuity round (Merry, wiring pass) — display name for
   * `triggeringUserId`, needed by `setActiveThread` on trigger types that
   * have no `segment` to pull a display name from (currently only
   * `member_joined` — see `ACTIVE_THREAD_ELIGIBLE_TRIGGERS`'s doc comment).
   * Every OTHER active-thread-eligible trigger type always carries a
   * `segment` (all come through `handleSegment`), so this stays `undefined`
   * there and `runTurn` prefers `segment.displayName` when both are present.
   */
  triggeringDisplayName?: string;
}

/**
 * How long after a non-explicit (ambient_pause or proactive) bot reply
 * finishes playing to wait for human engagement before calling it a flop —
 * adaptive-cadence learning layer, social-presence round (frodo). A local
 * implementation heuristic (mirrors `PROACTIVE_ACTIVITY_LOOKBACK_MS` in
 * turnTaking.ts), not a stakeholder-tunable config knob this round.
 */
const ENGAGEMENT_FOLLOWUP_WINDOW_MS = 45_000;

/**
 * One guild's open "did that turn land" question — set right after a
 * non-explicit bot reply is spoken, cleared (and resolved) either by the
 * next qualifying human segment (`resolveEngagementOnHumanSegment`) or by
 * `expireStaleEngagementIfNeeded` once `deadline` has passed with nothing
 * heard. See `PipelineOrchestrator`'s class doc comment on
 * `pendingEngagementByGuild` for the full operational definition of
 * landed/flopped.
 */
interface PendingEngagement {
  botSpeechEndedAt: number;
  deadline: number;
  /**
   * Conversation-continuity round (task 6) — which `TurnOutcomeCategory`
   * this window belongs to, threaded straight from `TurnDecision.category`
   * so the eventual landed/flopped resolution gets recorded against the
   * right situation-type bucket instead of one guild-wide lump.
   */
  category: TurnOutcomeCategory;
}

/**
 * One open "the bot is currently mid-conversation with this specific
 * person" window (task 1, conversation-continuity round) — the code-level,
 * deterministic fix for the "Nick" scenario: the bot explicitly addresses
 * someone (or replies to their ambient comment), they reply WITHOUT saying
 * the bot's name again, and that reply should still reliably continue the
 * exchange rather than rolling the dice on the generic ambient cheap-gate.
 *
 * Set in `runTurn` right after a turn that (a) produced a real, non-empty
 * spoken reply, and (b) was clearly directed at/prompted by a specific real
 * user — see `qualifiesForActiveThread`'s doc comment for the exact
 * trigger-type allowlist. Consumed by `getActiveThreadContinuation`, which
 * `runTurn` calls when building the NEXT `ambient_pause` candidate's
 * `TurnCandidate.activeThreadContinuation` field — `TurnTakingEngine.decide`
 * treats its presence as at least as reliable as an explicit trigger.
 *
 * TTL-based, not resolved/cleared by a reply the way `PendingEngagement`
 * is — deliberately simple for v1 (a real reply from that person before
 * `expiresAt` just naturally produces a NEW active-thread window from that
 * turn, extending the conversation; there's no need to explicitly "close"
 * the old one early). Per-guild, per-user map (not a single guild-wide
 * slot) since more than one person could plausibly be mid-exchange with the
 * bot inside the same TTL window, however rare in practice.
 */
interface ActiveThreadState {
  displayName: string;
  expiresAt: number;
}

/**
 * Per-guild turn queue state (concurrency fix — bugs/nazgul round).
 *
 * `handleSegment` used to be called fire-and-forget (bootstrap.ts) with no
 * serialization at all: every final transcript segment from any speaker
 * spawned a fresh concurrent run of the expensive tail (turn-taking decide
 * -> Claude generateResponse -> TTS synth -> playback -> Claude
 * extractMemoryFacts). With 2+ people talking, segments arrive faster than
 * one turn drains, so in-flight turns piled up unbounded on the single
 * Node event loop -> latency climbed turn over turn (3s -> 59s observed),
 * Discord interaction acks missed their ~3s window, Deepgram sockets
 * dropped from starved keepalives.
 *
 * Fix: at most one turn's expensive tail in flight per guild. A candidate
 * that arrives while a turn is running for that guild does not spawn a
 * concurrent run and is not queued unboundedly either — it replaces
 * whatever was previously pending (bounded depth 1). The conversation has
 * moved on by the time a stale pending turn would run, so processing it
 * would be wasted latency/cost for a turn no longer relevant — better to
 * only ever run the most recent candidate next. Cheap bookkeeping (history
 * append, conversation log, STT usage log) still happens synchronously for
 * every segment in `handleSegment` itself, before enqueueing — only the
 * expensive decide/generate/speak tail is serialized+deduped.
 *
 * Proactive turns (`maybeFireProactiveTurn`) feed into this SAME queue as a
 * `TurnWorkItem` with no `segment` — they are not a bypass path. A
 * proactive candidate arriving while a turn is in flight is subject to the
 * exact same newest-wins-depth-1 rule as an ambient segment, including the
 * "pending explicit mention outranks incoming non-explicit candidate"
 * special case below (proactive is non-explicit, same as ambient_pause).
 */
interface GuildTurnQueue {
  running: boolean;
  pending: TurnWorkItem | null;
}

export interface OrchestratorDeps {
  llm: LLMProvider;
  tts: TTSProvider;
  memory: MemoryStore;
  playback: PlaybackController;
  rateLimiter: RateLimiter;
  persona: PersonaConfig;
  voiceId: string;
  /**
   * Proactive chime-in config. Optional/additive (matches the
   * `DEFAULT_AUTO_JOIN_ON_USER_ENTRY` precedent in config/types.ts) so this
   * doesn't force a breaking change at any call site that omits it —
   * `intervalSeconds` falls back to `TurnTakingEngine`'s own default, and
   * `enabled` defaults to on (undefined `proactive` or undefined `enabled`
   * both mean "not turned off"). Wired from `AppConfig.defaults`
   * (`proactiveChimeIntervalSeconds`/`proactiveChimeEnabled`) at the
   * `index.ts` construction site (Sam, config-lock round).
   */
  proactive?: { intervalSeconds: number; enabled: boolean };
}

/**
 * Top-level pipeline orchestrator — the single place that wires:
 *
 *   TranscriptSegment (in, from STT via discord/voice/receiver.ts)
 *     -> turn-taking decision (explicit trigger OR ambient cheap-gate OR
 *        proactive timer-driven candidate, via `maybeFireProactiveTurn` —
 *        no TranscriptSegment involved for that path, see its doc comment)
 *     -> [rate limiter]
 *     -> context assembly (transcript window + per-user memory + persona)
 *     -> LLM full response
 *     -> TTS streaming synthesis
 *     -> playback (with barge-in priority)
 *     -> post-hoc memory-fact extraction -> Postgres profile update
 *        (skipped for proactive turns — no speaker to attribute facts to)
 *
 * Every dependency is injected via `OrchestratorDeps` so Merry can swap in
 * real Deepgram/Anthropic/ElevenLabs/Discord implementations without
 * touching this control flow. Nothing in this file imports a concrete
 * provider — only the interfaces from stt/llm/tts/memory/discord's
 * types.ts files.
 */
export class PipelineOrchestrator {
  private readonly turnTaking: TurnTakingEngine;
  private readonly contextAssembler: ContextAssembler;
  private readonly historyByGuild = new Map<string, TranscriptSegment[]>();
  private readonly turnQueueByGuild = new Map<string, GuildTurnQueue>();
  /**
   * Tone-variety mechanism (Merry): rolling per-guild history of the bot's
   * own last few `LLMResponse.tone` values, oldest first, capped at
   * `MAX_RECENT_TONES_PER_GUILD`. Fed into `ContextAssembler.assemble` so
   * `generateResponse`'s prompt can name what it just did and ask for a
   * different mode — plain in-memory, same lifetime/reset-on-restart
   * tradeoff as `historyByGuild`, no new DB schema.
   */
  private readonly toneHistoryByGuild = new Map<string, string[]>();
  /**
   * Adaptive-cadence learning layer (social-presence round): one open
   * engagement question per guild at a time, keyed by guildId. Set in
   * `runTurn` right after a non-explicit (ambient_pause/proactive) turn
   * finishes its TTS/playback attempt (success or failure — either way the
   * bot has finished trying to speak); resolved to "landed"/"flopped" and
   * cleared by `resolveEngagementOnHumanSegment` (called from every
   * `handleSegment`) or expired to "flopped" by
   * `expireStaleEngagementIfNeeded` (called from `handleSegment` and
   * `maybeFireProactiveTurn`, both of which run often enough while the bot
   * is connected to catch an expired window in reasonable time without a
   * dedicated timer). If a NEW non-explicit turn fires while a previous
   * window is still open, the previous one is silently discarded unresolved
   * (overwritten, not double-counted) — see `runTurn`'s doc comment at the
   * point it sets this.
   */
  private readonly pendingEngagementByGuild = new Map<string, PendingEngagement>();
  /**
   * Active conversation-thread tracker (task 1, conversation-continuity
   * round) — see `ActiveThreadState`'s doc comment above for the full
   * operational definition. Keyed guildId -> userId -> state.
   */
  private readonly activeThreadByGuild = new Map<string, Map<string, ActiveThreadState>>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.turnTaking = new TurnTakingEngine(deps.llm, deps.rateLimiter, deps.memory, deps.proactive?.intervalSeconds);
    this.contextAssembler = new ContextAssembler(deps.memory);
  }

  /**
   * Entry point called once per FINAL transcript segment (partials are not
   * turn-taking candidates, though they may still be worth logging/showing
   * live elsewhere — that's discord/voice/receiver.ts's call, not this
   * method's). `triggerType` is decided upstream by whatever detected the
   * segment (explicit mention/reply/name-match text scan, or the natural-
   * pause ambient detector).
   */
  async handleSegment(segment: TranscriptSegment, triggerType: TriggerType): Promise<void> {
    // Safety-net check, mirroring the existing isOptedOut belt-and-braces
    // pattern below (see discord/commands/optout.ts's doc comment — STT/
    // turn-taking layers both check deliberately). Both current callers
    // (discord/bootstrap.ts's handleMessageCreate and handleTranscriptSegment)
    // already gate on hasAcceptedConsent before ever reaching here, so this
    // should never trip in the current call graph — it's here so a future
    // caller of handleSegment can't accidentally skip the consent gate.
    if (!(await this.deps.memory.hasAcceptedConsent(segment.guildId, segment.userId))) {
      log.debug("dropping segment from user who has not accepted consent", { guildId: segment.guildId, userId: segment.userId });
      return;
    }
    if (await this.deps.memory.isOptedOut(segment.guildId, segment.userId)) {
      log.debug("dropping segment from opted-out user", { guildId: segment.guildId, userId: segment.userId });
      return;
    }

    // Adaptive-cadence learning layer (social-presence round): resolve any
    // open engagement question for this guild against this segment BEFORE
    // touching history/queueing — a real, consented, non-opted-out human
    // final segment is exactly the signal this mechanism watches for. See
    // `pendingEngagementByGuild`'s doc comment for the full definition.
    this.expireStaleEngagementIfNeeded(segment.guildId);
    this.resolveEngagementOnHumanSegment(segment);

    this.appendHistory(segment);
    await this.deps.memory.appendConversationLog({ ...segment, loggedAt: Date.now() });

    // STT usage audit trail (brief section 7). Deepgram actually bills by
    // audio-duration, not characters — this logs transcript character
    // count as an auditable activity proxy (the thing the SDK response
    // actually exposes per segment), not a literal dollar-cost mirror.
    // Flagged here rather than silently presented as exact.
    if (segment.isFinal && segment.text.length > 0) {
      await this.deps.memory.logUsage({
        guildId: segment.guildId,
        service: "stt",
        unitType: "characters",
        units: segment.text.length,
        occurredAt: Date.now(),
      });
    }

    // Expensive tail (turn-taking decision -> Claude -> TTS -> playback ->
    // memory extraction) is serialized per guild — see GuildTurnQueue doc
    // comment above. Not awaited here: callers (bootstrap.ts) only need the
    // cheap bookkeeping above to have happened before this method resolves,
    // same as before this fix (they never relied on `handleSegment`'s
    // promise resolving only once the bot finished speaking).
    this.enqueueTurn({
      guildId: segment.guildId,
      channelId: segment.channelId,
      triggerType,
      triggeringUserId: segment.userId,
      segment,
    });
  }

  /**
   * Timer-driven trigger — brief's proactive-chime-in ask. Call this
   * periodically (e.g. every 15-30s) while the bot is connected to a voice
   * channel; whoever tracks voice-channel presence (Merry:
   * discord/voice/connectionManager.ts or wherever participants are
   * tracked) owns deciding WHEN to call it — this method assumes the caller
   * only calls it while genuinely connected. No new `TranscriptSegment`
   * exists for this trigger, so it builds a segment-less `TurnWorkItem` and
   * feeds it into the exact same per-guild `GuildTurnQueue` as
   * `handleSegment` (see that interface's doc comment) — actual cadence
   * (~once per configured interval) and the "don't fire into silence"
   * check both happen downstream in `TurnTakingEngine.decide`, not here.
   * This is deliberate: the in-memory transcript history this reads
   * (`historyFor`, populated only in `handleSegment`) already excludes
   * segments from users who haven't accepted consent or have opted out —
   * so "is there anything worth riffing on" is already consent-filtered by
   * construction, with no separate participant/consent check needed here.
   */
  async maybeFireProactiveTurn(guildId: string, channelId: string): Promise<void> {
    // Master off-switch (`AppConfig.defaults.proactiveChimeEnabled`) — checked
    // here, not just left to whether Merry's timer calls this method, so a
    // deployment can kill the feature via env var alone even if a caller
    // still ticks. `undefined` (deps.proactive omitted, or `enabled` omitted)
    // means "not disabled" — same optional/additive convention as the rest
    // of `OrchestratorDeps.proactive`.
    if (this.deps.proactive?.enabled === false) return;

    // Adaptive-cadence learning layer: the proactive timer ticks
    // periodically regardless of ambient activity (per bootstrap.ts), so
    // this is the reliable place to catch an engagement window that would
    // otherwise never expire during a quiet stretch.
    this.expireStaleEngagementIfNeeded(guildId);

    this.enqueueTurn({
      guildId,
      channelId,
      triggerType: "proactive",
      triggeringUserId: PROACTIVE_TRIGGER_USER_ID,
    });
  }

  /**
   * New-member-joins-while-bot-already-connected trigger (social-presence
   * round). Caller (Merry: `discord/bootstrap.ts`'s `VoiceStateUpdate`
   * listener) is responsible for detecting the actual "a non-bot member's
   * `channelId` transitioned INTO the channel the bot is already connected
   * to" event and resolving `displayName` (reuse `resolveDisplayName`) —
   * this method assumes that's already been decided and just handles the
   * greeting mechanism.
   *
   * Privacy gating (deliberately asymmetric vs. `handleMemberLeftVoice`
   * below — documented, not an oversight):
   * - Opted-out users: skip entirely. Same hard exclusion as everywhere
   *   else in the pipeline.
   * - Never-consented users: still greet, but generically. A brand-new
   *   user's very first join is, structurally, always a never-consented
   *   join (they haven't seen the consent notice yet) — gating the
   *   greeting on `hasAcceptedConsent` the same way `handleSegment` gates
   *   STT would silence the exact "introduce yourself to someone new"
   *   scenario this feature exists for. The generic branch below never
   *   references facts (there structurally are none for a never-consented
   *   user in this codebase's write paths — facts are only ever written
   *   post-turn from a `handleSegment` call, which itself requires
   *   consent), and the prompt is told explicitly not to invent any, as a
   *   second layer of defense.
   *
   * Returning-vs-new differentiation happens entirely through
   * `contextHint` (fed straight into `LLMRequest.triggerReason` — no new
   * LLM-contract field needed) plus the synthetic transcript segment
   * attributed to the joining user's REAL id, which lets
   * `ContextAssembler`'s existing speaker-based memory lookup pick up their
   * profile with zero new plumbing (mirrors `appendBotReply`'s established
   * pattern of synthesizing a segment to get something into the shared
   * history/memory path).
   */
  async handleMemberJoinedVoice(guildId: string, channelId: string, userId: string, displayName: string): Promise<void> {
    if (await this.deps.memory.isOptedOut(guildId, userId)) {
      log.debug("skipping join greeting — opted out", { guildId, userId });
      return;
    }

    const consented = await this.deps.memory.hasAcceptedConsent(guildId, userId);
    const profile = consented ? await this.deps.memory.getProfile(guildId, userId) : undefined;
    const hasMemory = !!profile && (profile.facts.length > 0 || profile.runningJokes.length > 0 || !!profile.sentimentNotes);

    const contextHint = !consented
      ? `${displayName} just joined the voice channel and has not accepted the voice-listening consent notice yet, so you have no real memory of them and must not invent any — give a brief, generic, friendly hello introducing yourself, and mention they can click Accept in the text channel if they want you to actually listen and remember them.`
      : hasMemory
        ? `${displayName} just rejoined the voice channel and you've talked with them before — greet them like a returning face, briefly referencing something you genuinely remember about them below. Keep it natural and brief, don't just recite a list of facts.`
        : `${displayName} just joined the voice channel — you don't have anything memorable stored about them yet, so give them a brief, friendly first-time-style introduction of yourself.`;

    const now = Date.now();
    this.appendHistory({
      id: `join-${now}-${Math.random().toString(36).slice(2, 8)}`,
      guildId,
      channelId,
      userId,
      displayName,
      text: "(joined the voice channel)",
      isFinal: true,
      confidence: 1,
      startedAt: now,
      endedAt: now,
    });

    this.enqueueTurn({
      guildId,
      channelId,
      triggerType: "member_joined",
      triggeringUserId: userId,
      contextHint,
      triggeringDisplayName: displayName,
    });
  }

  /**
   * Member-leaves-while-bot-still-connected trigger (social-presence
   * round) — the snarky-farewell ask. Same caller responsibility as
   * `handleMemberJoinedVoice` (detect the real leave event upstream).
   *
   * Privacy gating is intentionally NOT symmetric with the join path:
   * never-consented users are skipped entirely here, not given a generic
   * farewell. Reasoning: a join-greeting has onboarding value even without
   * memory (it's an invitation to accept the consent notice); a farewell
   * has no equivalent upside for someone the bot never had standing to
   * listen to in the first place, so there's no reason to comment on them
   * leaving at all.
   *
   * Meanness guardrail: no special-case code here — the persona's existing
   * system-prompt guardrail ("never genuinely mean... drop the sarcasm and
   * go warm if someone seems genuinely upset", `llm/persona.ts`) already
   * applies uniformly to every `generateResponse` call, farewells
   * included, since this reuses the exact same generation path as
   * everything else. Flagged as a nuance, not fully solved: judging
   * whether "the recent conversation felt genuinely serious" from
   * transcript context alone is imperfect — worth live listening feedback
   * like last round's cheap-gate rebalance.
   */
  async handleMemberLeftVoice(guildId: string, channelId: string, userId: string, displayName: string): Promise<void> {
    if (await this.deps.memory.isOptedOut(guildId, userId)) {
      log.debug("skipping farewell — opted out", { guildId, userId });
      return;
    }
    if (!(await this.deps.memory.hasAcceptedConsent(guildId, userId))) {
      log.debug("skipping farewell — never accepted consent, no standing to comment on them leaving", { guildId, userId });
      return;
    }

    const contextHint = `${displayName} just left the voice channel — give a brief, snarky/playful remark about it (never genuinely mean, never targeting real sensitive traits like appearance/identity/ability). If the recent conversation felt genuinely serious or heavy, dial it back to something warmer or lower-key instead, per your usual guardrail.`;

    const now = Date.now();
    this.appendHistory({
      id: `leave-${now}-${Math.random().toString(36).slice(2, 8)}`,
      guildId,
      channelId,
      userId,
      displayName,
      text: "(left the voice channel)",
      isFinal: true,
      confidence: 1,
      startedAt: now,
      endedAt: now,
    });

    this.enqueueTurn({ guildId, channelId, triggerType: "member_left", triggeringUserId: userId, contextHint });
  }

  /**
   * General, not-per-person "hey everyone" greeting — fired once per fresh
   * voice connection. Intended call site: `discord/bootstrap.ts`'s
   * `startVoicePipeline`, right after the connection/playback are attached,
   * so it covers BOTH an explicit `/join` command and auto-join-on-entry
   * with one call site rather than duplicating the hook in
   * `commands/join.ts`. Reuses the same turn-queue/rate-limiter/logging
   * path as everything else (recommended over a bare direct-TTS call) —
   * consistency, and it means a rapid rejoin can't spam greetings past the
   * shared per-minute cap either.
   *
   * No synthetic transcript segment is appended here (unlike the join/leave
   * methods above) — there is no specific person to attribute memory to,
   * only the sentinel `triggeringUserId`.
   */
  async announceSessionStart(guildId: string, channelId: string): Promise<void> {
    const contextHint =
      "You just connected to this voice channel via /join — give a brief, general hello to whoever's listening. Don't address any one specific person or claim to remember anyone yet.";

    this.enqueueTurn({
      guildId,
      channelId,
      triggerType: "session_start",
      triggeringUserId: SESSION_START_TRIGGER_USER_ID,
      contextHint,
    });
  }

  /**
   * Runs the given candidate's turn immediately if none is in flight for its
   * guild, else stashes it as the (sole) pending turn for that guild,
   * dropping/replacing whatever was pending before.
   */
  private enqueueTurn(item: TurnWorkItem): void {
    const guildId = item.guildId;
    let queue = this.turnQueueByGuild.get(guildId);
    if (!queue) {
      queue = { running: false, pending: null };
      this.turnQueueByGuild.set(guildId, queue);
    }

    if (queue.running) {
      // An already-queued explicit mention outranks an incoming non-explicit
      // candidate (ambient OR proactive) — don't let it get silently
      // clobbered before drain gets to it (bugs/nazgul round: explicit
      // name/pronoun mentions were being dropped by the very next unrelated
      // segment, well before turnTaking.decide() ever saw them).
      // Non-explicit-vs-non-explicit and mention-vs-mention (or mention
      // superseding a pending non-explicit candidate) keep the existing
      // newest-wins behavior — only pending-mention vs. incoming-non-explicit
      // is special-cased.
      if (queue.pending && isExplicitTrigger(queue.pending.triggerType) && !isExplicitTrigger(item.triggerType)) {
        log.debug("rejecting incoming non-explicit candidate — explicit mention already queued", { guildId });
        return;
      }
      if (queue.pending) {
        log.debug("dropping stale queued turn — superseded by newer candidate", { guildId });
      }
      queue.pending = item;
      return;
    }

    queue.running = true;
    void this.drainTurnQueue(guildId, queue, item);
  }

  /**
   * Runs turns for a guild one at a time until its pending slot is empty.
   * Errors from an individual turn are logged and do not stop the drain
   * (mirrors the `.catch()` logging bootstrap.ts used to do around the old
   * fire-and-forget `handleSegment` call).
   */
  private async drainTurnQueue(guildId: string, queue: GuildTurnQueue, firstItem: TurnWorkItem): Promise<void> {
    let item = firstItem;
    for (;;) {
      try {
        await this.runTurn(item);
      } catch (err) {
        log.error("turn processing failed", {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!queue.pending) break;
      item = queue.pending;
      queue.pending = null;
    }
    queue.running = false;
  }

  private async runTurn(item: TurnWorkItem): Promise<void> {
    // Active-thread continuation (task 1): only ambient_pause candidates
    // ever consult this — explicit triggers already bypass the cheap gate
    // outright, and proactive/system-event candidates have no real
    // per-person `triggeringUserId` to match against.
    const activeThreadContinuation =
      item.triggerType === "ambient_pause" ? this.getActiveThreadContinuation(item.guildId, item.triggeringUserId) : undefined;

    const candidate: TurnCandidate = {
      guildId: item.guildId,
      channelId: item.channelId,
      triggerType: item.triggerType,
      triggeringUserId: item.triggeringUserId,
      segments: this.historyFor(item.guildId),
      detectedAt: Date.now(),
      contextHint: item.contextHint,
      activeThreadContinuation,
    };

    const decision = await this.turnTaking.decide(candidate, this.deps.persona);
    log.info("turn decision", {
      guildId: item.guildId,
      triggerType: item.triggerType,
      shouldRespond: decision.shouldRespond,
      reason: decision.reason,
      category: decision.category,
    });

    if (!decision.shouldRespond) return;

    this.deps.rateLimiter.recordResponse(item.guildId, { bypassCooldown: decision.bypassCooldown });

    const request = await this.contextAssembler.assemble(
      candidate,
      this.deps.persona,
      decision.reason,
      this.historyFor(item.guildId),
      this.recentTonesFor(item.guildId),
    );
    const response = await this.deps.llm.generateResponse(request);
    await this.deps.memory.logUsage({
      guildId: item.guildId,
      service: "llm",
      unitType: "tokens",
      units: response.usage.inputTokens + response.usage.outputTokens,
      occurredAt: Date.now(),
    });

    // Empty text is a genuine "nothing to say" outcome (persona/parseLLMReply
    // fallback both allow it deliberately, see llm/types.ts) — skip TTS/
    // playback rather than synthesizing/playing a blank clip. Memory
    // extraction only makes sense when a real speaker triggered this turn
    // (proactive turns have no `triggeringUserId` to attribute facts to).
    if (response.text.trim().length === 0) {
      log.debug("empty LLM response — skipping TTS/playback", { guildId: item.guildId });
      if (item.segment) await this.extractAndPersistMemory(item.segment, candidate, response.text);
      return;
    }

    // Thread the bot's own reply back into transcript history so later turns
    // (ambient/proactive cheap-gate + generation) can see what it already
    // said, avoid repeating itself, and notice when the conversation has
    // moved on.
    this.appendBotReply(item.guildId, item.channelId, response.text);
    // Tone-variety mechanism — only record a real spoken reply's tone (empty
    // responses returned above and never reach here); untagged replies
    // (`tone` omitted by the model) leave history unchanged rather than
    // pushing an empty placeholder.
    this.recordTone(item.guildId, response.tone);

    // Active-thread continuation (task 1): a real, non-empty reply just
    // went out — if it was clearly directed at/prompted by a specific real
    // user, open (or refresh) that person's continuation window so their
    // NEXT ambient segment gets treated at least as reliably as an explicit
    // trigger. See `ACTIVE_THREAD_ELIGIBLE_TRIGGERS`'s doc comment for the
    // exact trigger-type allowlist and why member_left/proactive/
    // session_start are excluded. Display name prefers `item.segment`
    // (every explicit/ambient trigger always carries one) and falls back to
    // `item.triggeringDisplayName` for triggers with no segment at all
    // (currently only member_joined — see `TurnWorkItem.triggeringDisplayName`'s
    // doc comment).
    if (PipelineOrchestrator.ACTIVE_THREAD_ELIGIBLE_TRIGGERS.has(item.triggerType)) {
      const displayName = item.segment?.displayName ?? item.triggeringDisplayName;
      if (displayName) {
        this.setActiveThread(item.guildId, item.triggeringUserId, displayName);
      }
    }

    const priority: PlaybackPriority = isExplicitTrigger(item.triggerType) ? "explicit" : "ambient";

    await this.deps.memory.logUsage({
      guildId: item.guildId,
      service: "tts",
      unitType: "characters",
      units: response.text.length,
      occurredAt: Date.now(),
    });

    // Speech-end -> bot-starts-speaking latency is only meaningful when a
    // real utterance triggered this turn — a proactive turn has no
    // "speech-end" to measure against.
    if (item.segment) {
      const latencyMs = Date.now() - item.segment.endedAt;
      if (latencyMs > LATENCY_WARN_THRESHOLD_MS) {
        log.warn("speech-end -> bot-starts-speaking latency exceeded threshold", {
          guildId: item.guildId,
          latencyMs,
          thresholdMs: LATENCY_WARN_THRESHOLD_MS,
        });
      }
    }

    try {
      const ttsStream = this.deps.tts.synthesizeStream({
        text: response.text,
        tone: response.tone,
        voiceId: this.deps.voiceId,
      });
      // Bounded — a hang here must not permanently wedge the guild's
      // serialized turn queue (drainTurnQueue awaits turns one at a time).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("playback timed out")), PLAYBACK_AWAIT_TIMEOUT_MS);
      });
      try {
        await Promise.race([this.deps.playback.play(item.guildId, ttsStream, { priority }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.error("TTS/playback failed — continuing without spoken reply", {
        guildId: item.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Adaptive-cadence learning layer (social-presence round): open an
    // engagement window only for the two trigger types that represent a
    // genuine "was this a good moment to speak" judgment call — explicit
    // triggers (direct request, always "correct" to answer) and the
    // system-driven member_joined/member_left/session_start events (rare,
    // bounded, not a timing judgment) are deliberately excluded. Overwrites
    // (silently discards, unresolved) any still-open window from an earlier
    // ambient/proactive turn — see `pendingEngagementByGuild`'s doc comment.
    if (item.triggerType === "ambient_pause" || item.triggerType === "proactive") {
      const botSpeechEndedAt = Date.now();
      // `decision.category` should always be set for these two trigger
      // types (turnTaking.ts's `decide` sets it on every ambient_pause/
      // proactive branch that returns shouldRespond: true) — the fallback
      // here is defense-in-depth only, not the expected path.
      const category: TurnOutcomeCategory = decision.category ?? (item.triggerType === "proactive" ? "proactive" : "ambient");
      this.pendingEngagementByGuild.set(item.guildId, {
        botSpeechEndedAt,
        deadline: botSpeechEndedAt + ENGAGEMENT_FOLLOWUP_WINDOW_MS,
        category,
      });
    }

    if (item.segment) {
      await this.extractAndPersistMemory(item.segment, candidate, response.text);
    }
  }

  private async extractAndPersistMemory(segment: TranscriptSegment, candidate: TurnCandidate, botReplyText: string): Promise<void> {
    const existingProfile = await this.deps.memory.getProfile(segment.guildId, segment.userId);
    const extraction = await this.deps.llm.extractMemoryFacts({
      guildId: segment.guildId,
      userId: segment.userId,
      displayName: segment.displayName,
      exchange: candidate.segments,
      botReplyText,
      existingFacts: existingProfile?.facts ?? [],
    });
    await this.deps.memory.logUsage({
      guildId: segment.guildId,
      service: "llm",
      unitType: "tokens",
      units: extraction.usage.inputTokens + extraction.usage.outputTokens,
      occurredAt: Date.now(),
    });

    if (extraction.newFacts.length === 0 && !extraction.sentimentNotes) return;

    if (extraction.newFacts.length > 0) {
      await this.deps.memory.appendFacts(segment.guildId, segment.userId, extraction.newFacts);
    }
    if (extraction.sentimentNotes) {
      const profile = await this.deps.memory.getProfile(segment.guildId, segment.userId);
      if (profile) {
        await this.deps.memory.upsertProfile({ ...profile, sentimentNotes: extraction.sentimentNotes, updatedAt: Date.now() });
      }
    }
  }

  /**
   * Adaptive-cadence learning layer (social-presence round): resolves this
   * guild's open engagement window (if any) against an incoming human
   * segment. Only a genuinely final, non-empty segment counts (mirrors
   * `formatTranscript`'s own filter) — every caller of `handleSegment`
   * already only reaches here with consented, non-opted-out segments, so no
   * separate privacy check is needed.
   *
   * "Landed" vs "flopped" (see memory/types.ts's `TurnOutcomeSchema` doc
   * comment for the canonical definition): a segment that STARTED before
   * the bot's reply finished playing (`segment.startedAt < botSpeechEndedAt`)
   * means the bot was talked over — flopped, not landed, even though a
   * human did speak. Otherwise, speaking again within the window counts as
   * landed.
   */
  private resolveEngagementOnHumanSegment(segment: TranscriptSegment): void {
    if (!segment.isFinal || segment.text.trim().length === 0) return;
    const pending = this.pendingEngagementByGuild.get(segment.guildId);
    if (!pending) return;

    this.pendingEngagementByGuild.delete(segment.guildId);
    const outcome: TurnOutcome = segment.startedAt < pending.botSpeechEndedAt ? "flopped" : "landed";
    void this.deps.memory.recordTurnOutcome(segment.guildId, outcome, Date.now(), pending.category).catch((err) => {
      log.error("failed to record turn-outcome engagement signal", {
        guildId: segment.guildId,
        outcome,
        category: pending.category,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Adaptive-cadence learning layer: expires a guild's open engagement
   * window to "flopped" once its deadline has passed with nothing heard.
   * No dedicated timer exists for this — it's checked opportunistically
   * from `handleSegment` (every incoming human segment) and
   * `maybeFireProactiveTurn` (ticks periodically while the bot is
   * connected, per bootstrap.ts's timer, independent of ambient activity),
   * which together catch an expired window in reasonable time without new
   * background scheduling. A soft learning signal resolving a little late
   * during a fully silent stretch is an acceptable tradeoff, not a
   * correctness bug.
   */
  private expireStaleEngagementIfNeeded(guildId: string): void {
    const pending = this.pendingEngagementByGuild.get(guildId);
    if (!pending) return;
    if (Date.now() <= pending.deadline) return;

    this.pendingEngagementByGuild.delete(guildId);
    void this.deps.memory.recordTurnOutcome(guildId, "flopped", Date.now(), pending.category).catch((err) => {
      log.error("failed to record expired turn-outcome (flopped)", {
        guildId,
        category: pending.category,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Trigger types whose bot reply counts as "clearly directed at/prompted
   * by a specific real person" for the active-thread continuation tracker
   * (task 1). Explicit address triggers are the core case (the "Nick"
   * scenario); ambient_pause is included too since the cheap-gate saying
   * yes to react to that exact segment is itself evidence the reply was a
   * response to that speaker's specific comment.
   *
   * `member_joined` added (Merry, conversation-continuity wiring pass) — a
   * personal greeting-by-name is exactly as "directed at" someone as an
   * explicit trigger; the only reason it was excluded originally was that
   * `TurnWorkItem` had no display name to plumb through for a trigger type
   * with no `segment`. Fixed via `TurnWorkItem.triggeringDisplayName` (set
   * by `handleMemberJoinedVoice`) — `runTurn`'s call to `setActiveThread`
   * now falls back to it when `item.segment` is absent. Net effect: if a new
   * joiner replies to the bot's greeting without saying its name, that reply
   * (an ordinary `ambient_pause` segment from them) now reliably matches an
   * open continuation window instead of rolling the ambient cheap-gate dice.
   *
   * Still deliberately EXCLUDED:
   * - `member_left` — the greeted/farewelled person has already left the
   *   voice channel by the time the bot's remark plays, so there is no
   *   "their next reply" to continue in the first place (Frodo's judgment
   *   call, confirmed here: a farewell has no reply to continue).
   * - `session_start` — sentinel `triggeringUserId`
   *   (`SESSION_START_TRIGGER_USER_ID`), not a specific real person; there
   *   is no individual to open a continuation window with.
   * - `proactive` — sentinel `triggeringUserId`
   *   (`PROACTIVE_TRIGGER_USER_ID`), same reason as `session_start`.
   */
  private static readonly ACTIVE_THREAD_ELIGIBLE_TRIGGERS: ReadonlySet<TriggerType> = new Set<TriggerType>([
    "explicit_mention",
    "explicit_reply",
    "explicit_name",
    "ambient_pause",
    "member_joined",
  ]);

  private setActiveThread(guildId: string, userId: string, displayName: string): void {
    let byUser = this.activeThreadByGuild.get(guildId);
    if (!byUser) {
      byUser = new Map();
      this.activeThreadByGuild.set(guildId, byUser);
    }
    byUser.set(userId, { displayName, expiresAt: Date.now() + ACTIVE_THREAD_TTL_MS });
  }

  /**
   * Returns the continuation payload for `TurnCandidate.activeThreadContinuation`
   * if `userId` has a still-open active-thread window in this guild, else
   * `undefined`. Lazily expires (and removes) a stale entry on read rather
   * than running a separate sweep timer — mirrors `expireStaleEngagementIfNeeded`'s
   * "checked opportunistically, not worth a dedicated background timer"
   * philosophy for this kind of short-TTL, best-effort state.
   *
   * `contextHint` tuned (Merry, conversation-continuity wiring pass) to match
   * the established style of the other system-event hints in this file
   * (`announceSessionStart`, `handleMemberJoinedVoice`) — name what just
   * happened, then give concrete do/don't instructions, rather than a single
   * generic "keep engaging" line. Concretely: told to treat this as a direct
   * reply (not a fresh ambient comment), stay on the SAME thread rather than
   * pivoting to something generic, and never ask the person to repeat
   * themselves or clarify who they're addressing — the model has no other
   * signal that this is a continuation besides this hint, so it needs to be
   * unambiguous, not just descriptive.
   */
  private getActiveThreadContinuation(guildId: string, userId: string): TurnCandidate["activeThreadContinuation"] {
    const byUser = this.activeThreadByGuild.get(guildId);
    const entry = byUser?.get(userId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      byUser!.delete(userId);
      return undefined;
    }
    return {
      withUserId: userId,
      contextHint: `${entry.displayName} just said this without using your name — but it directly continues a conversation you (the bot) started with them moments ago, so treat it exactly like a direct reply to you, not a fresh ambient comment. Engage specifically with what they just said, stay on the same thread/topic rather than pivoting to something generic, and never ask them to repeat themselves or clarify who they're talking to.`,
    };
  }

  /**
   * Record the bot's own spoken reply into the guild transcript history as a
   * synthetic segment attributed to the persona name. `formatTranscript`
   * renders it as `<persona name>: <reply>` in the window the cheap-gate and
   * generator see next turn, giving the bot awareness of what it already said.
   * Uses the BOT_SPEAKER_ID sentinel so context assembly skips a profile
   * lookup for it (see contextAssembler).
   */
  private appendBotReply(guildId: string, channelId: string, text: string): void {
    const now = Date.now();
    this.appendHistory({
      id: `bot-${now}-${Math.random().toString(36).slice(2, 8)}`,
      guildId,
      channelId,
      userId: BOT_SPEAKER_ID,
      displayName: this.deps.persona.name,
      text,
      isFinal: true,
      confidence: 1,
      startedAt: now,
      endedAt: now,
    });
  }

  private appendHistory(segment: TranscriptSegment): void {
    const history = this.historyByGuild.get(segment.guildId) ?? [];
    history.push(segment);
    // Cap in-memory window generously beyond CONTEXT_WINDOW_UTTERANCES so
    // the ambient cheap-gate and full generation see slightly different
    // slice sizes if ever needed, without re-querying Postgres on every turn.
    const cap = CONTEXT_WINDOW_UTTERANCES * 4;
    if (history.length > cap) history.splice(0, history.length - cap);
    this.historyByGuild.set(segment.guildId, history);
  }

  private historyFor(guildId: string): TranscriptSegment[] {
    return this.historyByGuild.get(guildId) ?? [];
  }

  /**
   * Append a tone tag to this guild's rolling tone history (tone-variety
   * mechanism). No-op if `tone` is undefined — an untagged reply shouldn't
   * push a blank entry that would otherwise read as "just used no style."
   */
  private recordTone(guildId: string, tone: string | undefined): void {
    if (!tone) return;
    const history = this.toneHistoryByGuild.get(guildId) ?? [];
    history.push(tone);
    if (history.length > MAX_RECENT_TONES_PER_GUILD) history.splice(0, history.length - MAX_RECENT_TONES_PER_GUILD);
    this.toneHistoryByGuild.set(guildId, history);
  }

  private recentTonesFor(guildId: string): string[] {
    return this.toneHistoryByGuild.get(guildId) ?? [];
  }
}
