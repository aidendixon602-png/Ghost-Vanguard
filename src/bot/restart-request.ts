import { config } from '../config.js';
import { askRestart, fallbackRestart } from './updater-link.js';

export type RestartResult =
    | 'not-authorized'
    | 'restarting'
    | 'busy'
    | 'scheduled'
    | 'too-soon'
    | 'no-launcher';

/** Restart access stays restricted to an exact ID in DEVELOPER_IDS. */
export function canUseRestart(userId: string): boolean {
    return config.developers.has(userId);
}

/**
 * Prefer launch.js IPC; use the existing non-zero-exit fallback only when the launcher
 * does not answer. Authorization is checked again here as well as by the slash-command guard.
 */
export async function requestRestart(
    userId: string,
    deps: {
        isDeveloper: (id: string) => boolean;
        askRestart: (by: string) => Promise<boolean | null>;
        fallbackRestart: () => 'scheduled' | 'too-soon' | 'no-launcher';
    } = { isDeveloper: canUseRestart, askRestart, fallbackRestart },
): Promise<RestartResult> {
    if (!deps.isDeveloper(userId)) return 'not-authorized';

    const accepted = await deps.askRestart(userId);
    if (accepted === true) return 'restarting';
    if (accepted === false) return 'busy';
    return deps.fallbackRestart();
}
