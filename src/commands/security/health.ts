import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { healthPanel } from '../../ui/health-ui.js';

export default defineCommand(new SlashCommandBuilder().setName('health').setDescription('Check protection, permissions, integrations and backups at a glance'),
    {category:'security',access:'security',responseKind:'info',cooldown:5000},async(ctx,i)=>{
        await i.guild.members.fetchMe();
        const log=ctx.store.settings(i.guildId).logChannelId;
        if(log)await i.guild.channels.fetch(log).catch(()=>null);
        ctx.assertActive();
        await i.editReply({embeds:[healthPanel(ctx,i.guild,i.channelId,i.channel?.isThread()?i.channel.parentId:null)],allowedMentions:{parse:[]}});
    });
