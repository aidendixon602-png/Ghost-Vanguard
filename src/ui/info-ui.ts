import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Colors, GatewayIntentBits } from 'discord.js';
import { VERSION, config } from '../config.js';
import { overrideRule, RULES } from '../core.js';
import { ProtectionStats } from '../security/protection-stats.js';
import type { CommandContext } from '../bot/registry.js';

const timestamp = (at?: number | null) => at ? `<t:${Math.floor(at / 1000)}:f>` : 'Unavailable';
const channel = (id: string | null) => id ? `<#${id}>` : 'None';

export function serverInfo(ctx: CommandContext, guild: any, user: string, requested = 0) {
    const page = Math.max(0, Math.min(3, requested)), s = ctx.store.settings(guild.id), auth = ctx.store.authorization(guild.id);
    const members = [...guild.members.cache.values()] as any[], complete = members.length >= guild.memberCount;
    const bots = members.filter(m => m.user.bot).length, humans = members.length - bots;
    const channels = [...guild.channels.cache.values()] as any[];
    const count = (types: number[]) => String(channels.filter(c => types.includes(c.type)).length);
    const total = ctx.store.get('SELECT COUNT(*) AS n FROM snapshots WHERE guild_id=?', guild.id)?.n ?? 0;
    const latest = ctx.store.get('SELECT at FROM snapshots WHERE guild_id=? ORDER BY id DESC LIMIT 1', guild.id);
    const titles = ['Overview', 'Channels & assets', 'Server configuration', 'Vanguard protection'];
    const embed = new EmbedBuilder().setTitle(`${guild.name} · ${titles[page]}`).setColor(Colors.Blurple).setFooter({ text: `Ghost Vanguard ${VERSION} · ${page + 1}/4` }).setTimestamp();
    const icon = guild.iconURL?.({ size: 256 });
    if (icon)
        embed.setThumbnail(icon);
    const fields: [string, string][] = page === 0 ? [
        ['Server ID', guild.id], ['Owner', `<@${guild.ownerId}> (${guild.ownerId})`], ['Created', timestamp(guild.createdTimestamp)],
        ['Total members', String(guild.memberCount)], ['Humans', `${humans}${complete ? '' : ' cached · incomplete roster'}`], ['Bots', `${bots}${complete ? '' : ' cached · incomplete roster'}`],
        ['Online members', ctx.client.options?.intents?.has(GatewayIntentBits.GuildPresences) ? `${members.filter(m => m.presence && m.presence.status !== 'offline').length}${complete ? '' : ' cached · incomplete roster'}` : 'Unavailable · presence intent not enabled'],
        ['Boost level', String(guild.premiumTier)], ['Boosts', String(guild.premiumSubscriptionCount ?? 0)]
    ] : page === 1 ? [
        ['Roles', String(guild.roles.cache.size)], ['Total channels', String(channels.length)], ['Text / announcement', count([ChannelType.GuildText, ChannelType.GuildAnnouncement])], ['Voice', count([ChannelType.GuildVoice])], ['Categories', count([ChannelType.GuildCategory])], ['Forum / media', count([ChannelType.GuildForum, ChannelType.GuildMedia])], ['Stage', count([ChannelType.GuildStageVoice])], ['Emojis', String(guild.emojis.cache.size)], ['Stickers', String(guild.stickers.cache.size)], ['Vanity URL', guild.vanityURLCode ? `https://discord.gg/${guild.vanityURLCode}` : 'Unavailable'], ['Banner', guild.bannerURL?.({ size: 1024 }) ?? 'Unavailable'], ['Splash', guild.splashURL?.({ size: 1024 }) ?? 'Unavailable']
    ] : page === 2 ? [
        ['Verification level', String(guild.verificationLevel)], ['Preferred locale', guild.preferredLocale], ['AFK channel', channel(guild.afkChannelId)], ['AFK timeout', `${guild.afkTimeout} seconds`], ['Rules channel', channel(guild.rulesChannelId)], ['System channel', channel(guild.systemChannelId)], ['Community', guild.features.includes('COMMUNITY') ? 'Enabled' : 'Disabled'], ['Explicit content filter', String(guild.explicitContentFilter)]
    ] : [
        ['Vanguard joined', timestamp(guild.members.me?.joinedTimestamp)], ['Authorization', auth?.state ?? 'Pending initialization'], ['Authorization deadline', auth?.state === 'PENDING_AUTHORIZATION' ? timestamp(auth.deadline) : 'Not pending'], ['Authorized by', auth?.authorized_by ? `<@${auth.authorized_by}>` : 'Not authorized'], ['Authorized at', timestamp(auth?.authorized_at)], ['Anti-Nuke', s.authorized && s.enabled ? s.mode : 'Disabled'], ['Enabled rules', String(s.authorized && s.enabled ? RULES.filter(rule => overrideRule(rule, s.rules, s.ruleDefaults).enabled !== false).length : 0)], ['Latest snapshot', timestamp(latest?.at)], ['Saved snapshots / backups', String(total)], ['Vanguard version', VERSION]
    ];
    embed.addFields(fields.map(([name, value]) => ({ name, value: String(value ?? 'Unavailable').slice(0, 1024), inline: true })));
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`serverinfo:${user}:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0), new ButtonBuilder().setCustomId(`serverinfo:${user}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === 3))], allowedMentions: { parse: [] as never[] } };
}

export function botInfo(ctx: CommandContext) {
    const stats = (ctx.stats ?? new ProtectionStats(ctx.client, ctx.store)).get();
    return new EmbedBuilder().setTitle('Ghost Vanguard').setColor(Colors.Blurple).setDescription('Multi-server security, Anti-Nuke detection, moderation, Roblox verification, and recoverable server layouts.')
        .addFields({ name: 'Owner / Developer', value: `<@${config.ownerId}>\nUsername: ${config.ownerUsername}\nUser ID: ${config.ownerId}` }, { name: 'Version', value: VERSION, inline: true }, { name: 'Uptime', value: `${Math.floor(process.uptime() / 3600)}h ${Math.floor(process.uptime() / 60) % 60}m`, inline: true }, { name: 'Guilds protected', value: String(stats.guilds), inline: true }, { name: 'Discord users protected', value: `${stats.users.toLocaleString()} unique${stats.complete ? '' : ' known users · partial roster coverage'}`, inline: true }, { name: 'Roblox users protected / monitored', value: `${stats.robloxUsers.toLocaleString()} distinct stored verified accounts`, inline: true }, { name: 'Registered commands', value: String(ctx.registry.commands.size), inline: true }, { name: 'Current status', value: ctx.client.isReady() ? 'Online' : 'Reconnecting', inline: true }, { name: 'Statistics refreshed', value: timestamp(stats.refreshedAt), inline: true })
        .setThumbnail(ctx.client.user?.displayAvatarURL() ?? null).setFooter({ text: 'Developer identity is the Discord user ID; usernames may change.' }).setTimestamp();
}
