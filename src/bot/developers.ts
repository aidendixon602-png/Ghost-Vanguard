import { BOT_STAFF_IDS } from './access-ids.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';

export const developers = {
    /** DEVELOPER_IDS plus the bot owner (BOT_OWNER_ID): the top rank. */
    has(id: string) {
        return !!BOT_STAFF_IDS.developer?.includes(id) || config.developers.has(id) || !!id && id === config.ownerId;
    },
    require(id: string) {
        if (!this.has(id))
            throw new AppError('PERMISSION_ERROR', 'Only approved Ghost Vanguard developers can use this action.');
    },
};
