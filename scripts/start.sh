#!/bin/sh
# Ghost Vanguard host start script (Wispbyte / Linux).
# Startup command:  cd /home/container/midtown-vanguard && sh scripts/start.sh
#
# 1. Installs production dependencies.
# 2. If data/import/vanguard.db exists, merges ONE server (IMPORT_GUILD, default Midtown Tower
#    Cafe) from it into data/vanguard.db, keeping every other server as it is. The previous
#    database is kept as data/vanguard-before-merge-<time>.db and the import folder is renamed
#    to data/import-done-<time>, so the merge runs only once. If the merge fails, nothing is
#    changed and the bot starts on the existing database.
# 3. Starts the bot.
set -e
cd "$(dirname "$0")/.."
NODE="$(command -v node || echo /usr/local/bin/node)"
NPM="$(command -v npm || echo /usr/local/bin/npm)"
GUILD="${IMPORT_GUILD:-845678484276641842}"

[ -n "$MV_DRY_RUN" ] || "$NPM" install --omit=dev --no-audit --no-fund

if [ -f data/import/vanguard.db ]; then
    echo "[import] Found data/import/vanguard.db: merging server $GUILD into data/vanguard.db ..."
    rm -f data/merged.db
    if "$NODE" scripts/merge-guild.mjs --bot . --from data/import --into data --guild "$GUILD" --out data/merged.db; then
        stamp="$(date +%Y%m%d-%H%M%S)"
        for s in "" -wal -shm; do
            if [ -f "data/vanguard.db$s" ]; then mv "data/vanguard.db$s" "data/vanguard-before-merge-$stamp.db$s"; fi
        done
        mv data/merged.db data/vanguard.db
        mv data/import "data/import-done-$stamp"
        echo "[import] Merge complete. Previous database kept as data/vanguard-before-merge-$stamp.db"
    else
        rm -f data/merged.db
        echo "[import] MERGE FAILED (see above). Nothing was changed; starting with the existing database."
    fi
fi

[ -n "$MV_DRY_RUN" ] && { echo "[dry run] would start the bot now"; exit 0; }
FORCE_COLOR=1 exec "$NODE" dist/index.js
