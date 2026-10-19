# src/security — Protection engine

- **security.ts** — Main handler: observations → rules → decisions. `noteThreat()` feeds `threat-board.ts`.
- **threat-board.ts** — Scores (Watch 25+, High 55+, Critical 85+), decay & reversibility. Sweeps every minute.
- **locked-antinuke.ts / readiness.ts** — Observe vs enforce, readiness checks.
- **scam.ts / automod.ts / antiping.ts / lockdown.ts / raidmode.ts / new-accounts.ts** — Specialized guards.
- **network-ban.ts** — Genrebans/hardbans, cross-server enforcement.
