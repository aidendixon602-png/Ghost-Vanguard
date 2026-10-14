# Command audit

Scope: all nine original top-level slash commands, all 29 original subcommands, and the original restore-confirmation button. No original context commands, select menus, modals or autocomplete handlers existed. Those interaction types are now supported by the common fail-closed registry/guard contract and tested with registered mock handlers.

Every module uses centrally enforced developer/server/user/bot permissions, immediate acknowledgement, schema validation, cooldowns, categorized redacted errors, per-guild execution and structured activity logs. Common checks were removed from the old monolithic router. Domain-specific target hierarchy, safe role checks and provider policy remain in their respective services.

| Original entry | Decision | Final entry / change |
|---|---|---|
| `/help` | REWORK | Registry-generated, access-filtered help; attachment for long lists. |
| `/dev server authorize` | REWORK | Current guild authorization through persisted state/developer/lifecycle services. |
| `/verify` | REWORK | Metadata permission/cooldown gates, canceled generation-aware sync, cached/deduplicated API reads. |
| `/ask` | REWORK | Shared error/response/cooldown contract, bounded concurrency, optional provider errors with internal cause. |
| `/moderation` | REWORK | Per-action user/bot/channel policies and shared input validation; retained target hierarchy/cases. |
| `/moderation ban` | REWORK | `/moderation ban` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/moderation unban` | REWORK | `/moderation unban` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/moderation kick` | REWORK | `/moderation kick` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/moderation timeout` | REWORK | `/moderation timeout` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/moderation untimeout` | REWORK | `/moderation untimeout` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/moderation warn` | REWORK | `/moderation warn` — User Moderate Members permission; bot moderation permission no longer unnecessarily required for DB/DM-only work. |
| `/moderation history` | REWORK | `/moderation history` — User Moderate Members permission; bot moderation permission no longer unnecessarily required for DB/DM-only work. |
| `/moderation purge` | REWORK | `/moderation purge` — Bot/user channel Manage Messages and bot Read Message History; bounded 1–100 count; case logging. |
| `/security` | REWORK | Focused configuration/security commands; snapshots moved out. |
| `/security status` | REWORK | `/security status` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/security setup` | RENAME | `/security config` — Consistent configuration name; safe role/channel validation. |
| `/security admin` | REWORK | `/security admin` — Central owner/developer restriction; security access never grants developer access. |
| `/security incidents` | REWORK | `/security incidents` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/security quarantine` | REWORK | `/security quarantine` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/security release` | REWORK | `/security release` — Central owner/developer restriction when privileged restoration is requested; safe target checks. |
| `/security snapshot` | REPLACE | `/recovery snapshot create` — Separate snapshot registry module and permission policy. |
| `/security restore` | REPLACE | `/recovery snapshot restore` — Same reviewed recovery contract with central guarded one-time confirmation. |
| `/security roblox_block` | RENAME | `/security roblox-block` — Readable consistent hyphenated option; strict positive Roblox ID validation. |
| `/antinuke` | REWORK | Metadata policies and state-aware control; baseline capture, observe/enforce, threshold validation. |
| `/antinuke enable` | REWORK | `/antinuke enable` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke disable` | REWORK | `/antinuke disable` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke rules` | REWORK | `/antinuke rules` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke mode` | REWORK | `/antinuke mode` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke rule` | REWORK | `/antinuke rule` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke test` | REWORK | `/antinuke test` — Explicitly documented as non-mutating threshold inspection, not a live destructive enforcement test. |
| `/antinuke whitelist` | REWORK | Metadata security access, scoped grants, temporary expiry, self-trust protections. |
| `/antinuke whitelist add` | REWORK | `/antinuke whitelist add` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke whitelist remove` | REWORK | `/antinuke whitelist remove` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/antinuke whitelist list` | REWORK | `/antinuke whitelist list` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/dev` | REWORK | Diagnostics only; authorization/listing moved to explicit lifecycle commands. |
| `/dev diagnostics` | REWORK | `/dev diagnostics` — Uses centralized policy/validation/response handling; guild-scoped data. |
| `/dev servers` | REPLACE | `/authorizedservers` — Persistent authorized records, member counts and developer-bound pagination. |
| `/dev deauthorize` | REPLACE | `/dev server deauthorize` — Persistent removal actor/time, immediate cancellation/cleanup and leave. |
| `restore:<nonce>` button | REWORK | Central authorization, security access, bot permissions, cooldown, user/guild/expiry binding, staleness check and one-time consumption. |

## Added entries

| Entry | Purpose |
|---|---|
| `/dev server deauthorize` | Explicit developer revocation/cleanup/leave. |
| `/serverauth` | Developer authorization/database/protection metadata. |
| `/authorizedservers` and `servers:<developer>:<page>` buttons | Persistent authorized-server listing with guarded pagination. |
| `/banserver`, `/unbanserver` | Persistent developer-managed server bans. |
| `/server status`, `/server info` | Safe information before authorization. |
| `/recovery snapshot view` | Recent per-guild baselines. |

## Removed infrastructure

- Old monolithic `router.ts`, hardcoded command array `commands.ts`, and manual `register.ts`/npm registration script.
- Per-guild registration configuration; command definitions always use global application registration.
- Persisted boolean authorization authority, scattered common permission checks and hardcoded help.
- Legacy global commands absent from the new registry, through normalized bulk replacement only when needed.
- Legacy per-guild registrations belonging to this application, using a persisted one-time migration for each connected guild.
- Old compiled router/registration files: build cleans `dist` before recompilation.

## Shared audit checks

| Check | Final implementation |
|---|---|
| Naming/descriptions/options | All original schemas reviewed; focused snapshot family and config/Roblox naming; command registry validates schemas and uniqueness. |
| Validation | Required options/subcommands, enums, IDs, role/channel references, bounded numbers/strings; domain role safety and hierarchy. |
| Authority | Server state/ban, developer service, security grants and subcommand-specific user/bot/channel policies. |
| Responses | Metadata response kind, ephemeral defaults, common ACK/edit helpers and safe categorized failure embeds. |
| Data | Persisted state/history/ban tables, retained guild-scoped settings/cases/snapshots/links, protected generation checks on writes. |
| API use | Metadata cooldowns, bounded command queue, duplicate interaction suppression, Discord REST limits, read cache/dedup/concurrency/backoff, protected outbox/refresh. |
| All interaction types | Registry/guard handles slash/context/buttons/selects/modals/autocomplete; missing handlers reject without protected execution. |
| Background authorization | Event gates, initialized-guild filter, generation-aware mutations, abortable provider reads and cache cleanup. |
| Error/logging | Categories/reference IDs, safe user message, redacted stack/cause and structured context/time/result. |
| Startup | Environment, exact module-load failures, duplicate/schema/handler validation, DB integrity/lease, guild reconciliation, normalized global sync before readiness. |
