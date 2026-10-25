import { Colors, EmbedBuilder } from 'discord.js';
import { KNOWN_ROLE_BOTS, RULES, WARN_FIRST, WARNING_MEMORY_MS } from '../core.js';
import { developers } from '../bot/developers.js';
const when = (expires) => expires ? `until <t:${Math.floor(Number(expires) / 1000)}:f>` : 'permanent';
/** What anti-nuke lets this person do, where each exemption comes from, and what would still get them punished. */
export function whitelistCheck(store, guild, userId, roleIds, isBot, now = Date.now()) {
    const e = new EmbedBuilder().setTitle('Anti-nuke check').setFooter({ text: `User ID: ${userId}` }).setTimestamp();
    const auto = userId === guild.ownerId ? 'the server owner' : developers.has(userId) ? 'a Ghost Vanguard developer' : userId === guild.client?.user?.id ? 'Ghost Vanguard itself' : null;
    if (auto)
        return e.setColor(Colors.Green).setDescription(userId === guild.client?.user?.id ? `<@${userId}> is **${auto}**. Its own actions count against the staff member who asked for them.` : `<@${userId}> is **${auto}**, so anti-nuke never punishes them. They are still watched: if they hit a limit, you get an alert.`);
    const live = (kind, id = userId) => store.get('SELECT expires FROM grants WHERE guild_id=? AND user_id=? AND kind=? AND (expires IS NULL OR expires>?)', guild.id, id, kind, now);
    const full = live('trust');
    const fullRole = roleIds.find(r => live('trust_role', r));
    if (full || fullRole)
        return e.setColor(Colors.Green).setDescription(`<@${userId}> has a **full bypass** (${full ? when(full.expires) : `from the role <@&${fullRole}>, ${when(live('trust_role', fullRole).expires)}`}). They are never punished, but still watched: if they hit a limit, you get an alert.`);
    const skips = [];
    const checked = [];
    for (const rule of RULES.filter(r => r.key !== 'join_flood')) {
        const own = live(`trust:${rule.key}`);
        const viaRole = !own ? roleIds.find(r => live(`trust_role:${rule.key}`, r)) : undefined;
        if (own)
            skips.push(`✅ **${rule.title}** · ${when(own.expires)}`);
        else if (viaRole)
            skips.push(`✅ **${rule.title}** · from <@&${viaRole}>, ${when(live(`trust_role:${rule.key}`, viaRole).expires)}`);
        else
            checked.push(`• **${rule.title}**: ${rule.count} in ${rule.seconds}s → ${rule.punishment ?? 'strip'}${(rule.key === 'dangerous_grant' || WARN_FIRST.has(rule.key) && !isBot) ? ' (warns first)' : ''}`);
    }
    const roleManager = skips.some(s => s.includes('**Role Invite**')) || skips.some(s => s.includes('**Role Update**'));
    const notes = [];
    if (isBot && (store.get("SELECT 1 FROM grants WHERE guild_id=? AND user_id=? AND kind='bot'", guild.id, userId) || (userId in KNOWN_ROLE_BOTS && !store.get("SELECT 1 FROM grants WHERE guild_id=? AND user_id=? AND kind='bot_denied'", guild.id, userId))))
        notes.push(`🤖 Verification bot${KNOWN_ROLE_BOTS[userId] ? ` (${KNOWN_ROLE_BOTS[userId]})` : ''}: giving ordinary roles is never counted.`);
    if (isBot)
        notes.push('🤖 Bots get no warnings for everyday rules. Dangerous permission grants warn first, except self-assigned Administrator or Manage Server.');
    if (roleManager)
        notes.push('🎭 They can hand out moderator-level roles (Ban, Kick, Manage Channels, Webhooks). Giving **Administrator** or **Manage Server** is checked; self-assigning either strips immediately.');
    const warned = store.get("SELECT at FROM incidents WHERE guild_id=? AND actor_id=? AND mode='warn' AND at>? ORDER BY at DESC LIMIT 1", guild.id, userId, now - WARNING_MEMORY_MS);
    if (warned)
        notes.push(`⚠️ **Warned <t:${Math.floor(Number(warned.at) / 1000)}:R>.** Their next offence before <t:${Math.floor((Number(warned.at) + WARNING_MEMORY_MS) / 1000)}:t> is punished without another warning.`);
    if (store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', guild.id, userId))
        notes.push('🔒 **Quarantined** from an earlier incident: staff roles given to them are removed again. Use the alert\'s **Undo strip** button or `/antinuke release`.');
    return e.setColor(skips.length ? Colors.Blurple : Colors.Greyple)
        .setDescription(`${skips.length ? `<@${userId}> is whitelisted for **${skips.length}** rule(s).` : `<@${userId}> is **not whitelisted**. Anti-nuke checks everything they do.`}${notes.length ? `\n\n${notes.join('\n')}` : ''}`)
        .addFields(...(skips.length ? [{ name: 'Not punished for (still alerted)', value: skips.join('\n').slice(0, 1024) }] : []), { name: 'Still checked', value: checked.join('\n').slice(0, 1024) || 'Nothing.' }, { name: 'Change it', value: '`/antinuke whitelist add` to whitelist them · `/antinuke whitelist remove` to take them off', inline: false });
}
