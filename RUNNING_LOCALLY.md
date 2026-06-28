# Running Embysyc Locally

This is a Discord bot (Emby/Jellyfin favorites & watch-history transfer, plus
Invoice Ninja DM reminders) that runs as a single self-contained Node service.
**No database is required at runtime** — the only persisted state is a small JSON
file (`.data/invoice-reminders.json`).

## 1. System prerequisites

| Tool     | Version            | Notes                                                                 |
| -------- | ------------------ | --------------------------------------------------------------------- |
| Node.js  | 24.13.0 (`.nvmrc`) | Use `nvm install 24.13.0`, or install Node 24.x                       |
| pnpm     | 10.26.1            | `npm install -g pnpm@10.26.1` (this repo refuses npm/yarn)            |
| Git      | any recent         | to clone the repo                                                     |

## 2. Get the code

```bash
git clone https://github.com/dragonstreams/Embysyc.git
cd Embysyc
```

## 3. Install dependencies

```bash
pnpm install
```

> **macOS / Windows gotcha:** `pnpm-workspace.yaml` has `overrides` that strip out
> every non-Linux esbuild binary (the build tool). On Linux-x64 it works as-is.
> On macOS or Windows the build will fail because the esbuild binary for your OS
> was pruned. Fix: in `pnpm-workspace.yaml`, delete the override line matching your
> machine (e.g. `"esbuild>@esbuild/darwin-arm64": "-"` for Apple Silicon, or
> `"esbuild>@esbuild/win32-x64": "-"` for Windows), then run `pnpm install` again.
> Only the `esbuild` overrides matter for this bot — the `rollup` / `lightningcss`
> / `tailwindcss` ones are unused here.

## 4. Environment variables

Only `PORT` and `DISCORD_TOKEN` are needed for the core bot. The rest enable or
tune the Invoice Ninja reminder feature.

| Variable                      | Required?    | Default                | Purpose                                                                              |
| ----------------------------- | ------------ | ---------------------- | ----------------------------------------------------------------------------------- |
| `PORT`                        | **Required** | none                   | Port for the Express/health server (e.g. `5000`). App throws if missing.            |
| `DISCORD_TOKEN`               | **Required** | none                   | Discord bot token. Without it the bot won't log in.                                  |
| `DISCORD_GUILD_ID`            | Optional     | —                      | If set, slash commands register instantly to that one server; otherwise global (up to 1h). |
| `INVOICE_NINJA_API_TOKEN`     | Optional     | —                      | Enables invoice reminders. If unset, reminder features are disabled (bot still runs). |
| `INVOICE_NINJA_URL`           | Optional     | `https://invoicing.co` | Your Invoice Ninja instance URL.                                                    |
| `INVOICE_NINJA_DISCORD_FIELD` | Optional     | `custom_value1`        | Which client custom field holds the Discord ID (`custom_value1`–`custom_value4`).   |
| `REMINDER_TZ`                 | Optional     | `UTC`                  | IANA timezone for the daily reminder run.                                           |
| `REMINDER_HOUR`               | Optional     | `9`                    | Hour (0–23) the daily reminder fires.                                               |
| `NODE_ENV`                    | Optional     | —                      | `production` enables JSON logs; otherwise pretty logs.                              |
| `LOG_LEVEL`                   | Optional     | `info`                 | Log verbosity.                                                                      |

## 5. Build & run

```bash
# Build (esbuild bundles src -> artifacts/api-server/dist/index.mjs)
pnpm --filter @workspace/api-server run build

# Run the built bundle
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

Or the all-in-one dev command (builds, then starts):

```bash
pnpm --filter @workspace/api-server run dev
```

> **Windows note:** the `dev` script uses `export NODE_ENV=...` (bash syntax), so
> it works on macOS/Linux but not in Windows CMD/PowerShell. On Windows, use Git
> Bash / WSL, or run the two-step build + `node` commands above (setting env vars
> separately).

### Quick start (macOS / Linux)

```bash
export PORT=5000
export DISCORD_TOKEN="your-bot-token"
# optional:
# export DISCORD_GUILD_ID="your-server-id"
# export INVOICE_NINJA_API_TOKEN="your-invoice-ninja-token"

pnpm install
pnpm --filter @workspace/api-server run build
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

You should see `Server listening` in the logs and the bot come online in Discord.

## 6. Runtime notes

- **No database, no Docker needed.** Reminder dedupe state is written to
  `.data/invoice-reminders.json` relative to the directory you launch from — make
  sure that working directory is writable.
- **The bot holds a persistent Discord connection**, so keep the process running.
  For an always-on host, run it under a process manager (e.g. `pm2`, `systemd`) or
  a platform that doesn't sleep on idle.
- **Secrets are never committed.** Provide `DISCORD_TOKEN` /
  `INVOICE_NINJA_API_TOKEN` via your environment, not in the repo.
