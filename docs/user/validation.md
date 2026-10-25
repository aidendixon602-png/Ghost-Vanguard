# Validation

Run these after any change:

```powershell
npm run check
npm test
npm run build
npm run doctor
```

## Last recorded run

Slash-only command dispatch, dangerous-grant policy and staff-led threat-board work (2026-10-25): using Node 24.22.1, build/typecheck and command/rank documentation generation passed; the full suite passed **562 tests, 0 failures**. `dist/` was regenerated from `src/`. No live Discord deployment was performed.

## Not covered

Automated tests use mock Discord guilds and temporary SQLite databases. No live Discord token, server change, deployment or provider credential was used, so these still need a manual check:

- A real server installation, including the audit-log inviter check
- Live API behavior and Discord's final role-hierarchy normalization
- `Setup.ps1` and `Start.cmd`, which need Windows
- The PowerShell updater, which was payload-verified and simulated against both supplied releases but requires Windows for execution
- Discord credentials and the Wispbyte host. After deploying, try `/network genreban` and `/network ungenreban` on a disposable test account with an authorized Developer.

## References

- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/application-commands.mdx
- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx
