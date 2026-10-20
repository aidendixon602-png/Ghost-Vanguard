export class ProtectionStats {
    client;
    store;
    ready;
    cached;
    fetching = false;
    cursor = 0;
    constructor(client, store, ready = id => store.isAuthorized(id)) {
        this.client = client;
        this.store = store;
        this.ready = ready;
    }
    invalidate() {
        this.cached = undefined;
    }
    get(force = false) {
        if (!force && this.cached && Date.now() - this.cached.refreshedAt < 60000)
            return this.cached;
        const guilds = [...this.client.guilds.cache.values()].filter(g => this.store.isAuthorized(g.id) && this.ready(g.id) && this.store.readGuild(g.id, () => this.store.settings(g.id).enabled));
        const users = new Set(), roblox = new Set();
        let complete = true;
        for (const guild of guilds) {
            for (const id of guild.members.cache.keys())
                users.add(id);
            if (guild.members.cache.size < guild.memberCount)
                complete = false;
            const rows = this.store.readGuild(guild.id, () => this.store.all('SELECT DISTINCT roblox_id FROM links WHERE guild_id=?', guild.id));
            for (const row of rows)
                roblox.add(row.roblox_id);
        }
        return this.cached = { guilds: guilds.length, users: users.size, robloxUsers: roblox.size, complete, refreshedAt: Date.now() };
    }
    async refreshMembers() {
        if (this.fetching || !this.client.isReady())
            return;
        const guilds = [...this.client.guilds.cache.values()].filter(g => this.store.isAuthorized(g.id) && this.ready(g.id) && this.store.settings(g.id).enabled && g.members.cache.size < g.memberCount);
        const guild = guilds[this.cursor++ % Math.max(1, guilds.length)];
        if (!guild)
            return;
        this.fetching = true;
        try {
            await guild.members.fetch({ time: 30000 });
            this.invalidate();
        }
        catch { /* Partial member coverage is clearly labelled; never invent a deduplicated count. */ }
        finally {
            this.fetching = false;
        }
    }
}
const counted = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** The rotating custom-status lines shown under the bot's name. */
export function presenceLines(stats) {
    const lines = [`🛡️ Protecting ${counted(stats.guilds, 'server')}`, `👥 Watching over ${counted(stats.users, stats.complete ? 'member' : 'known member')}`];
    if (stats.robloxUsers)
        lines.push(`🎮 ${counted(stats.robloxUsers, 'verified Roblox account')}`);
    lines.push('💬 Use /help to see commands');
    return lines;
}
