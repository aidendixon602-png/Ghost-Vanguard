import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('verify').setDescription('Sync your linked Roblox account, role and nickname'), { category: 'verification', cooldown: 30000, access: 'member', botPermissions: [PermissionFlagsBits.ManageRoles] }, async (ctx, i) => {
    const actor = ctx.actor;
    const s = ctx.store.settings(i.guildId);
    return ctx.roblox.sync(actor);
});
