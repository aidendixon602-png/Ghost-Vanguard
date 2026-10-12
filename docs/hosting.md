# Hosting

Midtown Vanguard is a single-process bot backed by SQLite. It uses one managed connection, WAL, a busy timeout, transactions and SQLite's online backup API, so there is no database server to run.

## Persistent storage is required

The database survives restarts and crashes, but whether it survives a **redeploy** depends on your host's disk. Mount a persistent disk and point the bot at it:

```ini
DATABASE_PATH=/var/data/vanguard/vanguard.db
DATABASE_BACKUP_DIRECTORY=/var/data/vanguard/database-backups
HEALTH_HOST=0.0.0.0
HEALTH_PORT=7475
```

Server authorization lives in this database. An ephemeral filesystem, or a deleted disk, loses it. Keep an independent off-host copy of the backups if you need to survive losing the disk itself.

To copy the database by hand, stop the bot first, or use the online backup tool. Do not copy only the main file while WAL writes are active.

## Running

```bash
npm ci && npm run build   # or use the prebuilt dist/ with: npm install --omit=dev
npm start                 # one worker only
```

On a container host that extracts into `/home/container`, put the project in `/home/container/midtown-vanguard`, keep your existing `.env` and `data/`, run `npm install --omit=dev` once, and start with `cd /home/container/midtown-vanguard && node dist/index.js`. The compiled `dist/` is included, so no build step is needed on the host. A typical startup command is:

```sh
cd /home/container/midtown-vanguard && /usr/local/bin/npm install --omit=dev && FORCE_COLOR=1 /usr/local/bin/node dist/index.js
```

When upgrading, replace the whole `dist/` folder rather than extracting over it, so files from removed features (such as the old `/csb` command) are not left behind and loaded; `node scripts/verify-install.mjs` refuses an install that still contains `/csb`. After stopping the bot, wait 30 seconds before starting it again so its database lease expires. Never put `DELETE FROM leases` in the startup command: the lease is what stops two copies of the bot running against one database.

This is not a sharded or distributed deployment. Run exactly one instance; a database lease rejects a second one.

## Health endpoint

`/healthz` returns **503** until the database, command registry, global command sync and guild reconciliation have all succeeded, then **200** once the gateway is ready. It reports version, uptime, guild count, database health and protection statistics.

## Discord rate limits on a host

Discord applies some limits per IP address. Avoid shared hosts where other people's bots share your address. A burst of invalid requests (401, 403 and 429 responses) from one IP can get it blocked temporarily, so make sure the bot's role sits above the roles it manages and has Manage Roles, Manage Channels and View Audit Log. See [recovery.md](recovery.md#rate-limits) for how restores handle waits.
