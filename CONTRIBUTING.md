# Contributing to Ghost Vanguard

## Quick start

```bash
node --version  # must be 24 (node:sqlite)
npm ci
npm run check   # typecheck
npm run build   # compile src/ → dist/ (dist is committed)
npm test        # 565+ tests (Node 24)
npm run docs    # regenerate docs/commands.md + docs/ranks.md
```

## Pull request rules

- **Do not add a standalone `/workspace` command** — Workspace stays under `/setup config workspace-*` (see `src/bot/command-tree.ts`).
- Midtown preset is opt-in for one guild: `src/workspace/types.ts: MIDTOWN_GUILD_ID`.
- **Never invent IDs** — channel/role/user IDs must come from Discord selectors and be validated.
- `dist/` must match `src/` — CI fails if you forget `npm run build`.
- `docs/commands.md` + `docs/ranks.md` are generated — run `npm run docs`, don't edit by hand.
- Never log `BLOXLINK_API_KEY`, `ROVER_API_KEY` or provider bodies — use `src/errors.ts: redact()`.
- Use `export PATH=/tmp/node24/bin:$PATH` on CI hosts that default to Node 20.

## Docs

- Operator guides live in `docs/user/` (canonical), `docs/` holds generated `commands.md`/`ranks.md`/`changelog.md`.
- Internal notes in `docs/internal/notes/` — historical fixes, not operator-facing.

## Scripts

- `scripts/build/clean.mjs` — rm `dist/`
- `scripts/docs/generate.ts` — build docs from registry
- `scripts/ops/restore-database.mjs` — verified restore (`--id … --confirm RESTORE-…`)
- See `scripts/README.md` for the rest.

## Security

Do not commit `.env`, tokens or `data/*.db`. CI's `secrets` job blocks them plus any Discord-token-like strings.
Report vulns privately — see `SECURITY.md`.
