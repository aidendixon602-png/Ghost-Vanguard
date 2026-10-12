# Vanguard 2.10.0 — protection and Discord moderation tools

## Update

Stop Vanguard before installing. The updater checks the database startup lease and Windows image-library file locks before backing up or changing project files. A recently stopped/crashed process can retain a lease for 30 seconds. No processes are killed. Existing settings, bypasses, credentials, records and databases are retained. The Windows PowerShell flow was reviewed and its payload simulated; it has not been run on Windows in this workspace.

## Health

`/health` is restricted to existing authorized security administrators. It reports saved anti-nuke mode, bot/log permissions, role readiness, role bypasses, scam settings, current channel inclusion, reporting exclusions, AI configuration, observed verification-provider results, latest recorded verified database backup and exhausted security-log retries.

Provider configuration is not an authentication test. Results are last observed requests since restart, with the observation time and any active pause.

## Safe scam testing and reporting

`/scam test text:<text>` and `/scam test image:<attachment>` use the same domain/image classification as live scanning. They take no deletion/ban actions, store no incident, and make no AI requests. Discord attachment downloads occur for image tests. Bounds remain static PNG/JPEG/WebP, 8 MiB and 8 megapixels. Two tests maximum at once; command cooldown is five seconds.

Exact reference/domain matches are confirmed; similar images and suspicious combinations are review results. No match is not a safety guarantee. Test results describe matching, not live readiness or permission to ban the supplied account.

Before staff post scam evidence in a normal channel, run `/scam exclude channel:<reporting-channel> excluded:true`. Its threads are also excluded. `/health` lists the exclusions. Existing exclusions and deliberate disables survive updates. No reporting channel is guessed or automatically exempted.

## Bypasses and integration alerts

`/trust list` now separates user, role and verification-bot scopes, shows who set each grant and when it expires, and supports `page` and `expired:true`. Expired grants never bypass enforcement and may be removed by periodic cleanup. Only active role grants exempt an entire role from readiness checks. Configured bot owner/developers can manage their own grants; ordinary security administrators need another administrator.

Verification-provider failures generate one security-log notice per failure/recovery transition. Cooldowns and retry behavior are retained; no API key is replaced or guessed. No recovery notice is sent until a request actually succeeds.

