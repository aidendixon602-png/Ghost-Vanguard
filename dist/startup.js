import { PRODUCT_NAME } from './branding.js';
import { VERSION } from './config.js';
import { startConsoleLog } from './console-log.js';
import { createStartupProgress } from './startup-progress.js';
/**
 * index.ts imports this first, so the first line is printed before the rest of the bot is evaluated
 * and the console is never blank while the bot starts. The console log starts just before that
 * line, so the line is in the log too.
 */
startConsoleLog();
export const startup = createStartupProgress();
startup.step(`Starting ${PRODUCT_NAME} v${VERSION}`);
