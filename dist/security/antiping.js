import { AutoModerationRuleTriggerType, Colors, EmbedBuilder } from 'discord.js';
import { AppError } from '../errors.js';
export const ANTIPING_RULE_NAME = 'Vanguard Staff Anti-Ping';
export async function configureAntiPing(ctx, guild, actor, enabled, targets) {
    ctx.assertActive();
    if (targets.some(t => !/^\d{17,20}$/.test(t.target_id)))
        throw new AppError('VALIDATION_ERROR', 'Invalid target ID.');
    if (enabled && !targets.some(t => t.kind !== 'bypass'))
        throw new AppError('VALIDATION_ERROR', 'Protect a staff role or user first.');
    const before = ctx.store.get('SELECT * FROM antiping_config WHERE guild_id=?', guild.id);
    if (before?.rule_id && before.rule_id !== 'native-public') {
        let old;
        try {
            old = await guild.autoModerationRules.fetch(before.rule_id);
        }
        catch (e) {
            if (e?.status !== 404)
                throw e;
        }
        ctx.assertActive();
        if (old) {
            if (old.creatorId !== ctx.client.user?.id || old.name !== ANTIPING_RULE_NAME || old.triggerType !== AutoModerationRuleTriggerType.Keyword)
                throw new AppError('VALIDATION_ERROR', 'Old rule is not safely identifiable as Vanguard-owned.');
            await old.edit({ enabled: false, reason: 'Switch to native mention protection' });
            ctx.assertActive();
        }
    }
    ctx.store.transaction(() => {
        ctx.store.run('INSERT INTO antiping_config VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,rule_id=excluded.rule_id', guild.id, Number(enabled), 'native-public');
        ctx.store.run('DELETE FROM antiping_targets WHERE guild_id=?', guild.id);
        for (const t of targets)
            ctx.store.run('INSERT OR IGNORE INTO antiping_targets VALUES(?,?,?)', guild.id, t.kind, t.target_id);
        ctx.store.history(guild.id, 'antiping', before, { enabled, targets }, actor);
    });
    ctx.logs.push(guild.id, new EmbedBuilder().setColor(Colors.Blurple).setTitle('Mention protection updated').setDescription(`By <@${actor}> · ${enabled ? 'Enabled' : 'Disabled'} · Native public replies`));
    return `Native mention protection ${enabled ? 'enabled' : 'disabled'}. Replies publicly, then deletes the offending message.`;
}
export async function processStaffMention(ctx, input) {
    if (!input.guild)
        return;
    const guild = input.guild;
    await ctx.security.queue.run(guild.id, async () => {
        const active = () => ctx.store.assertAuthorized(guild.id);
        active();
        const config = ctx.store.get('SELECT * FROM antiping_config WHERE guild_id=?', guild.id);
        if (!config?.enabled || config.rule_id !== 'native-public')
            return;
        const message = input.partial ? await input.fetch() : input;
        active();
        if (message.author.bot || message.webhookId || ctx.security.trusted(guild, message.author.id))
            return;
        const member = message.member ?? await guild.members.fetch(message.author.id);
        active();
        const targets = ctx.store.all('SELECT kind,target_id FROM antiping_targets WHERE guild_id=?', guild.id);
        if (targets.some(t => t.kind === 'bypass' && member.roles.cache.has(t.target_id)))
            return;
        const roles = new Set(targets.filter(t => t.kind === 'role').map(t => t.target_id));
        const users = new Set(targets.filter(t => t.kind === 'user').map(t => t.target_id));
        let hit = [...message.mentions.roles.keys()].some(id => roles.has(id));
        for (const id of message.mentions.users.keys()) {
            if (id === message.author.id)
                continue;
            const mentioned = message.mentions.members?.get(id) ?? guild.members.cache.get(id);
            if (users.has(id) || mentioned?.roles.cache.some(r => roles.has(r.id))) {
                hit = true;
                break;
            }
        }
        if (!hit || !ctx.store.observe(`staff-ping:${message.id}`, guild.id, message.author.id, 'staff_ping', message.id))
            return;
        const results = [];
        const notice = new EmbedBuilder().setColor(Colors.Blurple).setTitle('🔕 Mentions Disabled').setDescription('This user has **@mentions disabled**.\n\nNeed assistance? Please open a ticket in **#support** and provide the reason you’re trying to reach them.').setFooter({ text: 'Midtown • Mention Protection' });
        active();
        try {
            await message.reply({ embeds: [notice], allowedMentions: { parse: [], repliedUser: false } });
            results.push('Public notice sent.');
        }
        catch {
            results.push('Reply failed; check channel permissions.');
        }
        active();
        try {
            await message.delete();
            results.push('Message deleted.');
        }
        catch {
            results.push('Deletion failed; check Manage Messages.');
        }
        active();
        ctx.logs.push(guild.id, new EmbedBuilder().setColor(Colors.Orange).setTitle('Protected mention detected').setDescription(`<@${message.author.id}> in <#${message.channelId}>\n${results.join(' ')}`));
    });
}
