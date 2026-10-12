import { SlashCommandBuilder } from 'discord.js';
import { VERSION } from '../../config.js';
import { defineCommand } from '../../bot/registry.js';
const date = (ms) => ms ? `<t:${Math.floor(ms / 1000)}:f>` : 'Not recorded';
export default defineCommand(new SlashCommandBuilder().setName('serverauth').setDescription('Developer: show this server\'s authorization details'), { responseKind: 'info', category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const r = ctx.store.authorization(i.guildId);
    const s = ctx.store.settings(i.guildId);
    return `**Server:** ${i.guild.name}\n**Guild ID:** ${i.guildId}\n**Status:** ${r?.state ?? 'Not initialized'}\n**Authorized by:** ${r?.authorized_by ?? 'Nobody'}\n**Authorized:** ${date(r?.authorized_at)}\n**Bot joined:** ${date(r?.joined_at)}\n**Deadline:** ${date(r?.deadline)}\n**Revoked by:** ${r?.removed_by ?? 'Nobody'}\n**Revoked:** ${date(r?.removed_at)}\n**Anti-nuke:** ${s.enabled && s.authorized ? s.mode : 'disabled'}\n**Database:** ${ctx.store.get('PRAGMA quick_check')?.quick_check}\n**Version:** ${VERSION}`;
});
