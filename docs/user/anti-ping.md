# Staff mention protection

Vanguard watches message-create and message-update events. When someone mentions a protected user or role without permission, it replies publicly with the **Mentions Disabled** embed and deletes the original message. No DM is sent and no timeout is applied. Managed bots, webhooks, developers, trusted users and configured bypass roles are exempt.

## Setup

```
/antiping protect user:@User        (or role:@Staff)
/antiping enable
```

`/mention` is an alias for `/automod antiping` with the same options:

| Subcommand | Purpose |
|---|---|
| `status` | Show whether protection is on and which targets are configured |
| `enable` / `disable` | Turn blocking on or off for this server |
| `protect user\|role` | Add a protected user or role |
| `remove user\|role` | Remove a protected user or role |
| `bypass role allowed` | Allow (`true`) or disallow (`false`) an ordinary staff role to mention protected targets |

Existing targets are kept when you enable it.

Enabling it also turns off the old Vanguard-owned AutoMod rule, if one is found, and switches to native handling.

## Permissions

- Migrating from the old AutoMod rule needs **Manage Server**.
- Native handling needs View Channel, Send Messages, Embed Links, Read Message History and **Manage Messages**.

Direct mentions of members of a protected role are also caught when Discord supplies their membership data. The original notification may already have reached the person before the message is deleted.
