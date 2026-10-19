# src/workspace — Guild-scoped Sheets integration (opt-in)

Config lives under `/setup config workspace-*` (under `commands/configuration/guild-config.ts: addWorkspaceSubcommands()`).

Modules: `config.ts` (persisted profile), `types.ts` (Midtown preset + generic), `sheets.ts` (Sheets v4 RAW writes, `=`-preserving), `store.ts` (SQLite counters & submissions), `staff.ts` (preview → confirm sync), `handlers.ts` (button routing), `panels.ts` (member/staff/task panels), `submissions/records/reviews/tasks/reports.ts`, `setup-command.ts` (subcommands), `permissions.ts`.

See `docs/user/workspace.md` for operator setup.
