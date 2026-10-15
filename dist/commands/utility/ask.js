import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { clip } from '../../core.js';
import { AppError } from '../../errors.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('ask').setDescription('Ask the AI assistant a question (when AI is enabled)')
    .addStringOption(o => o.setName('prompt').setDescription('Your question').setMaxLength(2000).setRequired(true)), { responseKind: 'info', category: 'utility', cooldown: 30000, access: 'member' }, async (ctx, i) => {
    const actor = ctx.actor;
    const s = ctx.store.settings(i.guildId);
    if (!config.aiEnabled || !config.openaiKey)
        throw new AppError('VALIDATION_ERROR', 'AI chat is disabled. Set AI_ENABLED=true and OPENAI_API_KEY in .env, then restart.');
    if (ctx.ai.inFlight >= 4)
        throw new AppError('VALIDATION_ERROR', 'The AI assistant is busy. Try again shortly.');
    ctx.ai.inFlight++;
    try {
        // An unavailable optional SDK must not prevent the entire bot from starting.
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: config.openaiKey, timeout: 45000, maxRetries: 1 });
        const response = await openai.responses.create({ model: config.openaiModel,
            instructions: 'You are Ghost Vanguard, a helpful Discord community assistant. Keep replies concise. You have no access to server controls, records, permissions, user accounts or tools. Never claim you performed moderation or changed the server.',
            input: i.options.getString('prompt', true), max_output_tokens: 800, store: false });
        return clip(response.output_text || 'No text was returned.', 3800);
    }
    catch (error) {
        throw new AppError('INTEGRATION_ERROR', 'The AI provider could not complete this request. Check its configuration and availability.', { cause: error });
    }
    finally {
        ctx.ai.inFlight--;
    }
});
