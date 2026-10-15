import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import {
    DEFAULT_TICKET_TYPES, MAX_TICKET_TYPES, refreshTicketPanels, seedTicketTypes, ticketTypes, ticketTypeByName, validTicketEmoji,
} from '../../features/tickets.js';

/**
 * /ticket types — the dropdown choices on the ticket panel. Editing a type refreshes every panel
 * in the server, so members always see the current menu.
 */

const autocomplete = async (ctx: CommandContext, i: any) => {
    const typed = String(i.options.getFocused() ?? '').toLowerCase();
    await i.respond(ticketTypes(ctx.store, i.guildId)
        .filter(t => t.name.toLowerCase().includes(typed)).slice(0, 25)
        .map(t => ({ name: t.name, value: t.name })));
};

export default defineCommand(new SlashCommandBuilder().setName('ticket-type').setDescription('The ticket types members can pick from')
    .addSubcommand(s => s.setName('add').setDescription('Add a ticket type to the menu')
        .addStringOption(o => o.setName('name').setDescription('Name shown in the dropdown').setRequired(true).setMaxLength(50))
        .addStringOption(o => o.setName('emoji').setDescription('Emoji shown next to it').setMaxLength(64))
        .addStringOption(o => o.setName('description').setDescription('Short line under the name').setMaxLength(100)))
    .addSubcommand(s => s.setName('edit').setDescription('Rename a ticket type or change its emoji or description')
        .addStringOption(o => o.setName('name').setDescription('Which ticket type').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('new_name').setDescription('New name').setMaxLength(50))
        .addStringOption(o => o.setName('emoji').setDescription('Emoji shown next to it').setMaxLength(64))
        .addStringOption(o => o.setName('description').setDescription('Short line under the name').setMaxLength(100)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a ticket type from the menu')
        .addStringOption(o => o.setName('name').setDescription('Which ticket type').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('Show every ticket type'))
    .addSubcommand(s => s.setName('reset').setDescription('Replace the ticket types with the defaults')),
    { category: 'tickets', cooldown: 1500, requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
    const sub = i.options.getSubcommand(true);
    const guild = i.guild;

    if (sub === 'list') {
        const types = ticketTypes(ctx.store, i.guildId);
        return `**🎫 Ticket types (${types.length})**\n`
            + (types.map(t => `${t.emoji || '•'} **${t.name}** — ${t.description ?? ''}`).join('\n')
                || 'No ticket types yet. Add one with `/ticket types add`, or restore the defaults with `/ticket types reset`.');
    }

    if (sub === 'reset') {
        ctx.store.run('DELETE FROM ticket_types WHERE guild_id=?', i.guildId);
        seedTicketTypes(ctx.store, i.guildId);
        await refreshTicketPanels(ctx.store, guild);
        return `♻️ Ticket types reset to the defaults (${DEFAULT_TICKET_TYPES.map(t => t[0]).join(', ')}). Every panel was refreshed.`;
    }

    if (sub === 'add') {
        const name = i.options.getString('name', true).trim();
        const emoji = i.options.getString('emoji')?.trim() || null;
        const types = ticketTypes(ctx.store, i.guildId);
        if (types.length >= MAX_TICKET_TYPES)
            throw new AppError('VALIDATION_ERROR', `Discord dropdowns hold ${MAX_TICKET_TYPES} options, which this menu already has.`);
        if (ticketTypeByName(ctx.store, i.guildId, name))
            throw new AppError('VALIDATION_ERROR', 'A ticket type with that name already exists.');
        if (emoji && !validTicketEmoji(emoji))
            throw new AppError('VALIDATION_ERROR', "That doesn't look like an emoji. Try something like 🎫.");
        const position = types.reduce((max, t) => Math.max(max, t.position), -1) + 1;
        ctx.store.run('INSERT INTO ticket_types(guild_id,name,emoji,description,position) VALUES(?,?,?,?,?)',
            i.guildId, clip(name, 50), emoji, i.options.getString('description')?.trim() || null, position);
        await refreshTicketPanels(ctx.store, guild);
        return `✅ Added **${name}**. Every panel now offers it.`;
    }

    const name = i.options.getString('name', true);
    const type = ticketTypeByName(ctx.store, i.guildId, name);
    if (!type)
        throw new AppError('VALIDATION_ERROR', `No ticket type called **${clip(name, 50)}**.`);

    if (sub === 'remove') {
        ctx.store.run('DELETE FROM ticket_types WHERE guild_id=? AND id=?', i.guildId, type.id);
        await refreshTicketPanels(ctx.store, guild);
        return `🗑️ Removed **${type.name}**. Every panel was refreshed. Tickets already open keep their type.`;
    }

    const newName = i.options.getString('new_name')?.trim() || type.name;
    const emoji = i.options.getString('emoji')?.trim() || type.emoji;
    const description = i.options.getString('description')?.trim() || type.description;
    if (emoji && emoji !== type.emoji && !validTicketEmoji(emoji))
        throw new AppError('VALIDATION_ERROR', "That doesn't look like an emoji.");
    const clash = ticketTypeByName(ctx.store, i.guildId, newName);
    if (clash && clash.id !== type.id)
        throw new AppError('VALIDATION_ERROR', `A ticket type called **${newName}** already exists.`);
    ctx.store.run('UPDATE ticket_types SET name=?,emoji=?,description=? WHERE guild_id=? AND id=?', clip(newName, 50), emoji, description, i.guildId, type.id);
    await refreshTicketPanels(ctx.store, guild);
    return `✅ Updated **${type.name}** → **${newName}${emoji ? ` ${emoji}` : ''}**. Every panel was refreshed.`;
}, { autocomplete });
