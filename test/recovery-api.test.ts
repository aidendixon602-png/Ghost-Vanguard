import test from 'node:test';
import assert from 'node:assert/strict';
import { withRecoveryApi, rejectRecoveryWait, recoveryApiWait } from '../src/recovery/recovery-api.js';
import { MAX_RATE_LIMIT_WAIT_MS } from '../src/recovery/limits.js';

const twoDays = 172800000;
const limit: any = { route: '/guilds/:id/roles', majorParameter: 'g', method: 'POST', retryAfter: twoDays, timeToReset: 0, sublimitTimeout: 0 };

test('only an active restore rejects waits over the cap, and shorter waits report progress', async () => {
    assert.equal(rejectRecoveryWait(limit), false, 'nothing is running yet');
    const stages: string[] = [];
    await withRecoveryApi('g', async (stage) => {
        stages.push(stage);
    }, async () => {
        assert.equal(rejectRecoveryWait(limit), true);
        assert.equal(rejectRecoveryWait({ ...limit, retryAfter: 3000 }), false);
        assert.equal(rejectRecoveryWait({ ...limit, majorParameter: 'other' }), false);
        recoveryApiWait({ ...limit, retryAfter: 3000 });
        assert.match(stages[0]!, /3s/);
    });
    assert.equal(rejectRecoveryWait(limit), false, 'cleared after the restore ends');
    await assert.rejects(withRecoveryApi('g', undefined, async () => {
        throw Error('failed');
    }));
    assert.equal(rejectRecoveryWait(limit), false, 'cleared after a failed restore');
});

test('a wait exactly at the cap is waited out; one millisecond over is rejected', async () => {
    await withRecoveryApi('g', undefined, async () => {
        assert.equal(rejectRecoveryWait({ ...limit, retryAfter: MAX_RATE_LIMIT_WAIT_MS }), false);
        assert.equal(rejectRecoveryWait({ ...limit, retryAfter: MAX_RATE_LIMIT_WAIT_MS + 1 }), true);
    });
});

test('a multi-minute wait under the cap is reported as a retry, not a stop', async () => {
    const stages: string[] = [];
    await withRecoveryApi('g', async (stage) => {
        stages.push(stage);
    }, async () => {
        recoveryApiWait({ ...limit, retryAfter: 5 * 60 * 1000 });
        recoveryApiWait({ ...limit, retryAfter: twoDays });
    });
    assert.match(stages[0]!, /300s.*retrying automatically/);
    assert.match(stages[1]!, /^Stopping recovery/);
});
