import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function identity(values: Record<string, string> = {}) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { config, validateConfig } from './src/config.ts';
        import { developers } from './src/bot/developers.ts';
        console.log(JSON.stringify({owner:config.ownerId, recipients:[...config.trustedDmIds],
            oldOwner:developers.has('1277709272041394187'), developer:developers.has('222222222222222222'), errors:validateConfig()}));
    `], { encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: '/nonexistent-vanguard-test-env',
        DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: '111111111111111111', DEVELOPER_IDS: '222222222222222222',
        BOT_OWNER_ID: '', TRUSTED_DM_IDS: '', ...values } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
}

test('unset owner and DM configuration grants no built-in access or backup recipients', () => {
    const result = identity();
    assert.equal(result.owner, '');
    assert.deepEqual(result.recipients, []);
    assert.equal(result.oldOwner, false);
    assert.equal(result.developer, true, 'explicit developers retain access without an owner');
});

test('only explicitly configured identities receive owner access and backup DMs', () => {
    const result = identity({ BOT_OWNER_ID: ' 333333333333333333 ' });
    assert.equal(result.owner, '333333333333333333');
    assert.deepEqual(result.recipients, ['333333333333333333']);
    assert.equal(result.oldOwner, false);
    assert.deepEqual(identity({ BOT_OWNER_ID: '333333333333333333', TRUSTED_DM_IDS: '444444444444444444' }).recipients, ['444444444444444444']);
});

test('invalid owner and trusted DM configuration is reported at startup', () => {
    assert.match(identity({ BOT_OWNER_ID: 'invalid', TRUSTED_DM_IDS: '444444444444444444,bad' }).errors.join('\n'), /BOT_OWNER_ID/);
    assert.match(identity({ TRUSTED_DM_IDS: 'bad' }).errors.join('\n'), /TRUSTED_DM_IDS/);
});
