# The dashboard

One self-contained page that shows what the bot knows: servers, protection state, the threat board,
the ticket desk and recent incidents. It is **read-only**, has **no build step**, no external fonts or
scripts and no CDN, so it works on a host with no internet and inside the bot's own port.

## Two ways to run it

| Way | Command | What it is |
|---|---|---|
| Standalone | `npm run dashboard` | Serves the dashboard from the SQLite file directly. Discord does not need to be running, so it works while the bot is offline or on a second machine |
| With the bot | nothing to do | The bot already serves it on its health port, next to `/healthz` |

```bash
npm run dashboard -- --db ./data/vanguard.db --port 7475 --host 127.0.0.1 --token SECRET
npm run dashboard:demo          # seeded sample data, port 8080, host 0.0.0.0 — for a look, not for real data
```

Defaults come from the environment: `DATABASE_PATH`, `DASHBOARD_PORT` (then `HEALTH_PORT`), `DASHBOARD_HOST`,
`DASHBOARD_TOKEN`.

## Access

`DASHBOARD_TOKEN` protects the page **and** the API. Send it as `?token=…`, an `Authorization: Bearer …`
header, or the `gv_dash` cookie the page sets once you open it with a token. Without a token the
dashboard is open to anyone who can reach the port, so keep it on `127.0.0.1` unless the host has its
own login in front of it. `/healthz` always stays open and exposes nothing about members — it is the
liveness probe uptime monitors use.

## What it shows

| Area | Contents |
|---|---|
| Overview | Servers known, authorized, protection on, people on the board, open tickets, incidents in the last 24 hours and a per-server table |
| Threat board | Every entry above Quiet with score, level, the rule that put them there, what the bot already did and when |
| Tickets | Open, unclaimed and urgent counts, the last week's numbers, average rating and the newest tickets |
| Incidents | The server's recent security events, newest first, with the actor and the outcome |

## Endpoints

| Route | Returns |
|---|---|
| `/` , `/dashboard` | The page |
| `/healthz` | `{service, version, ready, dashboard}` — open, for uptime monitors |
| `/favicon.ico`, `/logo.png` | The Ghost Vanguard mark (the page also inlines it, so a browser tab needs no request) |
| `/api/guilds` | Every known server with its state |
| `/api/overview` | The numbers behind the overview panel |
| `/api/guild?id=` | One server: summary plus its threat board |
| `/api/threats?id=` | The threat board for one server |
| `/api/tickets?id=` | Ticket desk numbers and the newest tickets |
| `/api/incidents?id=&limit=` | Recent security incidents, capped at 100 |

Only `GET` (and `HEAD`) is accepted: **405** for anything else, because a read-only dashboard cannot be
talked into changing a server. Server ids must be real Discord snowflakes (`17–20` digits) or the API
answers **400** instead of guessing. Reads are scoped to one server, so a server's ticket subjects,
incidents and board entries are never mixed into another server's response. Responses are `no-store`
and `X-Robots-Tag: noindex`.

## Refreshing and styling

The page re-reads the API every **15 seconds**, and one dropdown picks the server. The colours are the
product's own: violet `#6d5ae6` for structure, teal `#2aa5a0` for defence, red `#e0483f` for the
staff response. Staff threat-board actions are shown in red so they are impossible to miss.
