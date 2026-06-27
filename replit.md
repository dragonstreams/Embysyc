# Emby / Jellyfin Discord Bot

A Discord bot that transfers a user's favorites and watch history from one remote Emby or Jellyfin server to another via slash command. Emby and Jellyfin can be mixed freely (e.g. Emby → Jellyfin). It also sends Invoice Ninja invoice reminders to Discord users via DM one day before an invoice is due.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DISCORD_TOKEN` — Discord bot token (from discord.com/developers → Bot page)
- Optional env: `DISCORD_GUILD_ID` — when set, slash commands register to that one server instantly (otherwise they register globally, which can take up to 1 hour to appear)
- Required env for reminders: `INVOICE_NINJA_API_TOKEN` — Invoice Ninja API token (Settings → Account Management → API Tokens)
- Optional reminder env: `INVOICE_NINJA_URL` (default `https://invoicing.co`), `INVOICE_NINJA_DISCORD_FIELD` (which client custom field holds the Discord user ID — `custom_value1`–`custom_value4`, default `custom_value1`), `REMINDER_TZ` (IANA tz, default `UTC`), `REMINDER_HOUR` (0–23, default `9`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Discord: discord.js v14
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — Discord client setup, slash command registration
- `artifacts/api-server/src/bot/transfer.ts` — `/emby-transfer` command handler and result embed
- `artifacts/api-server/src/bot/emby.ts` — Emby/Jellyfin API client (auth, fetch items, mark favorites/played). Jellyfin shares Emby's API; the only difference is the auth header (see Architecture decisions).
- `artifacts/api-server/src/bot/invoiceninja.ts` — Invoice Ninja API client (config from env, paginated unpaid-invoice fetch with client embedded; client search/get and `setClientDiscordId` write to update the Discord-ID custom field)
- `artifacts/api-server/src/bot/reminders.ts` — reminder engine (`runReminderJob`), daily scheduler (`startReminderScheduler`), and `/reminder` command handler (`runReminderCommand`)
- `artifacts/api-server/src/bot/reminderStore.ts` — on-disk dedupe store at `.data/invoice-reminders.json` so restarts don't re-DM

## How the bot works

1. User runs `/emby-transfer` with source/dest server URLs, usernames, and passwords (and optionally server type Emby/Jellyfin)
2. Bot authenticates on both servers simultaneously
3. Fetches favorites and/or played items from the source (paginated, all media types)
4. For each item, finds a match on the destination server by name+type (episodes matched by series+season+episode number)
5. Marks matched items as favorite/played on the destination
6. Reports a summary embed showing transferred counts and any items not found

### Invoice reminders

1. A scheduler runs the reminder job on startup, then once a day at `REMINDER_HOUR` in `REMINDER_TZ`
2. The job fetches all unpaid invoices from Invoice Ninja (with each client embedded)
3. It keeps invoices that are sent/partial, have a balance > 0, and are due tomorrow (computed in `REMINDER_TZ`)
4. For each, it reads the Discord user ID from the client's configured custom field (`INVOICE_NINJA_DISCORD_FIELD`) and DMs a reminder embed (with the pay link if present)
5. Each (due date, invoice) pair is recorded in the on-disk dedupe store so it's never DM'd twice — even across restarts
6. An admin can run `/reminder` to run the same job on demand (dedupe still applies); it replies with an ephemeral summary (sent / already sent / no Discord ID / failed)

## Slash Commands

- `/emby-transfer` — Transfer Emby/Jellyfin data between two servers
  - `what` (required, first) — `both` (default), `favorites`, or `watched`
  - `source_url` (required) — Source server URL
  - `source_username` (required) — Local username, or Emby Connect email if `source_login` is `connect`
  - `source_password` (required) — Password on source server
  - `dest_url` (required) — Destination server URL
  - `dest_username` (required) — Local username, or Emby Connect email if `dest_login` is `connect`
  - `dest_password` (required) — Password on destination server
  - `source_login` (optional) — `local` (default) or `connect` (Emby Connect email login)
  - `dest_login` (optional) — `local` (default) or `connect` (Emby Connect email login)
  - `source_type` (optional) — `emby` (default) or `jellyfin`
  - `dest_type` (optional) — `emby` (default) or `jellyfin`
- `/reminder` — Admin-only group (restricted via `setDefaultMemberPermissions(Administrator)`, guild-only, ephemeral replies). Subcommands:
  - `/reminder run` — Immediately sends invoice reminders for invoices due tomorrow (same job the daily scheduler runs; dedupe still applies). Replies with an ephemeral summary embed.
  - `/reminder link client:<client> user:<@discord>` — Links a Discord user to an Invoice Ninja client by writing the user's ID into the client's configured custom field. `client` has live autocomplete that searches Invoice Ninja by name (a ✓ marks already-linked clients).
  - `/reminder unlink client:<client>` — Clears the Discord link (custom field) on a client.

## Architecture decisions

- Bot runs inside the same process as the Express server — no separate worker needed.
- Slash commands register to a single guild (instant) when `DISCORD_GUILD_ID` is set, otherwise globally (up to 1 hour to propagate). Guild registration is the recommended setup for a single-server bot.
- Linking a Discord user to a client is done in-Discord via `/reminder link`, which writes the Discord user ID into the client's configured custom field through the Invoice Ninja API (`PUT /api/v1/clients/{id}`). This is still the same mapping the reminder job reads — there's no separate link database. The `client` option uses Discord autocomplete backed by `GET /api/v1/clients?filter=`. Free-typed client text falls back to a name search (exact single match is used; multiple matches ask the admin to pick from autocomplete).
- Item matching uses name+type for movies/series; series name+season+episode number for episodes.
- All credentials are passed per-command, never stored — no database needed.
- Replies are ephemeral (only visible to the user who ran the command) to keep credentials private.
- Auth supports two methods per server (set via `source_login`/`dest_login`): local `AuthenticateByName`, or Emby Connect (authenticate at connect.emby.media → list linked servers → exchange for a local token on the target server).
- Jellyfin support: Jellyfin shares Emby's HTTP API for everything used here (`AuthenticateByName`, `Items`, `FavoriteItems`, `PlayedItems`). The only difference is the credentials header — Emby uses `X-Emby-Authorization`, Jellyfin uses the standard `Authorization` header (same `MediaBrowser Client=…, Token=…` value). `EmbyAuth.serverType` (`emby`/`jellyfin`) drives which header name is sent. Source and destination types are independent, so any mix works.
- Emby Connect is Emby-only — Jellyfin has no equivalent. Selecting `connect` login with a `jellyfin` server type is rejected with a clear error.
- Transfers run with a concurrency of 8 (worker pool) to stay well within Discord's 15-minute interaction window on large libraries.
- Invoice reminders map an invoice to a Discord user via a **client custom field** holding the recipient's Discord user ID (which field is configurable; default `custom_value1`). No database needed — the only persisted state is a tiny dedupe JSON file at `.data/invoice-reminders.json` (gitignored), keyed by due date → invoice IDs already reminded.
- Invoice Ninja status_id semantics: 1 draft, 2 sent, 3 partial, 4 paid, 5 cancelled. Reminders only target 2/3 with balance > 0. "Due tomorrow" is the invoice `due_date` matching today+1 computed in `REMINDER_TZ` (anchored at noon UTC to avoid DST off-by-one).
- The scheduler runs the job once on startup (so a same-day restart still catches the window) and then daily at `REMINDER_HOUR`; dedupe makes all re-runs safe. The admin `/reminder` command runs the exact same `runReminderJob`.
- DMs are sent via `client.users.fetch(id).send(...)` — works when the bot shares a guild with the user; closed DMs are caught and counted as failures, not fatal.

## Gotchas

- Global slash commands can take up to 1 hour to propagate to all Discord servers after first registration.
- Items not found on the destination simply means that media doesn't exist on that server yet.
- The bot token must be stored in Replit Secrets as `DISCORD_TOKEN`.
- Emby Connect login requires Connect to be enabled on the target server and the server to be linked to that Connect account; the server URL is matched by host (falls back to the only linked server if there's just one).
- Invoice reminders only fire for clients whose Discord user ID is filled into the configured custom field; clients without it are skipped (counted as "no Discord ID").
- For a DM to deliver, the recipient must share a Discord server with the bot and allow DMs from server members.
- The dedupe store lives at `.data/invoice-reminders.json`; deleting it lets reminders for the current day be re-sent.

## User preferences

- Never paste secrets/tokens directly in chat — always use the secure secret field (Replit Secrets / requested secret input).
