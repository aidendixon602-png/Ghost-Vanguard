import { Colors } from 'discord.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { developers } from '../bot/developers.js';
import { explicitRank, RANKS } from '../bot/ranks.js';
import { confirmDanger } from '../ui/danger-ui.js';
import { embed } from '../ui/ui.js';
import { activeBan, addException, existingBan, recordId } from './network-ban.js';
import { staffReason } from './raidmode.js';
import { clip } from '../core.js';
/**
 * A genreban keeps someone out of every Midtown server. A server's owner or Head Admin may let that
 * one person back into **their own server only**: the genreban stays in force everywhere else, the
 * developers are told straight away and can cancel it with /network exceptions revoke.
 * Hardbans never have exceptions.
 */
export function canGrantException(store, guild, actor) {
    if (actor.id === guild.ownerId || developers.has(actor.id))
        return true;
    // A Vanguard rank, not Discord's Administrator permission: overriding a network decision is a deliberate grant.
    return explicitRank(store, guild.id, actor.id, actor) >= RANKS.headadmin;
}
export async function tellDevelopers(client, text) {
    if (!client?.users)
        return;
    const targets = new Set([config.ownerId, ...config.supremeExtra, ...config.developers].filter(Boolean));
    for (const id of targets)
        await client.users.fetch(id).then(u => u.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } })).catch(() => undefined);
}
/** /mod unban on someone with an active genreban (and no hardban): offer a this-server-only exception. */
export async function offerGenrebanException(ctx, i, ban, reason) {
    const guild = i.guild;
    if (!canGrantException(ctx.store, guild, ctx.actor))
        throw new AppError('PERMISSION_ERROR', `<@${ban.user_id}> has a Midtown-wide **genreban** (${recordId(ban)}). Only this server's **owner or a Head Admin** can let them back into this server; a developer can lift it everywhere with \`/network ungenreban\`.`);
    await confirmDanger(ctx, i, {
        title: 'Let a genrebanned user back into this server',
        summary: `<@${ban.user_id}> is genrebanned from every Midtown server (**${recordId(ban)}**: ${clip(ban.reason, 200)}).\n**Your reason:** ${clip(reason, 300)}`,
        consequences: [
            'They are unbanned **here only** and may rejoin this server.',
            'The genreban stays in force in every other server.',
            'The bot developers are told straight away and can cancel it.',
            'If they are hardbanned later, the hardban applies here too.',
        ],
        label: 'Allow them here', reversal: 'Ban them again with `/mod ban`, or ask a developer to cancel the exception.',
        run: async (c) => {
            const fresh = activeBan(c.store, 'genreban', ban.user_id);
            if (!fresh)
                throw new AppError('VALIDATION_ERROR', 'The genreban was lifted in the meantime; use `/mod unban` normally.');
            if (activeBan(c.store, 'hardban', ban.user_id))
                throw new AppError('PERMISSION_ERROR', 'They have a hardban now, which has no exceptions.');
            const exception = addException(c.store, fresh, guild, i.user.id, reason);
            const banned = await existingBan(guild, ban.user_id);
            if (banned)
                await guild.members.unban(ban.user_id, staffReason(i.user.id, `genreban exception (${recordId(fresh)}): ${reason}`));
            c.store.recordCase(guild.id, ban.user_id, i.user.id, 'genreban exception', `${recordId(fresh)}: ${reason}`, { username: fresh.username });
            c.logs.push(guild.id, embed('Genreban exception', `<@${i.user.id}> let <@${ban.user_id}> back into **this server only**.\n**Genreban:** ${recordId(fresh)} · ${clip(fresh.reason, 200)}\n**Reason:** ${clip(reason, 300)}\n-# The genreban still applies in every other Midtown server. Developers were notified.`, Colors.Orange));
            await tellDevelopers(c.client, `⚠️ **Genreban exception** in **${guild.name}**: <@${i.user.id}> (\`${i.user.id}\`) let \`${ban.user_id}\` (${fresh.username ?? 'unknown'}) back into that server only.\n**${recordId(fresh)}:** ${clip(fresh.reason, 200)}\n**Their reason:** ${clip(reason, 300)}\nCancel it with \`/network exceptions revoke id:${exception.id}\`.`);
            return `✅ <@${ban.user_id}> may rejoin **this server**${banned ? ' and was unbanned here' : ''}. The genreban (${recordId(fresh)}) still applies everywhere else, and the developers were notified.`;
        },
    });
}
