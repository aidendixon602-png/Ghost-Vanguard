<!-- coderabbit-ai-generated:v1 -->

# Assigning bot access

## Who can assign permissions

Only approved **Developer user IDs** may assign, remove or manage Ghost Vanguard permission ranks, permission-role mappings and security-admin grants. The bot owner and existing `DEVELOPER_IDS` remain approved. Additional source-controlled Developers can be listed in `BOT_STAFF_IDS.developer` in `src/bot/access-ids.ts`.

Server owners, Discord Administrators, Head Admins, Supreme Leaders and other bot ranks cannot delegate bot permission roles. Existing rank assignments continue working. Discord privileged roles that do not grant Vanguard access retain their existing owner-approved role rules.

## Server-only ranks by user ID

A Developer runs this command in the target server:

```text
/setup staff user user_id:123456789012345678 rank:Moderator
/setup staff user user_id:123456789012345678 rank:Remove direct rank
/setup staff check user:@Member
/setup staff list
```

Enable Discord Developer Mode and copy the member's user ID. This rank applies only to that server. Removing a direct rank does not remove ranks from Discord roles, source configuration, security-admin grants or bot-wide assignments; these independent sources are still evaluated.

For Discord-role assignments, Developers use `/setup staff role`. Only Developers can give or remove a mapped bot permission role through `/role`, restores or delegated rules.

## Source-controlled ID assignments

Edit `src/bot/access-ids.ts`, rebuild with `npm run build`, then restart. These are public Discord IDs, never tokens. No `.env` change is needed.

```ts
export const BOT_STAFF_IDS = {
    developer: ['YOUR_APPROVED_DEVELOPER_USER_ID'],
    // Optional: botmanager, overseer, supreme (apply across all servers).
};
export const SERVER_STAFF_IDS = {
    'YOUR_SERVER_ID': {
        'YOUR_STAFF_USER_ID': 'moderator',
    },
};
```

Keep the type annotations in the actual file. Available server ranks: `helper`, `moderator`, `admin`, `headadmin`. Source assignments must be changed in source; Discord commands cannot revoke them. Developer access gives full bot control, so add only trusted user IDs.

`/setup staff global` intentionally grants access across every connected server. Use `/setup staff user` or `SERVER_STAFF_IDS` for local access.

## Discord changes and automatic assignments

When Discord supplies a member-role audit event, Vanguard attempts to undo unauthorized additions **and removals** of mapped bot permission roles, including changes by a server owner or another bot. Developer IDs and Vanguard's internal containment/restoration are recognized separately. Failures are logged with the actor and affected member. The bot needs View Audit Log, Manage Roles and a role above the roles it protects.

Discord owners and Administrators still control Discord itself: they can remove the bot or its permissions. Audit-event enforcement is reactive and cannot guarantee prevention of every direct Discord action. Restrict Discord Manage Roles and Administrator permissions as well.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:7b399129801222a5f33011107e69c51a890656a6ea0669d4071889ade5a2d05d -->

Verification and Roblox group bindings cannot automatically grant mapped bot permission roles. Quarantine restoration requires a Developer caller to restore them. Protected commands are suspended while a member is quarantined, including access from direct user IDs and bot-wide ranks. A server owner or Developer can review and release quarantine through the existing recovery controls; help remains available.

<!-- /coderabbit-ai-generated:v1 -->

## Log placement

Run `/setup logs setup` after updating. Ghost Vanguard moves its active log category to position zero, keeping channel history and channel overrides. Discord displays uncategorized channels above categories; move those into categories if you want the bot logs above them too. Manually routed destinations outside the bot category stay where you put them.
