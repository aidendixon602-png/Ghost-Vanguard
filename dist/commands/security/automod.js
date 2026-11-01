import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { embed } from '../../ui/ui.js';
import { AUTOMOD_DEFAULTS, automodConfig, cleanDomain, INVITE_PATTERN, normalizePhrase, SAFE_DOMAINS } from '../../features/automod.js';
import { rankName, rankOf, RANK_LABEL } from '../../bot/ranks.js';
import { config } from '../../config.js';
import { LOCK_SCHEDULE_DEFAULTS, inWindow, lockScheduleConfig, validTime } from '../../features/schedules.js';
import { setFeature } from '../../features/settings.js';
const onOff = (v) => v ? '🟢 on' : '⚪ off';
export default defineCommand(new SlashCommandBuilder().setName('automod').setDescription('Spam guard, invite blocker, alt-account check and scheduled quiet hours')
    .addSubcommand(s => s.setName('status').setDescription('Show what automod is doing in this server'))
    .addSubcommand(s => s.setName('spam').setDescription('Mass pings, repeated messages and message bursts')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))
    .addIntegerOption(o => o.setName('mention_limit').setDescription('People/roles pinged in one message that counts as spam (default 5)').setMinValue(3).setMaxValue(30))
    .addIntegerOption(o => o.setName('timeout_minutes').setDescription('Timeout for spammers and repeat invite posters (default 10)').setMinValue(1).setMaxValue(1440)))
    .addSubcommand(s => s.setName('invites').setDescription('Delete invite links to other Discord servers')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand(s => s.setName('allow-server').setDescription('Allow (or stop allowing) invites to a partner server')
    .addStringOption(o => o.setName('action').setDescription('Add or remove').setRequired(true).addChoices({ name: 'Allow this server', value: 'add' }, { name: 'Stop allowing it', value: 'remove' }))
    .addStringOption(o => o.setName('server').setDescription('An invite link to the server, or its server ID').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('links').setDescription('Choose how links (websites) are handled')
    .addStringOption(o => o.setName('mode').setDescription('Link rule').setRequired(true).addChoices({ name: 'Off: any link is fine', value: 'off' }, { name: 'Block list: remove only sites you block', value: 'blocklist' }, { name: 'Allow list: only sites you allow (strict)', value: 'allowlist' })))
    .addSubcommand(s => s.setName('link-list').setDescription('Add a website to the allowed or blocked list, or remove it')
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true).addChoices({ name: 'Allow this site', value: 'allow' }, { name: 'Block this site', value: 'block' }, { name: 'Remove from both lists', value: 'remove' }))
    .addStringOption(o => o.setName('site').setDescription('The website, e.g. youtube.com (covers its sub-domains too)').setRequired(true).setMaxLength(200)))
    .addSubcommand(s => s.setName('words').setDescription('Turn the blocked phrase filter on or off')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand(s => s.setName('word-list').setDescription('Manage blocked words and phrases')
    .addStringOption(o => o.setName('action').setDescription('Add, remove or list').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }))
    .addStringOption(o => o.setName('phrase').setDescription('Literal word or phrase to filter').setMinLength(1).setMaxLength(80))
    .addIntegerOption(o => o.setName('page').setDescription('Page of results when listing').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('ai').setDescription('AI moderation: catch harassment, hate, threats and NSFW text and images')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('What happens to flagged messages (default: report only)').addChoices({ name: 'Report only: staff decide', value: 'report' }, { name: 'Delete clear-cut cases, report the rest', value: 'delete' }, { name: 'Strict: delete + 1h timeout for the worst', value: 'strict' }))
    .addStringOption(o => o.setName('sensitivity').setDescription('How much it flags (default: normal)').addChoices({ name: 'Low: only obvious cases', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High: also borderline messages', value: 'high' }))
    .addBooleanOption(o => o.setName('images').setDescription('Also check images (default on)')))
    .addSubcommand(s => s.setName('ai-ignore').setDescription('Channels or kinds of content AI moderation should skip')
    .addStringOption(o => o.setName('action').setDescription('Add or remove').setRequired(true).addChoices({ name: 'Ignore', value: 'add' }, { name: 'Stop ignoring', value: 'remove' }))
    .addChannelOption(o => o.setName('channel').setDescription('A channel or category to skip (e.g. a mature/banter channel)'))
    .addStringOption(o => o.setName('kind').setDescription('A kind of content to skip').addChoices({ name: 'Harassment / insults', value: 'harassment' }, { name: 'Hate speech', value: 'hate' }, { name: 'Violence', value: 'violence' }, { name: 'Sexual content (adults)', value: 'sexual' }, { name: 'Illegal activity', value: 'illicit' })))
    .addSubcommand(s => s.setName('alts').setDescription('Alert staff when a new member\'s Roblox account belongs to a banned or existing member')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand(s => s.setName('quiet-hours').setDescription('Lock the server every day between two times, then unlock it')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))
    .addStringOption(o => o.setName('start').setDescription('Lock at, 24-hour HH:MM (e.g. 23:00)').setMinLength(5).setMaxLength(5))
    .addStringOption(o => o.setName('end').setDescription('Unlock at, 24-hour HH:MM (e.g. 07:00)').setMinLength(5).setMaxLength(5))
    .addNumberOption(o => o.setName('utc_offset').setDescription('Your time zone vs UTC, e.g. -5 for New York winter, 0 for London winter').setMinValue(-12).setMaxValue(14))), { category: 'security', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'status') {
        const a = automodConfig(ctx.store, guild), q = lockScheduleConfig(ctx.store, guild);
        const me = await i.guild.members.fetchMe();
        const missing = [[PermissionFlagsBits.ManageMessages, 'Manage Messages'], [PermissionFlagsBits.ModerateMembers, 'Timeout Members']].filter(([p]) => !me.permissions.has(p)).map(([, n]) => n);
        const servers = Object.entries(a.allowedServers);
        const myRank = rankOf(ctx.store, guild, i.user.id, ctx.actor);
        const whyExempt = i.user.id === i.guild.ownerId ? 'you own this server' : myRank ? `you are ${RANK_LABEL[rankName(myRank)]}` : ctx.actor?.permissions.has(PermissionFlagsBits.ManageMessages) ? 'you have Manage Messages' : null;
        return [
            `**Spam guard:** ${onOff(a.spam)} · ${a.mentionLimit}+ pings in one message, 6 messages in 5s, or the same message 4 times in 30s → messages deleted + ${a.timeoutMinutes} min timeout`,
            `**Invite blocker:** ${onOff(a.invites)} · other servers' invites are deleted; 3 strikes in 10 min → timeout`,
            `**Allowed partner servers:** ${servers.length ? servers.map(([id, name]) => `${name} (\`${id}\`)`).join(', ') : 'none'}`,
            `**Links:** ${a.links === 'off' ? '⚪ off (any link is fine)' : a.links === 'blocklist' ? '🟢 block list' : '🟢 allow list (strict)'}`,
            `**Allowed sites:** ${a.allowedDomains.join(', ') || 'none'}`,
            `**Blocked sites:** ${a.blockedDomains.join(', ') || 'none'}`,
            `**Blocked phrases:** ${onOff(a.wordsEnabled)} · ${a.blockedWords.length} configured`,
            `**Alt-account check:** ${onOff(a.alts)} · needs RoVer or Bloxlink set up`,
            `**AI moderation:** ${onOff(a.ai)} · ${a.aiMode} · sensitivity ${a.aiSensitivity} · images ${a.aiImages ? 'on' : 'off'}${a.aiIgnoreChannels.length ? ` · skips ${a.aiIgnoreChannels.map(c => `<#${c}>`).join(' ')}` : ''}${a.aiIgnoreCategories.length ? ` · ignores ${a.aiIgnoreCategories.join(', ')}` : ''}${a.ai && !config.openaiKey ? ' · ⚠ OPENAI_API_KEY is missing' : ''}`,
            `**Quiet hours:** ${onOff(q.enabled)}${q.enabled ? ` · ${q.start} → ${q.end} (UTC${q.utcOffset >= 0 ? '+' : ''}${q.utcOffset})${inWindow(q) ? ' · **active now**' : ''}` : ''}`,
            '',
            missing.length ? `⚠ **Vanguard is missing ${missing.join(' and ')}**, so it cannot delete messages or time people out. Give its role these permissions.` : '✅ Vanguard has the permissions it needs.',
            config.messageContentEnabled ? '' : '⚠ **Message Content is turned off** (MESSAGE_CONTENT_ENABLED=false), so automod cannot read messages.',
            whyExempt ? `ℹ️ **Automod ignores you** because ${whyExempt}. Staff, whitelisted users and the owner are never touched, so test with a normal account.` : '',
        ].filter(Boolean).join('\n');
    }
    if (sub === 'allow-server') {
        const action = i.options.getString('action', true), raw = i.options.getString('server', true).trim();
        const a = automodConfig(ctx.store, guild);
        let id = /^\d{17,20}$/.test(raw) ? raw : null, name = id ? (a.allowedServers[id] ?? `Server ${id}`) : '';
        if (!id) {
            const code = [...raw.matchAll(INVITE_PATTERN)][0]?.[1] ?? (/^[a-z0-9-]{2,32}$/i.test(raw) ? raw : null);
            const invite = code ? await i.client.fetchInvite(code).catch(() => null) : null;
            if (!invite?.guild)
                throw new AppError('VALIDATION_ERROR', 'That invite is invalid or expired. Paste a working invite link, or the server ID.');
            id = invite.guild.id;
            name = invite.guild.name;
        }
        if (id === guild)
            throw new AppError('VALIDATION_ERROR', 'Invites to this server are always allowed.');
        const next = { ...a.allowedServers };
        if (action === 'add')
            next[id] = name.slice(0, 100);
        else if (next[id])
            delete next[id];
        else
            throw new AppError('VALIDATION_ERROR', 'That server is not on the allowed list.');
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { allowedServers: next }, i.user.id);
        ctx.logs.push(guild, embed('Automod · partner servers changed', `By <@${i.user.id}> · ${action === 'add' ? 'allowed' : 'removed'} **${name}** (\`${id}\`)`, Colors.Orange));
        return action === 'add' ? `Invites to **${name}** are now allowed.` : `Invites to **${name}** are blocked again.`;
    }
    if (sub === 'links') {
        const mode = i.options.getString('mode', true), a = automodConfig(ctx.store, guild);
        // First switch to strict mode: start from common safe sites so normal chat keeps working.
        const allowed = mode === 'allowlist' && !a.allowedDomains.length ? [...SAFE_DOMAINS] : a.allowedDomains;
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { links: mode, allowedDomains: allowed }, i.user.id);
        ctx.logs.push(guild, embed('Automod · link rule changed', `By <@${i.user.id}> · ${mode}`, Colors.Orange));
        return mode === 'off' ? 'Links: **off**. Any website can be posted (other servers\' invites are still handled by the invite blocker).'
            : mode === 'blocklist' ? `Links: **block list**. Only sites you block are removed. Blocked now: ${a.blockedDomains.join(', ') || 'none yet'}. Add one with \`/automod link-list action:Block site:example.com\`.`
                : `Links: **allow list**. Only these sites can be posted: ${allowed.join(', ')}.\nAdd more with \`/automod link-list action:Allow site:example.com\`.`;
    }
    if (sub === 'link-list') {
        const action = i.options.getString('action', true), domain = cleanDomain(i.options.getString('site', true));
        if (!domain)
            throw new AppError('VALIDATION_ERROR', 'That is not a website. Use something like youtube.com.');
        const a = automodConfig(ctx.store, guild);
        const allowed = a.allowedDomains.filter(d => d !== domain), blocked = a.blockedDomains.filter(d => d !== domain);
        if (action === 'allow')
            allowed.push(domain);
        else if (action === 'block')
            blocked.push(domain);
        else if (allowed.length === a.allowedDomains.length && blocked.length === a.blockedDomains.length)
            throw new AppError('VALIDATION_ERROR', `${domain} is not on either list.`);
        if (allowed.length > 100 || blocked.length > 100)
            throw new AppError('VALIDATION_ERROR', 'Each list holds up to 100 sites.');
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { allowedDomains: allowed, blockedDomains: blocked }, i.user.id);
        ctx.logs.push(guild, embed('Automod · link list changed', `By <@${i.user.id}> · ${action} **${domain}**`, Colors.Orange));
        const modeNote = a.links === 'off' ? '\n-# Links are off right now; turn the rule on with `/automod links`.' : '';
        return `${action === 'allow' ? `**${domain}** is allowed` : action === 'block' ? `**${domain}** is blocked` : `**${domain}** was removed from the lists`} (sub-domains included).${modeNote}`;
    }
    if (sub === 'words') {
        const enabled = i.options.getBoolean('enabled', true);
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { wordsEnabled: enabled }, i.user.id);
        ctx.logs.push(guild, embed('Automod · phrase filter changed', `By <@${i.user.id}> · ${enabled ? 'on' : 'off'}`, Colors.Orange));
        const note = enabled && !config.messageContentEnabled
            ? '\n⚠ Message Content is disabled for this bot. The phrase filter cannot read ordinary server messages.' : '';
        return `Blocked phrase filter is **${enabled ? 'on' : 'off'}**. Configure phrases with \`/automod word-list\`.${note}`;
    }
    if (sub === 'word-list') {
        const action = i.options.getString('action', true), existing = automodConfig(ctx.store, guild).blockedWords;
        if (action === 'list') {
            const page = i.options.getInteger('page') ?? 1;
            const items = existing.slice((page - 1) * 10, page * 10).map(p => `• ${p.replaceAll('@', '＠').replace(/[`*_~|\\]/g, '\\$&')}`);
            return `**Blocked phrases · page ${page}**\n${items.join('\n') || 'None on this page.'}`;
        }
        const raw = i.options.getString('phrase');
        if (!raw)
            throw new AppError('VALIDATION_ERROR', 'Enter a phrase to add or remove.');
        const phrase = normalizePhrase(raw);
        if (phrase.length > 80 || !/[\p{L}\p{N}]/u.test(phrase))
            throw new AppError('VALIDATION_ERROR', 'Enter a word or phrase containing letters or numbers (up to 80 characters).');
        const already = existing.includes(phrase);
        if (action === 'add' && already)
            throw new AppError('VALIDATION_ERROR', 'That phrase is already blocked.');
        if (action === 'remove' && !already)
            throw new AppError('VALIDATION_ERROR', 'That phrase is not on the list.');
        const phrases = action === 'add' ? [...existing, phrase] : existing.filter(p => p !== phrase);
        if (phrases.length > 100)
            throw new AppError('VALIDATION_ERROR', 'The list holds up to 100 phrases.');
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { blockedWords: phrases }, i.user.id);
        ctx.logs.push(guild, embed('Automod · phrase list changed', `By <@${i.user.id}> · ${action === 'add' ? 'added' : 'removed'} a phrase`, Colors.Orange));
        return `Phrase ${action === 'add' ? 'added to' : 'removed from'} the blocked list (${phrases.length}/100).`;
    }
    if (sub === 'ai-ignore') {
        const add = i.options.getString('action', true) === 'add', channel = i.options.getChannel('channel'), kind = i.options.getString('kind');
        if (!channel && !kind)
            throw new AppError('VALIDATION_ERROR', 'Pick a channel or a kind of content.');
        const a = automodConfig(ctx.store, guild);
        const chans = channel ? (add ? [...new Set([...a.aiIgnoreChannels, channel.id])] : a.aiIgnoreChannels.filter(c => c !== channel.id)) : a.aiIgnoreChannels;
        const kinds = kind ? (add ? [...new Set([...a.aiIgnoreCategories, kind])] : a.aiIgnoreCategories.filter(c => c !== kind)) : a.aiIgnoreCategories;
        setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, { aiIgnoreChannels: chans.slice(0, 50), aiIgnoreCategories: kinds }, i.user.id);
        return `AI moderation now skips: channels ${chans.map(c => `<#${c}>`).join(', ') || 'none'} · kinds ${kinds.join(', ') || 'none'}.\n-# Sexual content involving minors is always flagged.`;
    }
    const enabled = i.options.getBoolean('enabled', true);
    if (sub === 'quiet-hours') {
        const current = lockScheduleConfig(ctx.store, guild);
        const start = i.options.getString('start') ?? current.start, end = i.options.getString('end') ?? current.end;
        if (!validTime(start) || !validTime(end))
            throw new AppError('VALIDATION_ERROR', 'Times must be 24-hour HH:MM, like 23:00 or 07:30.');
        if (enabled && start === end)
            throw new AppError('VALIDATION_ERROR', 'Start and end cannot be the same time.');
        const next = setFeature(ctx.store, guild, 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { enabled, start, end, utcOffset: i.options.getNumber('utc_offset') ?? current.utcOffset }, i.user.id);
        ctx.logs.push(guild, embed('Quiet hours changed', `By <@${i.user.id}> · ${enabled ? `${next.start} → ${next.end} (UTC${next.utcOffset >= 0 ? '+' : ''}${next.utcOffset})` : 'off'}`, Colors.Orange));
        return enabled
            ? `Quiet hours **on**: the server locks every day at **${next.start}** and unlocks at **${next.end}** (UTC${next.utcOffset >= 0 ? '+' : ''}${next.utcOffset}). It works like \`/raid lockdown\`: staff keep access, and \`/raid unlock\` ends it early.`
            : 'Quiet hours **off**. If a scheduled lock is running now, it is lifted within a minute.';
    }
    const change = sub === 'spam' ? { spam: enabled, mentionLimit: i.options.getInteger('mention_limit') ?? automodConfig(ctx.store, guild).mentionLimit, timeoutMinutes: i.options.getInteger('timeout_minutes') ?? automodConfig(ctx.store, guild).timeoutMinutes }
        : sub === 'invites' ? { invites: enabled } : sub === 'ai' ? { ai: enabled, aiMode: i.options.getString('mode') ?? automodConfig(ctx.store, guild).aiMode, aiSensitivity: i.options.getString('sensitivity') ?? automodConfig(ctx.store, guild).aiSensitivity, aiImages: i.options.getBoolean('images') ?? automodConfig(ctx.store, guild).aiImages } : { alts: enabled };
    if (sub === 'ai' && enabled && !config.openaiKey)
        throw new AppError('VALIDATION_ERROR', 'AI moderation needs OPENAI_API_KEY in .env. Add the key, restart the bot, then turn this on.');
    setFeature(ctx.store, guild, 'automod', AUTOMOD_DEFAULTS, change, i.user.id);
    const name = sub === 'spam' ? 'Spam guard' : sub === 'invites' ? 'Invite blocker' : sub === 'ai' ? 'AI moderation' : 'Alt-account check';
    if (sub === 'ai')
        ctx.logs.push(guild, embed(`Automod · AI moderation ${enabled ? 'on' : 'off'}`, `By <@${i.user.id}>`, Colors.Orange));
    if (sub === 'ai') {
        const a = automodConfig(ctx.store, guild);
        const mode = a.aiMode === 'report' ? 'report only: staff decide' : a.aiMode === 'delete' ? 'clear-cut messages deleted, the rest reported' : 'strict: deleted, worst cases also get a 1h timeout';
        return enabled ? `**AI moderation is on.** Mode: **${mode}** · sensitivity **${a.aiSensitivity}** · images **${a.aiImages ? 'checked' : 'not checked'}**.\nAlerts go to the security log with Warn / Timeout / Not a problem buttons. Self-harm messages are never punished; staff get a gentle alert instead.\n-# Messages are sent to OpenAI to be checked. Mention this in your rules.` : 'AI moderation is **off**.';
    }
    ctx.logs.push(guild, embed(`Automod · ${name} ${enabled ? 'on' : 'off'}`, `By <@${i.user.id}>`, Colors.Orange));
    return `${name} is now **${enabled ? 'on' : 'off'}**.`;
}, { subcommands: { status: { responseKind: 'info' } } });
