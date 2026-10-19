# Validation

Run these after any change:

```powershell
npm run check
npm test
npm run build
npm run doctor
```

## Last recorded run

Command-system and restart-flow work (2026-10-18): using Node 24, the build/typecheck and command/rank documentation generation passed; the full suite passed **545 tests, 0 failures**. `dist/` was regenerated from `src/`. The outer system npm is Node 20 and prints engine warnings, but build, docs and tests ran under Node 24.

## Not covered

Automated tests use mock Discord guilds and temporary SQLite databases. No live Discord token, server change, deployment or provider credential was used, so these still need a manual check:

- A real server installation, including the audit-log inviter check
- Live API behavior and Discord's final role-hierarchy normalization
- `Setup.ps1` and `Start.cmd`, which need Windows
- The PowerShell updater, which was payload-verified and simulated against both supplied releases but requires Windows for execution
- Discord credentials and the Wispbyte host. After deploying, try `,genreban` and `,ungenreban` on a disposable test account from a user whose exact ID is listed in `DEVELOPER_IDS`.

## References

- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/application-commands.mdx
- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx
