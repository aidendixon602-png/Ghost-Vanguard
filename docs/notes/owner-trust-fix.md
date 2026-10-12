# Owner trust management — 2.9.9

Configured BOT_OWNER_ID and DEVELOPER_IDS may add or remove their own user bypass and bypasses for roles they hold, through /trust and the anti-nuke whitelist panel. Other security administrators still cannot change their own bypasses. Existing command authorization, server scope, role validation, expiration, history and logging checks remain in place.

Roles are never exempted by their name. Add an explicit role bypass with /trust add role, then /enable. Active role bypasses above Vanguard do not block readiness; ordinary roles still do. The patch does not automatically enable protection or create bypasses.

Stop Vanguard before updating to release Windows native DLLs. Restart after successful installation. No live Discord API actions were made during validation.
