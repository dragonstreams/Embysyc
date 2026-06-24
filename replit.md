# Emby Discord Bot

A Discord bot that transfers a user's favorites and watch history from one remote Emby server to another via slash command.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DISCORD_TOKEN` — Discord bot token (from discord.com/developers → Bot page)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Discord: discord.js v14
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — Discord client setup, slash command registration
- `artifacts/api-server/src/bot/transfer.ts` — `/emby-transfer` command handler and result embed
- `artifacts/api-server/src/bot/emby.ts` — Emby API client (auth, fetch items, mark favorites/played)

## How the bot works

1. User runs `/emby-transfer` with source/dest server URLs, usernames, and passwords
2. Bot authenticates on both Emby servers simultaneously
3. Fetches favorites and/or played items from the source (paginated, all media types)
4. For each item, finds a match on the destination server by name+type (episodes matched by series+season+episode number)
5. Marks matched items as favorite/played on the destination
6. Reports a summary embed showing transferred counts and any items not found

## Slash Commands

- `/emby-transfer` — Transfer Emby data between two servers
  - `what` (required, first) — `both` (default), `favorites`, or `watched`
  - `source_url` (required) — Source Emby server URL
  - `source_username` (required) — Local username, or Emby Connect email if `source_login` is `connect`
  - `source_password` (required) — Password on source server
  - `dest_url` (required) — Destination Emby server URL
  - `dest_username` (required) — Local username, or Emby Connect email if `dest_login` is `connect`
  - `dest_password` (required) — Password on destination server
  - `source_login` (optional) — `local` (default) or `connect` (Emby Connect email login)
  - `dest_login` (optional) — `local` (default) or `connect` (Emby Connect email login)

## Architecture decisions

- Bot runs inside the same process as the Express server — no separate worker needed.
- Emby item matching uses name+type for movies/series; series name+season+episode number for episodes.
- All credentials are passed per-command, never stored — no database needed.
- Replies are ephemeral (only visible to the user who ran the command) to keep credentials private.
- Auth supports two methods per server (set via `source_login`/`dest_login`): local `AuthenticateByName`, or Emby Connect (authenticate at connect.emby.media → list linked servers → exchange for a local token on the target server).
- Transfers run with a concurrency of 8 (worker pool) to stay well within Discord's 15-minute interaction window on large libraries.

## Gotchas

- Global slash commands can take up to 1 hour to propagate to all Discord servers after first registration.
- Items not found on the destination simply means that media doesn't exist on that server yet.
- The bot token must be stored in Replit Secrets as `DISCORD_TOKEN`.
- Emby Connect login requires Connect to be enabled on the target server and the server to be linked to that Connect account; the server URL is matched by host (falls back to the only linked server if there's just one).

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
