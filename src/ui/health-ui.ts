import { Colors, GatewayIntentBits, PermissionFlagsBits, type Guild } from 'discord.js';
import type { CommandContext } from '../bot/registry.js';
import { config, VERSION } from '../config.js';
import { readiness } from '../security/readiness.js';
import { scamConfig, excluded } from '../security/scam.js';
import { embed } from './ui.js';

export function healthPanel(ctx: CommandContext, guild: Guild, channelId: string, parentId?: string | null) {
    const s=ctx.store.settings(guild.id), ready=readiness(guild,s.logChannelId,ctx.store), scam=scamConfig(ctx.store,guild.id);
    const intent=ctx.client.options.intents.has(GatewayIntentBits.MessageContent);
    const scamPermissions=guild.members.me?.permissions.has([PermissionFlagsBits.ManageMessages,PermissionFlagsBits.BanMembers]);
    const channel=guild.channels.cache.get(channelId), me=guild.members.me;
    const log=guild.channels.cache.get(s.logChannelId??'');
    const logReady=!!me&&!!log&&'permissionsFor' in log&&!!log.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]);
    const channelReady=!!me&&!!channel&&'permissionsFor' in channel&&!!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages]);
    const omitted=excluded(ctx.store,guild.id,channelId,parentId), exclusions=ctx.store.all('SELECT channel_id FROM scam_exclusions WHERE guild_id=?',guild.id);
    const lines=[`**Vanguard ${VERSION}** • uptime ${Math.floor(process.uptime()/60)} minutes`,
        `**Anti-nuke:** ${s.enabled?s.mode==='enforce'?'enabled • enforcing':'enabled • observe only':'disabled'} • ${ready.missing.length||ready.above.length?'needs attention':'ready'}`,
        ready.text,
        `**Scam scanning:** ${!scam.enabled?'explicitly disabled':!intent||!scamPermissions||!logReady?'paused • check intent, permissions and log access':'configured • basic prerequisites ready'}`,
        `**This channel:** ${omitted?'excluded (including parent exclusion)':channelReady?'included • deletion permission ready':'included • missing view/delete permission'}`,
        `**Reporting channels:** ${exclusions.length?exclusions.slice(0,8).map(r=>`<#${r.channel_id}>`).join(', '):'none excluded • use /automod scam exclude for evidence channels'}`,
        `**AI image text:** ${!scam.vision?'not opted in':!config.aiEnabled||!config.openaiKey?'opted in • AI settings/key missing':`configured • model ${config.openaiModel} • not tested here`}`,
    ];
    for(const provider of ['rover','bloxlink'] as const) {
        const state=ctx.roblox.providerStatus(guild.id,provider), seen=state.observed;
        lines.push(`**${provider==='rover'?'RoVer':'Bloxlink'}:** ${!state.enabled?'disabled/key missing':seen?`${seen.ok?'last request responded':'last request failed'} <t:${Math.floor(seen.at/1000)}:R> • ${seen.detail}`:'configured • no request observed since restart'}${state.enabled&&state.pausedUntil>Date.now()?` • paused until <t:${Math.floor(state.pausedUntil/1000)}:T>`:''}`);
    }
    const backup=ctx.store.get('SELECT last_backup FROM guild_data WHERE guild_id=?',guild.id)?.last_backup;
    const latest=ctx.store.get('SELECT COUNT(*) AS n FROM outbox WHERE guild_id=? AND attempts>=8',guild.id)?.n??0;
    lines.push(`**Verified database backup:** ${backup?`<t:${Math.floor(backup/1000)}:R>`:'none recorded'}`,`**Security log delivery:** ${latest} messages exhausted retries • /setup status`,
        'Read-only status. Provider results describe observed requests; configuration alone does not prove authentication. Message Content must also be enabled in the Developer Portal.');
    return embed('Vanguard Health',lines.join('\n\n').slice(0,3900),ready.missing.length||ready.above.length||!s.enabled?Colors.Orange:Colors.Green);
}
