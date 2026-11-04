# Hosting

Ghost Vanguard is a single-process bot backed by SQLite. It uses one managed connection, WAL, a busy timeout, transactions and SQLite's online backup API, so there is no database server to run.

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

On a container host that extracts into `/home/container`, use a persistent project directory and keep your existing `.env` and `data/` when upgrading. For a fresh checkout, the current repository name gives `/home/container/Ghost-Vanguard`; if an existing deployment still lives in `/home/container/midtown-vanguard`, you can keep that directory and substitute it in the commands below. Run `npm install --omit=dev` once. The compiled `dist/` is included, so no build step is needed on the host. A typical startup command for a fresh checkout is:

```sh
cd /home/container/Ghost-Vanguard && /usr/local/bin/npm install --omit=dev && FORCE_COLOR=1 /usr/local/bin/node dist/index.js
```

When upgrading, replace the whole `dist/` folder rather than extracting over it, so files from removed features (such as the old `/csb` command) are not left behind and loaded; `node scripts/build/verify-install.mjs` refuses an install that still contains `/csb`. After stopping the bot, wait 30 seconds before starting it again so its database lease expires. Never put `DELETE FROM leases` in the startup command: the lease is what stops two copies of the bot running against one database.

This is not a sharded or distributed deployment. Run exactly one instance; a database lease rejects a second one.

## What the console shows while it starts

The console prints a line for each step, so a console that stays blank means the bot is not running, or the panel is not showing its output. A healthy start looks like this:

```
› Starting the bot · 1a2b3c4
› Starting Ghost Vanguard v3.2.1
› Opening the database
› Loading commands and checking the database
› Connecting to Discord
  Dashboard: 127.0.0.1:7475/  (set DASHBOARD_TOKEN before exposing it)
› Connected as Ghost Vanguard#0001. Starting servers
› Registering slash commands

  GHOST VANGUARD  v3.2.1
  SYSTEM ONLINE  ·  Ghost Vanguard#0001
```

The first line comes from `launch.js`, the rest from the bot. If one step takes longer than 30 seconds, the bot repeats `⚠ Still waiting after 30 s on "<step>"` every 30 seconds, so the last step printed is the one that is stuck:

- **Opening the database** waits up to 35 seconds when the previous run crashed or was killed less than 30 seconds earlier and left its database lease behind. A clean stop releases the lease at once. While it waits, it prints `Waiting …s for the previous Vanguard run to release the database`.
- **Connecting to Discord** that never finishes means the bot is running but Discord is not answering: the host cannot reach Discord, or Discord is limiting its IP address (see [Discord rate limits on a host](#discord-rate-limits-on-a-host)).
- **Connected as … Starting servers** names how many servers it has started, such as `(2 of 3)`, in each reminder.
- Before `Starting the bot`, `launch.js` may print `📦 Installing dependencies…`. That install runs quietly and can take a few minutes on a small host.

The **Access** block at the end of the banner lists everyone with bot-wide power. Each ID carries the person's name when the bot has seen them, and a rank given with `/setup staff global` comes off by running that command again with rank **Remove rank**.

## What the console shows while the bot runs

After the banner the console stays quiet unless something happens. Each slash command someone types is one line: the command, who ran it, in which server and how long it took.

```
/setup staff global · aidendixon602 · Midtown HQ · 142 ms
```

Buttons, menus and autocomplete are not listed. Failures, warnings and database backups have their own lines. `LOG_LEVEL=warn` in `.env` hides the command lines and the other routine event lines and keeps warnings and errors.

When the bot stops it says why, then that it finished:

```
› Stopping: asked to stop (SIGTERM) by the host panel, an update or /restart
› Stopped · exit code 0
```

If the bot is killed from outside, because the host ended the process or it ran out of memory, neither line appears. The start after a kill can wait up to 35 seconds for the old run's database lease, as described above.

With `LOG_FORMAT=json` each of these is one JSON object per line instead: `startup_progress` and `startup_slow` while it starts, `command_activity` for commands, `shutdown_started` and `shutdown_finished` when it stops.

## When the console tab stays empty

Some panels show only the lines that arrive while the console tab is open, and the **Output** box under Wispbyte's **Pull** button stops a few seconds after the server starts. Neither shows a bot that finished starting a minute ago. The bot keeps its own copy of what it prints:

- **`/dev logs`** (Developers only) shows the newest 40 lines in Discord. `lines:` takes 5 to 300, and more than fits in a message comes as `console.txt`. Times are UTC.
- **`console.log`**, next to the database file (`data/console.log` by default), holds the same lines with a date and time on each, from earlier runs too. Open it in the host's file manager. At 1 MB it moves to `console.old.log`, so at most two files are kept.

Both start with the first line of a run, so they hold the start-up steps, the banner, warnings and errors. Discord tokens, API keys and `password=` values are hidden before a line is stored. What `launch.js` prints (git output, update messages) is not in them because it comes from a different process, and neither is anything the host or Node itself prints before the bot is running.

`/dev logs` needs a bot that is online. If it never gets online, read `console.log` instead.

## Health endpoint

`/healthz` returns **503** until the database, command registry, global command sync and guild reconciliation have all succeeded, then **200** once the gateway is ready. It reports version, uptime, guild count, database health and protection statistics.

## Discord rate limits on a host

Discord applies some limits per IP address. Avoid shared hosts where other people's bots share your address. A burst of invalid requests (401, 403 and 429 responses) from one IP can get it blocked temporarily, so make sure the bot's role sits above the roles it manages and has Manage Roles, Manage Channels and View Audit Log. See [recovery.md](recovery.md#rate-limits) for how restores handle waits.
