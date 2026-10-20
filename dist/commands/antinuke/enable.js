import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import antinuke from './antinuke.js';
export default defineCommand(new SlashCommandBuilder().setName('enable').setDescription('Enable enforcement after readiness check and confirmation'), { ...antinuke.metadata, ...antinuke.subcommands?.enable }, async (ctx, i) => {
    const options = new Proxy(i.options, { get: (target, key) => key === 'getSubcommand' ? () => 'enable' : Reflect.get(target, key) });
    const forwarded = new Proxy(i, { get: (target, key) => {
            if (key === 'options')
                return options;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    return antinuke.execute(ctx, forwarded);
});
