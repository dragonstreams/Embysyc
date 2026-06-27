---
name: Discord autocomplete timing
description: Discord rejects slash-command autocomplete responses that take longer than ~3s; never reuse a long backend timeout for the autocomplete lookup.
---

Discord requires an autocomplete interaction to be answered within ~3 seconds, the
same hard window as deferring a chat-command reply.

**Rule:** any external API call made inside an autocomplete handler must use a short
timeout (≈1.5–2.5s) and fail soft (`interaction.respond([])`), NOT the default
backend request timeout used elsewhere.

**Why:** the Invoice Ninja client (`invoiceninja.ts`) shares a single
`fetchWithTimeout` whose default is 20s. Autocomplete originally reused it, so any
backend response between 3s and 20s made `/reminder link|unlink` show an
intermittent "interaction failed" even though the call eventually succeeded.

**How to apply:** when calling a shared API helper from an autocomplete path, thread
a short `timeoutMs` through (e.g. `searchClients(config, query, 2500)`). The normal
command paths (defer + edit reply) can keep the long timeout.
