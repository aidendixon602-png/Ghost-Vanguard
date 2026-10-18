import { developers } from './developers.js';
import { askRestart, fallbackRestart } from './updater-link.js';

export type PrefixRestartResult =
    | 'not-authorized'
    | 'restarting'
    | 'busy'
    | 'scheduled'
    | 'too-soon'
    | 'no-launcher';

export interface PrefixRestartMessage {
    content: string;
    author: { id: string; bot: boolean };
    guildId: string | null;
}

/** Only an exact ,restart message from a human in a server is treated as this command. */
export function isPrefixRestartMessage(message: PrefixRestartMessage): boolean {
    return !message.author.bot
        && message.guildId !== null
        && message.content.trim().toLowerCase() === ',restart';
}

/**
 * Restart only for the bot owner or configured developers. Prefer launch.js IPC; use the
 * existing non-zero-exit fallback only when the launcher does not answer.
 */
export async function requestPrefixRestart(
    userId: string,
    deps: {
        isDeveloper: (id: string) => boolean;
        askRestart: (by: string) => Promise<boolean | null>;
        fallbackRestart: () => 'scheduled' | 'too-soon' | 'no-launcher';
    } = { isDeveloper: developers.has, askRestart, fallbackRestart },
): Promise<PrefixRestartResult> {
    if (!deps.isDeveloper(userId)) return 'not-authorized';

    const accepted = await deps.askRestart(userId);
    if (accepted === true) return 'restarting';
    if (accepted === false) return 'busy';
    return deps.fallbackRestart();
}
