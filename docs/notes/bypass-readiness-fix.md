# Anti-nuke bypass readiness — 2.9.8

Active /trust role bypasses no longer block /enable or /antinuke enable when those roles are at or above Vanguard. /antinuke check and startup notices show those roles separately as exempt.

Only active, server-specific trust_role grants qualify. Expired or removed grants, individual user bypasses and verification-bot grants do not exempt a whole role. Administrator alone is not a bypass. Other high roles and missing bot/log permissions still block enabling. Enforcement bypass behavior is unchanged.

Restart after updating, then run /antinuke check and /enable. Existing bypasses, settings, credentials and databases are retained. No live Discord actions were tested during packaging.
