---
name: .replit env var overrides managed Secret
description: A plaintext shared env var in .replit [userenv.shared] silently overrides a managed Replit Secret of the same name.
---

# Shared env var overrides managed Secret (same key)

If a key (e.g. `DISCORD_TOKEN`) exists BOTH as a plaintext `[userenv.shared]` entry in `.replit` AND as a managed Replit Secret, the **plaintext env var wins** at runtime. The Secret's value is shadowed.

**Why it matters:** This caused a Discord bot to run as the wrong application — the plaintext `.replit` token (one bot) overrode the managed Secret (a different bot). Deleting the plaintext shared env var (`deleteEnvVars({keys, environment:"shared"})`) made the managed Secret take effect, which silently swapped the live bot identity.

**How to apply:**
- A secret committed as plaintext in `.replit` is a real leak — it's in git history. Remove it via `deleteEnvVars` (NOT by editing `.replit`, which is blocked) and have the user ROTATE the credential, then store the new value as a Secret via `requestEnvVar`.
- When the "active" credential doesn't match what's in Secrets, suspect a shadowing `[userenv.shared]` entry. Check with `viewEnvVars({type:"env", environment:"shared"})`.
- `.replit` cannot be edited directly by the agent; env vars are managed only through the environment-secrets callbacks.
