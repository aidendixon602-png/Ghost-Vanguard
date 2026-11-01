<!-- coderabbit-ai-generated:v1 -->

# Assigning bot access

## Who can assign permissions

The bot ranks run, lowest to highest: **Helper → Moderator → Admin → Head Admin → Bot Manager → Overseer → Supreme Leader → Server Owner → Developer**. Each rank can use everything the ranks below it can.

**Nobody can give or take a Vanguard rank that is equal to or above their own.** Only the **Server Owner** and **Developers** are exempt. A Head Admin can hand out Helper, Moderator and Admin; they cannot give Head Admin, Bot Manager, Overseer, Supreme Leader or anything higher. Discord's Administrator permission never counts for these assignments, so an Administrator with no Vanguard rank cannot change ranks at all.

**Only Developers manage the bot itself.** Bot Manager, Overseer, Supreme Leader and the Server Owner get staff commands — never bot management. `/dev` (status, diagnostics, inspect, broadcast, update, restart), `/dev database`, server authorizations, `/setup staff global` (bot-wide ranks) and security-admin grants are Developer-only, as is every network-ban action.

## Server-only ranks by user ID

A Head Admin or above runs this command in the target server, and can only pick a rank below their own:

```text
/setup staff user user_id:123456789012345678 rank:Moderator
/setup staff user user_id:123456789012345678 rank:Remove direct rank
/setup staff check user:@Member
/setup staff list
```

Enable Discord Developer Mode and copy the member's user ID. This rank applies only to that server. Removing a direct rank does not remove ranks from Discord roles, source configuration, security-admin grants or bot-wide assignments; these independent sources are still evaluated.

For Discord-role assignments, Head Admins and above use `/setup staff role`; the same "below your own rank" rule applies, so a Head Admin can link a role to Helper, Moderator or Admin only. The Server Owner and Developers use `/setup config permission-role`.

A role that carries a rank can be given with `/role add` only by someone above that rank (the Server Owner and Developers are exempt). Taking such a role away is never blocked by the rank rule.

## Role blacklist

`/role blacklist` marks a role that only specific people may give or delete. It is managed by the **Server Owner** and **Developers** only:

```text
/role blacklist add role:@HighCouncil
/role blacklist who-can-give role:@HighCouncil who:@DeputyOwner
/role blacklist who-can-give role:@HighCouncil who:@OwnerTeam
/role blacklist list
/role blacklist remove role:@HighCouncil
```

- A blacklisted role cannot be given to anyone unless the person giving it — or a role they hold — is listed for it. **No staff rank, Discord Administrator permission or anti-nuke whitelist entry bypasses that**, and nobody is listed implicitly, including the server owner and Developers.
- Taking a blacklisted role away is always allowed; that is de-escalation.
- If someone who is not listed gives it, **through `/role` or straight in Discord**, the role is removed immediately, the refusal is logged, and the person is DMed with the role name and the reason. Through `/role`, the command reply also refuses and explains it.
- **Deleting a blacklisted role** is limited to the same people. Anyone else's deletion is undone: Vanguard recreates the role with its saved name, colour, permissions and position, gives it back to the members it recorded as holding it, and moves the blacklist entry to the new role.
- Automatic restores (`/role restore`, quarantine release, rejoin roles, Roblox bindings) and layout pruning never re-grant or delete a blacklisted role.

## Automatic reactions (source only)

Auto-reactions are built into the bot, not a command: there is no `/dev autoreact` and nothing is saved in the database. List members in `src/bot/access-ids.ts`, then rebuild (`npm run build`) and restart.

```ts
/** Every server the bot is in. */
export const AUTOREACT_IDS: Record<string, string> = {
    'YOUR_USER_ID': '🐐',
    'ANOTHER_USER_ID': '🔥',
};

/** One server only; a server entry wins over a global one. */
export const SERVER_AUTOREACT_IDS: Record<string, Record<string, string>> = {
    'YOUR_SERVER_ID': { 'YOUR_USER_ID': '👀' },
};
```

Use a unicode emoji or a custom one (`<:name:id>`); leave the value empty for the default 🐐. Webhook, system and bot messages are ignored, and a missing permission or an unusable emoji is skipped silently. Because it is source, changing the list needs a rebuild and restart — exactly like `BOT_STAFF_IDS` and `SERVER_STAFF_IDS`.

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
