import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('authserver').setDescription('Developer: authorize this server so Vanguard protects it'), { category: 'developer', developerOnly: true, requiresAuthorization: false }, (ctx, i) => ctx.lifecycle.authorize(i.guild, i.user.id));
