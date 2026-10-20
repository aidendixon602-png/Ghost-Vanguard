import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { embed } from '../../ui/ui.js';
import { createPending, confirmPending, getLink, getPending, clearPending, PENDING_TTL_MS } from '../../integrations/custom-verification.js';
export default defineCommand(new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Roblox account and get your verified role')
    .addStringOption(o => o.setName('username').setDescription('Your exact Roblox username (not display name)').setMinLength(3).setMaxLength(20).setRequired(false))
    .addUserOption(o => o.setName('user').setDescription('Staff: check or unlink another member').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('Staff action').addChoices({ name: 'Check link', value: 'check' }, { name: 'Unlink', value: 'unlink' }).setRequired(false)), { category: 'verification', cooldown: 5000, access: 'member', botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageNicknames] }, async (ctx, i) => {
    const guildId = i.guildId;
    const actor = ctx.actor;
    const targetUser = i.options.getUser('user') ?? i.user;
    const action = i.options.getString('action');
    const username = i.options.getString('username')?.trim();
    // Staff check/unlink another member
    if (i.options.getUser('user')) {
        const isStaff = ctx.store.get('SELECT 1 FROM staff_roles WHERE guild_id=? AND role_id IN (SELECT role_id FROM staff_roles)', guildId); // fallback check via rank
        // Use rank check instead: allow helper+ to check, owner/headadmin+ to unlink
        const { rankOf } = await import('../../bot/ranks.js');
        const myRank = rankOf(ctx.store, guildId, i.user.id, actor);
        if (action === 'unlink') {
            if (myRank < 3)
                throw new (await import('../../errors.js')).AppError('PERMISSION_ERROR', 'You need Head Admin or higher to unlink another member.');
            const link = getLink(ctx.store, guildId, targetUser.id);
            if (!link)
                return `No linked Roblox account for <@${targetUser.id}>.`;
            ctx.store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', guildId, targetUser.id);
            clearPending(ctx.store, guildId, targetUser.id);
            try {
                const m = await i.guild.members.fetch(targetUser.id);
                const vr = ctx.store.settings(guildId).verifiedRoleId;
                if (vr && m.roles.cache.has(vr))
                    await m.roles.remove(vr, 'Manual unlink');
            }
            catch { }
            return `Unlinked <@${targetUser.id}> from **${link.username}** (${link.roblox_id}).`;
        }
        // check
        const link = getLink(ctx.store, guildId, targetUser.id);
        const pending = getPending(ctx.store, guildId, targetUser.id);
        if (link)
            return `<@${targetUser.id}> is linked as **${link.username}** (\`${link.roblox_id}\`).`;
        if (pending)
            return `<@${targetUser.id}> has pending verification for **${pending.roblox_name}** (\`${pending.roblox_id}\`) with code \`${pending.code}\` — expires <t:${Math.floor((pending.created_at + PENDING_TTL_MS) / 1000)}:R>.`;
        return `No link or pending verification for <@${targetUser.id}>.`;
    }
    const s = ctx.store.settings(guildId);
    // No username provided → try to confirm pending, else sync existing link, else help
    if (!username) {
        const pending = getPending(ctx.store, guildId, i.user.id);
        const link = getLink(ctx.store, guildId, i.user.id);
        if (pending) {
            // Attempt confirm
            try {
                const ok = await confirmPending(ctx.store, guildId, i.user.id);
                // Write link
                const { linkAccount } = await import('../../integrations/custom-verification.js');
                linkAccount(ctx.store, guildId, i.user.id, ok.roblox_id, ok.roblox_name);
                // Now run full sync (roles, nickname, group)
                return await ctx.roblox.sync(actor);
            }
            catch (e) {
                // If confirmPending throws with code-not-found, show pending embed again with button
                if (e?.message?.includes('not found in your Roblox')) {
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify:confirm:${i.user.id}`).setLabel('I’ve added it — Verify now').setStyle(ButtonStyle.Success).setEmoji('✅'), new ButtonBuilder().setCustomId(`verify:cancel:${i.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
                    const em = embed('Verify your Roblox account', `**Pending:** **${pending.roblox_name}** (\`${pending.roblox_id}\`)\n` +
                        `**Your code:** \`${pending.code}\`\n\n` +
                        `**Steps:**\n` +
                        `1. Open https://www.roblox.com/users/${pending.roblox_id}/profile\n` +
                        `2. Edit profile → add \`${pending.code}\` to your **About** / blurb\n` +
                        `3. Save → wait 10s → press **Verify now**\n\n` +
                        `-# Code expires <t:${Math.floor((pending.created_at + PENDING_TTL_MS) / 1000)}:R>. You can remove it after.`, Colors.Blurple);
                    await i.editReply({ embeds: [em], components: [row] });
                    return;
                }
                throw e;
            }
        }
        if (link) {
            // Already linked — re-sync
            return await ctx.roblox.sync(actor);
        }
        // No pending, no link → help
        return {
            embeds: [embed('How to verify', `Run **\`/verify username: YourRobloxName\`** to start.\n\n` +
                    `**What happens:**\n` +
                    `• Bot gives you a code like \`VG-ABC123\`\n` +
                    `• Add it to your Roblox **About** on https://www.roblox.com/users/<yourId>/profile\n` +
                    `• Click **Verify now** or run \`/verify\` again\n\n` +
                    `-# Your Roblox username is exact (not display name). Find it on your profile URL.`, Colors.Blurple)],
        };
    }
    // Username provided → create pending
    if (!s.authorized)
        throw new (await import('../../errors.js')).AppError('INTEGRATION_ERROR', 'This server is not authorized.');
    if (s.verifiedRoleId) {
        const role = await i.guild.roles.fetch(s.verifiedRoleId).catch(() => null);
        if (!role)
            throw new (await import('../../errors.js')).AppError('INTEGRATION_ERROR', 'Verified role is missing. Ask an admin to set `/setup staff role` / security setup.');
    }
    const pending = await createPending(ctx.store, guildId, i.user.id, username);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify:confirm:${i.user.id}`).setLabel('I’ve added it — Verify now').setStyle(ButtonStyle.Success).setEmoji('✅'), new ButtonBuilder().setCustomId(`verify:cancel:${i.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    const em = embed('Verify your Roblox account', `**Found:** **${pending.roblox_name}** (\`${pending.roblox_id}\`)\n` +
        `**Your code:** \`${pending.code}\`\n\n` +
        `**Do this now:**\n` +
        `1. Open https://www.roblox.com/users/${pending.roblox_id}/profile\n` +
        `2. Click Edit (✏️) → paste \`${pending.code}\` into your **About** / blurb\n` +
        `3. Save → wait 10 seconds → press **Verify now** below\n\n` +
        `You can also run \`/verify\` again after adding it.\n` +
        `-# Code expires <t:${Math.floor((pending.created_at + PENDING_TTL_MS) / 1000)}:R>. Remove it after verifying if you want.`, Colors.Blurple);
    // Use followUp with components — caller is deferred, so editReply
    await i.editReply({ embeds: [em], components: [row] });
    return;
});
