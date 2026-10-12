import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { VERSION } from '../../config.js';

export default defineCommand(new SlashCommandBuilder().setName('ping').setDescription('Check that Vanguard is responding: latency, uptime and version'),
    { requiresAuthorization: false, responseKind: 'info', category: 'utility', cooldown: 3000 }, async (ctx, i) => {
    const started = Date.now();
    const up = Math.floor(process.uptime()), d = Math.floor(up / 86400), h = Math.floor(up % 86400 / 3600), m = Math.floor(up % 3600 / 60);
    const db = ctx.store.get('PRAGMA quick_check')?.quick_check === 'ok' ? 'ok' : 'check /dev database status';
    return `🏓 **Pong!**\n**Gateway:** ${Math.max(0, Math.round(ctx.client.ws.ping))} ms · **Response:** ${Math.max(0, started - i.createdTimestamp)} ms\n**Uptime:** ${d}d ${h}h ${m}m · **Version:** ${VERSION} · **Database:** ${db}`;
});
