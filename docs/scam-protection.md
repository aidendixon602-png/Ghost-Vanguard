# Scam protection • Vanguard 2.9.7

The bot checks new and edited human messages in authorized, initialized servers with scam protection enabled. Unconfigured authorized servers are enabled automatically; explicit saved disables are preserved. It does not retroactively scan message history. Bots and webhooks are skipped. This is separate from anti-nuke: Administrator permission and anti-nuke trust do not exempt a sender.

## Install and enable

Stop the bot and run Update-Vanguard-Scam-Protection.ps1 from the existing bot folder. The cumulative updater supports 2.9.0 through 2.9.7, backs up changed project files, installs the new sharp dependency and verifies the compiled modules. It preserves existing .env, Google credentials, live configuration and databases. Native Windows execution and live Discord bans have not been tested here.

1. Discord Developer Portal → your application → Bot → Privileged Gateway Intents → enable **Message Content Intent** → Save Changes. Approval may be required for eligible/verified applications.
2. Restart the updated bot. Message Content Intent is now requested by default. Existing `MESSAGE_CONTENT_ENABLED=false` in .env or Wispbyte variables is an explicit override and must be changed to true to use the scanner.
3. On Wispbyte install dependencies in the hosted bot folder with `npm ci`; do not upload Windows node_modules to Linux. Upload updated src, dist, assets, scripts, package.json and package-lock.json. Preserve hosted credentials, .env and data.
4. Authorized servers start scanner setup automatically, including after restart and later authorization. An existing configured security log is reused. If none exists (or the configured channel was deleted), the bot creates private `#vanguard-security` when it has Manage Channels. Ordinary members are denied View Channel; server owner/Administrator members and the bot can read it. Other security staff can be granted access by an administrator.
5. Required Manage Messages/Ban Members permissions and an accessible log are checked automatically. Missing requirements pause scanning and report a startup/log warning. Readiness is retried every minute and on later messages. Put the bot role above members it should ban; per-member hierarchy restrictions are still logged.
6. Saved `/scam disable` stays disabled. `/scam enable` resumes scanning and attempts automatic log setup. `/scam status` shows the configured state and requirements.
7. Preserve or set reporting/evidence-channel exclusions with `/scam exclude channel:#reports excluded:true`. Exclusion includes that channel's threads. Channels are **not guessed from their names**; sharing a known scam image in a scanned channel can match enforcement even when posted as evidence. For a server not yet configured, temporarily disable the scanner while setting exclusions.

No `npm run scam:setup` or `/scam enable` is needed for an unconfigured authorized server. `MESSAGE_CONTENT_ENABLED=false` remains available as an application-wide Message Content override; change it to true when intentionally using the scanner. The Developer Portal toggle cannot be set by the bot itself.

## Matching and outcomes

| Match | Result |
| --- | --- |
| Blocked URL host or its subdomain | Delete message; ban sender when permitted |
| Exact attachment bytes or identical full decoded pixels | Delete message; ban sender when permitted |
| Similar visual fingerprint, including some resized/compressed copies | Staff review alert only |
| Suspicious MrBeast crypto/casino giveaway or Nitro-link text | Staff review alert only |
| Suspicious image text from optional AI transcription | Staff review alert only |
| Download/decoding failure or attachment limit exceeded | Incomplete-scan alert; no punishment from failure alone |

Three fingerprint references are bundled from the supplied screenshot: full Discord screenshot, left promotion panel and right withdrawal panel. The panel crops are reference approximations; original scam attachments can differ and may only generate a similarity alert. Cropped, heavily edited, rotated or reformatted variants are not guaranteed to match. To enforce on an actual original scam attachment, register that file with `/scam image-add`.

No blocked domains are invented or supplied by default. Add only confirmed domains you intend to block. The regex matches URL host boundaries; it does not follow links, expand shorteners, visit blocked sites, or inspect video/GIF/SVG content. Image matching is not a universal scam classifier.

Owner, bot owner and configured developers can have confirmed posts deleted, but cannot be auto-banned by this feature. Other members, including administrators and anti-nuke trusted members, are scanned. If a member cannot be banned due to hierarchy/permissions, the bot deletes the message if possible and logs that the ban was skipped. Deletion and banning are independent; deletion failure does not prevent an otherwise permitted ban. It bans only in the server where the message was posted, not across the network. It does not create a CSB case or a genre ban.

## Commands

All commands require internal Vanguard security access. Changes also require Discord Manage Guild. Server authorization, command-disabled settings and the existing cooldown/interaction routing apply.

- `/scam status`: readiness and limits.
- `/scam enable`, `/scam disable`: per-server persistent override; default is automatic enabled.
- `/scam domain-add domain:scam.example`: block this host and subdomains (maximum 20/server).
- `/scam domain-remove domain:scam.example`: remove block.
- `/scam image-add image:<file> name:<label>`: add a confirmed original scam image (maximum 20 custom references/server).
- `/scam image-remove id:<reference>`: remove a custom reference. Built-ins cannot be removed individually.
- `/scam list page:1`: paginated references/domains/exclusions.
- `/scam exclude channel:#reports excluded:true`: exclude channel and threads (maximum 20/server); false includes it again.
- `/scam vision enabled:true`: explicitly opt in to image text transcription using existing OpenAI settings. False stops this optional stage.

## Optional image text scanning

Set `AI_ENABLED=true`, `OPENAI_API_KEY` and an image-capable `OPENAI_MODEL`, restart, then opt in with `/scam vision enabled:true` in the chosen server. **Images are sent to OpenAI and API charges can apply.** Existing AI_ENABLED alone does not opt any server into image scanning. The scanner asks for transcription only; suspicious transcribed text produces staff review, never an automatic ban. It uses store:false, not a promise of zero provider retention.

The optional stage scans at most one image per server every 30 seconds and at most two AI requests concurrently. It is best effort; API failures generate incomplete-scan alerts, and skipped budget slots do not inspect image text. Use exact originals and confirmed domains for deterministic enforcement.

## Limits, evidence and verification

At most four static PNG/JPEG/WebP attachments per message, 8 MiB each and 8 megapixels. Downloads accept only HTTPS Discord attachment CDN URLs, reject redirects, enforce streamed limits and use timeouts. At most two messages are scanned concurrently; capacity overflow posts a bounded review notice instead of growing an unlimited queue. Similar-image alerts are intentionally less strict than enforcement.

A fresh message is fetched and checked before deletion to avoid acting on stale edits. Per-message revision records deduplicate successful scans/actions across repeated gateway events and restarts. A crash between external actions and saving the final record can still leave a partially completed action; review the Discord audit log. Scan events retain match, sender, message ID, original text (truncated), image names/IDs/URLs and separate deletion/ban outcomes in SQLite for 30 days. Attachment URLs can expire; original image bytes are not archived automatically.

Security log alerts never ping users. Personal embed cleanup does not delete security log records. No live Discord action or OpenAI vision request was made during implementation. Automated coverage includes host-boundary matching, exact/similar image outcomes, download bounds/SSRF checks, exclusions/threads, disabled/unauthorized skips, duplicate gateway delivery, edited content, hierarchy failure, owner protection and command permission gates.

Test live in a disposable authorized server with a consenting test account below the bot. Begin with a suspicious-text alert test (no ban), test excluded reporting threads, then add a dedicated test image and post its exact copy to confirm deletion/ban and outcomes. Remove the test reference/domain afterward. Do not test a known enforced image in production with your own staff account.
