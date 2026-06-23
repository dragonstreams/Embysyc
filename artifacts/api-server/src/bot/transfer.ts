import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import {
  authenticate,
  getAllItems,
  findMatchingItem,
  markFavorite,
  markPlayed,
  type EmbyItem,
} from "./emby.js";

type TransferMode = "both" | "favorites" | "watched";

interface TransferResult {
  favoritesTotal: number;
  favoritesTransferred: number;
  favoritesNotFound: string[];
  watchedTotal: number;
  watchedTransferred: number;
  watchedNotFound: string[];
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

  const result: TransferResult = {
    favoritesTotal: 0,
    favoritesTransferred: 0,
    favoritesNotFound: [],
    watchedTotal: 0,
    watchedTransferred: 0,
    watchedNotFound: [],
  };

  try {
    await interaction.editReply("🔐 Authenticating with both servers...");

    const [srcAuth, dstAuth] = await Promise.all([
      authenticate(srcUrl, srcUser, srcPass).catch((e: Error) => {
        throw new Error(`Source server auth failed: ${e.message}`);
      }),
      authenticate(dstUrl, dstUser, dstPass).catch((e: Error) => {
        throw new Error(`Destination server auth failed: ${e.message}`);
      }),
    ]);

    const MEDIA_TYPES = ["Movie", "Series", "Episode", "MusicAlbum", "MusicArtist"];

    if (mode === "favorites" || mode === "both") {
      await interaction.editReply("⭐ Fetching favorites from source server...");

      const favorites = await getAllItems(srcAuth, {
        isFavorite: true,
        types: MEDIA_TYPES,
      });

      result.favoritesTotal = favorites.length;

      if (favorites.length > 0) {
        await interaction.editReply(
          `⭐ Transferring ${favorites.length} favorites...`
        );

        for (const item of favorites) {
          const match = await findMatchingItem(dstAuth, item);
          if (match) {
            const ok = await markFavorite(dstAuth, match.Id);
            if (ok) result.favoritesTransferred++;
            else result.favoritesNotFound.push(itemLabel(item));
          } else {
            result.favoritesNotFound.push(itemLabel(item));
          }
        }
      }
    }

    if (mode === "watched" || mode === "both") {
      await interaction.editReply("📺 Fetching watch history from source server...");

      const watched = await getAllItems(srcAuth, {
        isPlayed: true,
        types: MEDIA_TYPES,
      });

      result.watchedTotal = watched.length;

      if (watched.length > 0) {
        await interaction.editReply(
          `📺 Transferring ${watched.length} watched items...`
        );

        for (const item of watched) {
          const match = await findMatchingItem(dstAuth, item);
          if (match) {
            const ok = await markPlayed(dstAuth, match.Id);
            if (ok) result.watchedTransferred++;
            else result.watchedNotFound.push(itemLabel(item));
          } else {
            result.watchedNotFound.push(itemLabel(item));
          }
        }
      }
    }

    const embed = buildResultEmbed(result, mode, srcUrl, dstUrl);
    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("❌ Transfer Failed")
      .setDescription(message)
      .setTimestamp();
    await interaction.editReply({ content: "", embeds: [errEmbed] });
  }
}

function itemLabel(item: EmbyItem): string {
  if (item.Type === "Episode" && item.SeriesName) {
    return `${item.SeriesName} S${pad(item.ParentIndexNumber)}E${pad(item.IndexNumber)} - ${item.Name}`;
  }
  return `${item.Name} (${item.Type})`;
}

function pad(n: number | undefined): string {
  if (n == null) return "?";
  return n < 10 ? `0${n}` : String(n);
}

function buildResultEmbed(
  result: TransferResult,
  mode: TransferMode,
  srcUrl: string,
  dstUrl: string
): EmbedBuilder {
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

  if (mode === "favorites" || mode === "both") {
    embed.addFields({
      name: "⭐ Favorites",
      value: `Transferred: **${result.favoritesTransferred}/${result.favoritesTotal}**`,
      inline: false,
    });

    if (result.favoritesNotFound.length > 0) {
      const list = result.favoritesNotFound.slice(0, 10).join("\n");
      const extra =
        result.favoritesNotFound.length > 10
          ? `\n…and ${result.favoritesNotFound.length - 10} more`
          : "";
      embed.addFields({
        name: "Not found on destination (favorites)",
        value: "```\n" + list + extra + "\n```",
      });
    }
  }

  if (mode === "watched" || mode === "both") {
    embed.addFields({
      name: "📺 Watched",
      value: `Transferred: **${result.watchedTransferred}/${result.watchedTotal}**`,
      inline: false,
    });

    if (result.watchedNotFound.length > 0) {
      const list = result.watchedNotFound.slice(0, 10).join("\n");
      const extra =
        result.watchedNotFound.length > 10
          ? `\n…and ${result.watchedNotFound.length - 10} more`
          : "";
      embed.addFields({
        name: "Not found on destination (watched)",
        value: "```\n" + list + extra + "\n```",
      });
    }
  }

  if (!allGood) {
    embed.setFooter({
      text: "Items not found means they don't exist on the destination server or the name didn't match.",
    });
  }

  return embed;
}
