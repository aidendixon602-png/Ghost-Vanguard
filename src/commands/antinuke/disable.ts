import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import antinuke from './antinuke.js';

export default defineCommand(new SlashCommandBuilder().setName('disable').setDescription('Turn anti-nuke off (asks to confirm; stays off after restarts)'),
    { ...antinuke.metadata, ...antinuke.subcommands?.disable }, async (ctx, i) => {
        const options = new Proxy(i.options, { get: (target, key) => key === 'getSubcommand' ? () => 'disable' : Reflect.get(target,key) });
        const forwarded = new Proxy(i, { get: (target,key) => {
            if (key === 'options') return options;
            const value = Reflect.get(target,key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        return antinuke.execute(ctx, forwarded);
    });
