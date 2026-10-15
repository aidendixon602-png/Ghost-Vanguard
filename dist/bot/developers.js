import { config } from '../config.js';
import { AppError } from '../errors.js';
export const developers = {
    /** DEVELOPER_IDS plus the bot owner (BOT_OWNER_ID): the top rank. */
    has(id) {
        return config.developers.has(id) || !!id && id === config.ownerId;
    },
    require(id) {
        if (!this.has(id))
            throw new AppError('PERMISSION_ERROR', 'Only approved Midtown Vanguard developers can use this action.');
    },
};
