import { config } from '../config.js';
import { AppError } from '../errors.js';
export const developers = {
    has(id) {
        return config.developers.has(id);
    },
    require(id) {
        if (!this.has(id))
            throw new AppError('PERMISSION_ERROR', 'Only approved Midtown Vanguard developers can use this action.');
    },
};
