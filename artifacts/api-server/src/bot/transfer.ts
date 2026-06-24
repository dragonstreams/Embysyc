import type { ChatInputCommandInteraction, Message } from "discord.js";
import { EmbedBuilder } from "discord.js";
import {
  authenticate,
  getAllItems,
  findMatchingItem,
  markFavorite,
  markPlayed,
  type EmbyItem,
} from "./emby.js";
import { logger } from "../lib/logger.js";

const TRANSFER_CONCURRENCY = 8;

/** Runs `worker` over every item, at most `concurrency` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  onProgress: () => void
): Promise<void> {
  let index = 0;
  async function runNext(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      await worker(items[current]!);
      onProgress();
    }
  }
  const runnerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runNext()));
}

type TransferMode = "both" | "favorites" | "watched";
type PhaseStatus = "pending" | "running" | "done" | "skipped";

interface Phase {
  label: string;
  status: PhaseStatus;
  detail?: string;
}

interface TransferResult {
  favoritesTotal: number;
  favoritesTransferred: number;
  favoritesSkipped: number;
  favoritesNotFound: string[];
  watchedTotal: number;
  watchedTransferred: number;
  watchedSkipped: number;
  watchedNotFound: string[];
}

const PHASE_ICON: Record<PhaseStatus, string> = {
  pending: "⬜",
  running: "🔄",
  done: "✅",
  skipped: "➖",
};

function progressBar(done: number, total: number, width = 16): string {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function pct(done: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((done / total) * 100)}%`;
}

/** Sends at most one Discord edit per THROTTLE_MS to avoid rate limits. */
class LiveEmbed {
  private phases: Phase[];
  private lastEdit = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private message: Message | null = null;
  private closed = false;

  private static readonly THROTTLE_MS = 2500;

  constructor(phases: Phase[]) {
    this.phases = phases;
  }

  /** Stops any further progress edits so the final result embed isn't overwritten. */
  close(): void {
    this.closed = true;
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
  }

  setPhase(label: string, status: PhaseStatus, detail?: string): void {
    const p = this.phases.find((ph) => ph.label === label);
    if (p) {
      p.status = status;
      p.detail = detail;
    }
  }

  private buildEmbed(): EmbedBuilder {
    const lines = this.phases.map((p) => {
      const icon = PHASE_ICON[p.status];
      const detail = p.detail ? `  ${p.detail}` : "";
      return `${icon} **${p.label}**${detail}`;
    });

    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🔃 Emby Transfer In Progress")
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Replies are private — only you can see this" });
  }

  async init(interaction: ChatInputCommandInteraction): Promise<void> {
    const sent = await interaction.editReply({ embeds: [this.buildEmbed()] });
    this.message = sent as Message;
    this.lastEdit = Date.now();
  }

  async flush(force = false): Promise<void> {
    if (!this.message || this.closed) return;

    const now = Date.now();
    const elapsed = now - this.lastEdit;

    if (!force && elapsed < LiveEmbed.THROTTLE_MS) {
      if (!this.pendingFlush) {
        this.pendingFlush = setTimeout(
          () => {
            this.pendingFlush = null;
            void this.flush(true);
          },
          LiveEmbed.THROTTLE_MS - elapsed
        );
      }
      return;
    }

    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }

    try {
      await this.message.edit({ embeds: [this.buildEmbed()] });
    } catch {
      // Ignore rate-limit errors — next throttled flush will retry
    }
    this.lastEdit = Date.now();
  }
}

export async function runTransfer(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const srcUrl = interaction.options.getString("source_url", true).trim();
  const srcUser = interaction.options.getString("source_username", true);
  const srcPass = interaction.options.getString("source_password", true);
  const dstUrl = interaction.options.getString("dest_url", true).trim();
  const dstUser = interaction.options.getString("dest_username", true);
  const dstPass = interaction.options.getString("dest_password", true);
  const mode = (interaction.options.getString("what") ?? "both") as TransferMode;

  await interaction.deferReply({ ephemeral: true });

  const doFavorites = mode === "favorites" || mode === "both";
  const doWatched = mode === "watched" || mode === "both";

  const phases: Phase[] = [
    { label: "Authenticating", status: "running" },
    { label: "Fetching items", status: "pending" },
    ...(doFavorites ? [{ label: "Transferring favorites", status: "pending" as PhaseStatus }] : []),
    ...(doWatched ? [{ label: "Transferring watched", status: "pending" as PhaseStatus }] : []),
  ];

  const live = new LiveEmbed(phases);
  await live.init(interaction);

  const result: TransferResult = {
    favoritesTotal: 0,
    favoritesTransferred: 0,
    favoritesSkipped: 0,
    favoritesNotFound: [],
    watchedTotal: 0,
    watchedTransferred: 0,
    watchedSkipped: 0,
    watchedNotFound: [],
  };

  try {
    // ── Phase 1: Auth ────────────────────────────────────────────────────────
    const [srcAuth, dstAuth] = await Promise.all([
      authenticate(srcUrl, srcUser, srcPass).catch((e: Error) => {
        throw new Error(`Source server auth failed: ${e.message}`);
      }),
      authenticate(dstUrl, dstUser, dstPass).catch((e: Error) => {
        throw new Error(`Destination server auth failed: ${e.message}`);
      }),
    ]);

    live.setPhase("Authenticating", "done", "Both servers connected");
    live.setPhase("Fetching items", "running");
    await live.flush(true);

    // ── Phase 2: Fetch ───────────────────────────────────────────────────────
    const MEDIA_TYPES = ["Movie", "Series", "Episode", "MusicAlbum", "MusicArtist"];

    const [favorites, watched] = await Promise.all([
      doFavorites
        ? getAllItems(srcAuth, { isFavorite: true, types: MEDIA_TYPES })
        : Promise.resolve([]),
      doWatched
        ? getAllItems(srcAuth, { isPlayed: true, types: MEDIA_TYPES })
        : Promise.resolve([]),
    ]);

    result.favoritesTotal = favorites.length;
    result.watchedTotal = watched.length;

    const fetchSummary = [
      doFavorites ? `${favorites.length} favorites` : null,
      doWatched ? `${watched.length} watched` : null,
    ]
      .filter(Boolean)
      .join(", ");

    live.setPhase("Fetching items", "done", fetchSummary);
    await live.flush(true);

    // ── Phase 3: Transfer favorites ──────────────────────────────────────────
    if (doFavorites) {
      live.setPhase(
        "Transferring favorites",
        "running",
        favorites.length === 0 ? "Nothing to transfer" : `0/${favorites.length}`
      );
      await live.flush(true);

      let favDone = 0;
      await mapWithConcurrency(
        favorites,
        TRANSFER_CONCURRENCY,
        async (item) => {
          const match = await findMatchingItem(dstAuth, item);
          if (match && (await markFavorite(dstAuth, match.Id))) {
            result.favoritesTransferred++;
          } else {
            result.favoritesSkipped++;
            result.favoritesNotFound.push(itemLabel(item));
          }
        },
        () => {
          favDone++;
          live.setPhase(
            "Transferring favorites",
            "running",
            `${progressBar(favDone, favorites.length)} ${pct(favDone, favorites.length)} — ${result.favoritesTransferred} transferred, ${result.favoritesSkipped} skipped`
          );
          void live.flush();
        }
      );

      live.setPhase(
        "Transferring favorites",
        "done",
        `${result.favoritesTransferred}/${result.favoritesTotal} transferred${result.favoritesSkipped > 0 ? `, ${result.favoritesSkipped} skipped` : ""}`
      );
      await live.flush(true);
    }

    // ── Phase 4: Transfer watched ────────────────────────────────────────────
    if (doWatched) {
      live.setPhase(
        "Transferring watched",
        "running",
        watched.length === 0 ? "Nothing to transfer" : `0/${watched.length}`
      );
      await live.flush(true);

      let watchedDone = 0;
      await mapWithConcurrency(
        watched,
        TRANSFER_CONCURRENCY,
        async (item) => {
          const match = await findMatchingItem(dstAuth, item);
          if (match && (await markPlayed(dstAuth, match.Id))) {
            result.watchedTransferred++;
          } else {
            result.watchedSkipped++;
            result.watchedNotFound.push(itemLabel(item));
          }
        },
        () => {
          watchedDone++;
          live.setPhase(
            "Transferring watched",
            "running",
            `${progressBar(watchedDone, watched.length)} ${pct(watchedDone, watched.length)} — ${result.watchedTransferred} transferred, ${result.watchedSkipped} skipped`
          );
          void live.flush();
        }
      );

      live.setPhase(
        "Transferring watched",
        "done",
        `${result.watchedTransferred}/${result.watchedTotal} transferred${result.watchedSkipped > 0 ? `, ${result.watchedSkipped} skipped` : ""}`
      );
      await live.flush(true);
    }

    // ── Final result embed ───────────────────────────────────────────────────
    live.close();
    const resultEmbed = buildResultEmbed(result, mode, srcUrl, dstUrl);
    await deliverFinal(interaction, resultEmbed);
  } catch (err) {
    live.close();
    logger.error({ err }, "Transfer command failed");
    const message = err instanceof Error ? err.message : String(err);
    const errEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("❌ Transfer Failed")
      .setDescription(message.slice(0, 4000))
      .setTimestamp();
    await deliverFinal(interaction, errEmbed);
  }
}

/**
 * Delivers the final embed, falling back to a follow-up message if editing the
 * original deferred reply fails (e.g. it was overwritten or briefly rate-limited).
 */
async function deliverFinal(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder
): Promise<void> {
  try {
    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (err) {
    logger.error({ err }, "editReply failed for final result — trying followUp");
    try {
      await interaction.followUp({ embeds: [embed], ephemeral: true });
    } catch (err2) {
      logger.error({ err: err2 }, "followUp also failed — cannot deliver final result");
    }
  }
}

function itemLabel(item: EmbyItem): string {
  if (item.Type === "Episode" && item.SeriesName) {
    return `${item.SeriesName} S${pad(item.ParentIndexNumber)}E${pad(item.IndexNumber)} — ${item.Name}`;
  }
  return `${item.Name} (${item.Type})`;
}

function pad(n: number | undefined): string {
  if (n == null) return "?";
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Builds a fenced code block of items that stays within Discord's 1024-char
 * embed field limit, truncating with a "…and N more" line when needed.
 */
function cappedCodeBlock(items: string[], max = 980): string {
  const shown: string[] = [];
  let len = 0;
  for (const item of items) {
    const remainingCount = items.length - shown.length;
    const reserve = remainingCount > 1 ? 24 : 0; // room for "…and N more"
    if (len + item.length + 1 + reserve > max) break;
    shown.push(item);
    len += item.length + 1;
  }
  const remaining = items.length - shown.length;
  const extra = remaining > 0 ? `\n…and ${remaining} more` : "";
  return "```\n" + shown.join("\n") + extra + "\n```";
}

function buildResultEmbed(
  result: TransferResult,
  mode: TransferMode,
  srcUrl: string,
  dstUrl: string
): EmbedBuilder {
  const doFavorites = mode === "favorites" || mode === "both";
  const doWatched = mode === "watched" || mode === "both";
  const allGood =
    result.favoritesNotFound.length === 0 && result.watchedNotFound.length === 0;

  const embed = new EmbedBuilder()
    .setColor(allGood ? 0x2ecc71 : 0xf39c12)
    .setTitle(allGood ? "✅ Transfer Complete" : "⚠️ Transfer Complete (with skipped items)")
    .setTimestamp()
    .addFields(
      { name: "Source", value: srcUrl, inline: true },
      { name: "Destination", value: dstUrl, inline: true }
    );

  if (doFavorites) {
    const bar = progressBar(result.favoritesTransferred, result.favoritesTotal);
    embed.addFields({
      name: "⭐ Favorites",
      value:
        `\`${bar}\` ${pct(result.favoritesTransferred, result.favoritesTotal)}\n` +
        `**${result.favoritesTransferred}** transferred · **${result.favoritesSkipped}** skipped · **${result.favoritesTotal}** total`,
      inline: false,
    });

    if (result.favoritesNotFound.length > 0) {
      embed.addFields({
        name: "Skipped favorites (not on destination)",
        value: cappedCodeBlock(result.favoritesNotFound),
      });
    }
  }

  if (doWatched) {
    const bar = progressBar(result.watchedTransferred, result.watchedTotal);
    embed.addFields({
      name: "📺 Watched",
      value:
        `\`${bar}\` ${pct(result.watchedTransferred, result.watchedTotal)}\n` +
        `**${result.watchedTransferred}** transferred · **${result.watchedSkipped}** skipped · **${result.watchedTotal}** total`,
      inline: false,
    });

    if (result.watchedNotFound.length > 0) {
      embed.addFields({
        name: "Skipped watched items (not on destination)",
        value: cappedCodeBlock(result.watchedNotFound),
      });
    }
  }

  if (!allGood) {
    embed.setFooter({
      text: "Skipped items don't exist on the destination server or the title didn't match.",
    });
  }

  return embed;
}
