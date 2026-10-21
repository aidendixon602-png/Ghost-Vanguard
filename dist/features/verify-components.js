import { Colors } from 'discord.js';
import { AppError } from '../errors.js';
import { embed } from '../ui/ui.js';
import { confirmPending, clearPending } from '../integrations/custom-verification.js';
import { linkAccount } from '../integrations/custom-verification.js';
import { defaults } from '../bot/registry.js';
export function registerVerifyControls(registry) {
    registry.component({
        prefix: 'verify:confirm:',
        kinds: ['button'],
        metadata: { ...defaults, requiresAuthorization: true, cooldown: 3000, category: 'verification', access: 'member', ephemeralDefault: true },
        execute: async (ctx, i) => {
            const ownerId = i.customId.slice('verify:confirm:'.length);
            if (i.user.id !== ownerId)
                throw new AppError('PERMISSION_ERROR', 'This verification button is for the person who started it.');
            if (!i.guildId)
                throw new AppError('VALIDATION_ERROR', 'Verification only works in a server.');
            // Defer already done by router, we are inside interaction
            try {
                const ok = await confirmPending(ctx.store, i.guildId, i.user.id);
                linkAccount(ctx.store, i.guildId, i.user.id, ok.roblox_id, ok.roblox_name);
                const member = await i.guild.members.fetch(i.user.id);
                const result = await ctx.roblox.sync(member, { isInitial: true });
                await i.editReply({ content: result, embeds: [], components: [] });
            }
            catch (e) {
                if (e instanceof AppError) {
                    // Show friendly embed again
                    await i.editReply({ embeds: [embed('Verification failed', e.message, Colors.Red)], components: [] });
                    return;
                }
                throw e;
            }
        }
    });
    registry.component({
        prefix: 'verify:cancel:',
        kinds: ['button'],
        metadata: { ...defaults, requiresAuthorization: true, cooldown: 1000, category: 'verification', access: 'member', ephemeralDefault: true },
        execute: async (ctx, i) => {
            const ownerId = i.customId.slice('verify:cancel:'.length);
            if (i.user.id !== ownerId)
                throw new AppError('PERMISSION_ERROR', 'This button is not for you.');
            clearPending(ctx.store, i.guildId, i.user.id);
            await i.editReply({ content: 'Verification cancelled. Run `/verify username: YourName` to start again.', embeds: [], components: [] });
        }
    });
}
