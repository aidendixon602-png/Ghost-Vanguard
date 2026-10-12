# Security

## Keep these out of the repository
- `.env` (bot token, API keys, update token)
- `data/` and any `*.db` file (every server's settings, cases and ban records)

CI refuses commits that contain them, or anything that looks like a Discord token or API key.

## If a secret leaks
1. **Discord bot token:** Developer Portal → your application → Bot → **Reset Token**, then update `.env` on the server and restart.
2. **OpenAI key:** delete it at platform.openai.com/api-keys and create a new one.
3. **GitHub update token:** revoke it in GitHub → Settings → Developer settings → Fine-grained tokens, and create a new read-only one.

## Automatic updates
Whoever can push to `main` controls the live bot. Keep the repository private, give write access only to people you trust, and consider turning on branch protection for `main`.
