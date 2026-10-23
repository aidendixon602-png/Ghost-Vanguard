import { ChannelType, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { scamConfig, ScamProtection } from '../../security/scam.js';
import { domain, downloadImage, fingerprint } from '../../security/scam-matching.js';
import { config } from '../../config.js';
import { clip } from '../../core.js';
import { randomUUID } from 'node:crypto';
import { Colors } from 'discord.js';
import { embed } from '../../ui/ui.js';

let testScans = 0;

export default defineCommand(new SlashCommandBuilder().setName('scam').setDescription('Scam protection: blocked links and images, testing, exclusions and status')
    .addSubcommand(s => s.setName('status').setDescription('Show automatic protection, scan limits and readiness'))
    .addSubcommand(s => s.setName('test').setDescription('Check text or an image without deletion, bans or AI requests')
        .addStringOption(o => o.setName('text').setDescription('Text or links to check').setMaxLength(2000))
        .addAttachmentOption(o => o.setName('image').setDescription('Static PNG, JPEG or WebP up to 8 MiB')))
    .addSubcommand(s => s.setName('enable').setDescription('Enable deletion and bans for confirmed scam matches'))
    .addSubcommand(s => s.setName('disable').setDescription('Stop scam scanning in this server'))
    .addSubcommand(s => s.setName('domain-add').setDescription('Block a domain and its subdomains; matches delete and ban')
        .addStringOption(o => o.setName('domain').setDescription('Domain only, without https:// or path').setRequired(true).setMaxLength(253)))
    .addSubcommand(s => s.setName('domain-remove').setDescription('Remove a blocked domain')
        .addStringOption(o => o.setName('domain').setDescription('Previously blocked domain').setRequired(true).setMaxLength(253)))
    .addSubcommand(s => s.setName('image-add').setDescription('Register a confirmed scam image; exact matches delete and ban')
        .addAttachmentOption(o => o.setName('image').setDescription('Static PNG, JPEG or WebP up to 8 MiB').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Reference name').setRequired(true).setMaxLength(80)))
    .addSubcommand(s => s.setName('image-remove').setDescription('Remove a custom image reference')
        .addStringOption(o => o.setName('id').setDescription('Reference ID shown by /automod scam list').setRequired(true).setMaxLength(50)))
    .addSubcommand(s => s.setName('list').setDescription('List blocked domains, image references and excluded channels')
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('exclude').setDescription('Exclude or include a channel and its threads')
        .addChannelOption(o => o.setName('channel').setDescription('Reporting or staff channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum))
        .addBooleanOption(o => o.setName('excluded').setDescription('True to exclude; false to scan').setRequired(true)))
    .addSubcommand(s => s.setName('vision').setDescription('Opt in to sending images to OpenAI for text scanning; alerts only')
        .addBooleanOption(o => o.setName('enabled').setDescription('Use configured AI key/model; API costs apply').setRequired(true))),
    { category: 'security', access: 'security', requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
        const guild = i.guildId, sub = i.options.getSubcommand(), before = scamConfig(ctx.store, guild);
        const scanner = new ScamProtection(ctx.store, ctx.logs);
        if (sub === 'test') {
            const text = i.options.getString('text') ?? '', image = i.options.getAttachment('image');
            if (!text.trim() && !image) throw new AppError('VALIDATION_ERROR', 'Provide text or one image to test.');
            if (testScans >= 2) throw new AppError('RATE_LIMIT_ERROR', 'Two image/text tests are running. Try again shortly.');
            testScans++;
            try {
                const result = await scanner.assess(guild, text, image ? [{id:image.id,url:image.url,size:image.size}] : [], () => ctx.store.isAuthorized(guild));
                ctx.assertActive();
                return `**Scam test • no actions taken**\n**Match:** ${result.confirmed ? 'Confirmed reference/domain' : result.reason ? 'Staff review' : result.warnings.length ? 'Incomplete scan' : 'No configured match'}\n**Reason:** ${clip(result.reason || 'No configured match found; this is not a guarantee that the content is safe.', 800)}\n${result.warnings.join('\n')}\nLive confirmed matches delete and ban only when protection is ready, the channel is included and permissions/hierarchy allow. Review matches alert only. No messages were deleted, users banned, incidents stored or AI requests sent.`;
            } finally { testScans--; }
        }
        if (sub === 'status') {
            const me = await i.guild.members.fetchMe();
            const missing = [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers].filter(p => !me.permissions.has(p));
            return `**Scam protection:** ${before.enabled ? 'Automatic • enabled' : 'Explicitly disabled'}\n**Message Content intent:** ${ctx.client.options.intents.has(GatewayIntentBits.MessageContent) ? 'Requested' : 'Off; enable in Developer Portal, set MESSAGE_CONTENT_ENABLED=true, restart'}\n**Missing bot permissions:** ${missing.length ? 'Manage Messages and/or Ban Members' : 'None at server level; channel overrides still apply'}\n**Security log:** ${ctx.store.settings(guild).logChannelId ? `<#${ctx.store.settings(guild).logChannelId}>` : 'Automatic setup creates a private log if Manage Channels is available'}\n**AI image text:** ${before.vision ? 'Opted in; configured AI provider required' : 'Off'}\nExact image/domain → delete + ban. Similar image/text → review alert. Four images per post, 8 MiB each, 8 megapixels; PNG/JPEG/WebP only. Bots/webhooks are skipped. Bot role must be above the sender.`;
        }
        if (sub === 'list') {
            const domains = ctx.store.all('SELECT domain FROM scam_domains WHERE guild_id=? ORDER BY domain', guild);
            const refs = await scanner.references(guild);
            const exclusions = ctx.store.all('SELECT channel_id FROM scam_exclusions WHERE guild_id=?', guild);
            const rows = [...domains.map(r => `Domain: ${r.domain}`), ...refs.map(r => `Image: ${r.id} • ${r.name}`), ...exclusions.map(r => `Excluded: <#${r.channel_id}>`)];
            const pages = Math.max(1, Math.ceil(rows.length / 10)), page = Math.min(i.options.getInteger('page') ?? 1, pages);
            return `**Scam references • page ${page}/${pages}**\n${rows.slice((page - 1) * 10, page * 10).join('\n') || 'None'}`;
        }
        ctx.assertActive();
        if (sub === 'enable') {
            if (!ctx.client.options.intents.has(GatewayIntentBits.MessageContent)) throw new AppError('VALIDATION_ERROR', 'Enable Message Content Intent in Discord Developer Portal → Bot, set MESSAGE_CONTENT_ENABLED=true in .env or Wispbyte variables, then restart.');
            const me = await i.guild.members.fetchMe();
            if (!me.permissions.has([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers])) throw new AppError('PERMISSION_ERROR', 'The bot needs Manage Messages and Ban Members. Place its role above members it should ban.');
            ctx.assertActive();
        }
        let result = '';
        if (sub === 'enable' || sub === 'disable' || sub === 'vision') {
            const vision = sub === 'vision' ? i.options.getBoolean('enabled', true) : !!before.vision;
            if (sub === 'vision' && vision && (!config.aiEnabled || !config.openaiKey)) throw new AppError('VALIDATION_ERROR', 'Configure AI_ENABLED=true, OPENAI_API_KEY and an image-capable OPENAI_MODEL, then restart. Vision sends scanned images to OpenAI and can incur API costs; results only alert staff.');
            ctx.store.run('INSERT INTO scam_config(guild_id,enabled,vision) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,vision=excluded.vision', guild, sub === 'enable' ? 1 : sub === 'disable' ? 0 : Number(before.enabled), Number(vision));
            result = sub === 'vision' ? `AI image text scanning ${vision ? 'enabled (images sent to OpenAI; review alerts only)' : 'disabled'}.` : `Scam protection ${sub === 'enable' ? 'enabled. Exact known images and blocked domains will be deleted and their senders banned when permissions allow. Exclude reporting channels with /automod scam exclude.' : 'disabled'}.`;
            if (sub === 'enable') {
                const ready = await scanner.initialize(i.guild);
                result = ready ? 'Automatic scam protection is ready. Reporting exclusions are retained.' : 'Scam protection enabled, but automatic setup is paused. Check startup logs and /automod scam status for missing permissions or log access.';
            }
        } else if (sub.startsWith('domain-')) {
            let value: string;
            try { value = domain(i.options.getString('domain', true)); } catch (e: any) { throw new AppError('VALIDATION_ERROR', e.message); }
            if (sub === 'domain-add') {
                if (ctx.store.all('SELECT 1 FROM scam_domains WHERE guild_id=?', guild).length >= 20) throw new AppError('VALIDATION_ERROR', 'Maximum 20 domains per server.');
                ctx.store.run('INSERT OR IGNORE INTO scam_domains VALUES(?,?)', guild, value);
            } else ctx.store.run('DELETE FROM scam_domains WHERE guild_id=? AND domain=?', guild, value);
            result = `Domain ${sub === 'domain-add' ? 'blocked' : 'removed'}: ${value}.`;
        } else if (sub === 'image-add') {
            if (ctx.store.all('SELECT 1 FROM scam_images WHERE guild_id=?', guild).length >= 20) throw new AppError('VALIDATION_ERROR', 'Maximum 20 custom images per server.');
            const a = i.options.getAttachment('image', true);
            let fp;
            try { fp = await fingerprint(await downloadImage(a.url, a.size)); } catch (e: any) { throw new AppError('VALIDATION_ERROR', e.message); }
            ctx.assertActive();
            const id = randomUUID().slice(0, 8), name = i.options.getString('name', true);
            ctx.store.run('INSERT INTO scam_images VALUES(?,?,?,?)', guild, id, name, JSON.stringify(fp));
            result = `Registered ${id} • ${name}. Exact copies trigger deletion + ban; similar copies alert staff.`;
        } else if (sub === 'image-remove') {
            const id = i.options.getString('id', true);
            if (id.startsWith('seed-')) throw new AppError('VALIDATION_ERROR', 'Built-in references cannot be removed; exclude a reporting channel or disable scam protection.');
            ctx.store.run('DELETE FROM scam_images WHERE guild_id=? AND id=?', guild, id);
            result = `Custom reference removed: ${id}.`;
        } else if (sub === 'exclude') {
            const channel = i.options.getChannel('channel', true), value = i.options.getBoolean('excluded', true);
            if (value) {
                if (ctx.store.all('SELECT 1 FROM scam_exclusions WHERE guild_id=?', guild).length >= 20) throw new AppError('VALIDATION_ERROR', 'Maximum 20 excluded channels per server.');
                ctx.store.run('INSERT OR IGNORE INTO scam_exclusions VALUES(?,?)', guild, channel.id);
            } else ctx.store.run('DELETE FROM scam_exclusions WHERE guild_id=? AND channel_id=?', guild, channel.id);
            result = `<#${channel.id}> and its threads ${value ? 'excluded from' : 'included in'} scam scanning.`;
        }
        ctx.store.history(guild, `scam/${sub}`, before, { detail: result }, i.user.id);
        ctx.logs.push(guild, embed('Scam protection changed', `By <@${i.user.id}> · ${clip(result, 900)}`, sub === 'disable' ? Colors.Red : Colors.Orange));
        return result;
    }, { subcommands: { status: { requiredPermissions: [], responseKind: 'info' }, list: { requiredPermissions: [], responseKind: 'info' }, test: { requiredPermissions: [], responseKind: 'info', cooldown: 5000 } } });
