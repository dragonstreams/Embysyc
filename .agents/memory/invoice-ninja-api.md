---
name: Invoice Ninja v5 API
description: Non-obvious facts about the Invoice Ninja v5 REST API and how this bot maps invoices to Discord users.
---

# Invoice Ninja v5 REST API

- **Cloud base URL** is `https://invoicing.co`; API path is `/api/v1/...`. Self-hosted uses a custom base.
- **Auth headers**: `X-API-TOKEN: <token>` AND `X-Requested-With: XMLHttpRequest`. The `X-Requested-With` header is required by the API even though it's easy to forget.
- **`status_id` is a numeric string**: `1` draft, `2` sent, `3` partial, `4` paid, `5` cancelled. For "unpaid and actionable" use `2`/`3` with `balance > 0`. The `?client_status=unpaid` query filter narrows the list server-side but still include the `balance`/`status_id` guard.
- **Pagination** lives under `meta.pagination` (`current_page`, `total_pages`); `per_page` max is 100.
- **Embed the client** with `?include=client` so each invoice carries `client.custom_value1..4` without a second request.

## Invoice → Discord user mapping (this bot's design)

- The recipient's Discord user ID is stored in a **client custom field** (`custom_value1..4`, configurable via `INVOICE_NINJA_DISCORD_FIELD`, default `custom_value1`). No DB — the user fills these in inside Invoice Ninja.
- **Why:** keeps the project's "no database, credentials never stored" architecture; the mapping lives in the source of truth (Invoice Ninja) rather than a separate store.
- Validate the field as a Discord snowflake (`^\d{17,20}$`) before `client.users.fetch` to avoid noisy failed fetches.
- Dedupe of sent reminders is a small JSON file keyed by `dueDate -> [invoiceId]` (atomic temp+rename write); this is the only persisted state and makes scheduler re-runs / restarts safe.
