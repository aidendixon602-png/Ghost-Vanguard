# Security Policy

## Reporting a vulnerability

Do not open a public issue for security problems. Contact a project developer directly with a description of the issue, the steps to reproduce it and the potential impact. Reports are acknowledged as soon as possible, and fixes are released through the normal CI-gated update process.

## Secrets and data

The following must never be committed:

- `.env`: the bot token, API keys and the update token
- `data/` and any `*.db` file: every server's settings, cases and ban records

The CI workflow rejects commits that contain these files, or anything that looks like a Discord token or API key.

## Responding to a leaked secret

| Secret | Action |
|---|---|
| Discord bot token | Developer Portal → Application → Bot → **Reset Token**, then update `.env` on the host and restart |
| OpenAI API key | Revoke it at platform.openai.com/api-keys and create a new one |
| GitHub update token | Revoke it under Settings → Developer settings → Fine-grained tokens, and create a new read-only token |

## Deployment integrity

Anyone with push access to `main` can change the running bot, because the host installs every commit that passes CI. Keep the repository private, limit write access to trusted developers, and enable branch protection on `main` (require pull requests and passing checks).

## Access model

Developer access is granted only through `DEVELOPER_IDS` on the host. Bot-wide ranks are granted by developers or Supreme Leaders with `/setup staff global`. Discord's Administrator permission never unlocks actions that weaken protection, such as disabling anti-nuke, editing the whitelist, restoring backups or granting ranks. See [docs/ranks.md](docs/ranks.md).
