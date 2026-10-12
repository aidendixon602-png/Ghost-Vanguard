# Validation

Run these after any change:

```powershell
npm run check
npm test
npm run build
npm run doctor
```

## Last recorded run

Version 2.22.1 (2026-10-11): TypeScript check and build passed, and all 376 tests passed. The command registry loads 58 commands with no `/csb`, and `dist/` was regenerated from the included source. The new ban behaviour is covered by `test/network-ban.test.ts` and `test/ban-commands.test.ts`, using mock Discord servers and temporary SQLite databases.

## Not covered

Automated tests use mock Discord guilds and temporary SQLite databases. No live Discord token, server change, deployment or provider credential was used, so these still need a manual check:

- A real server installation, including the audit-log inviter check
- Live API behavior and Discord's final role-hierarchy normalization
- `Setup.ps1` and `Start.cmd`, which need Windows
- The PowerShell updater, which was payload-verified and simulated against both supplied releases but requires Windows for execution
- Discord credentials and the Wispbyte host. Try `/genreban` and `/ungenreban` on a test account after deploying.

## References

- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/application-commands.mdx
- https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx
