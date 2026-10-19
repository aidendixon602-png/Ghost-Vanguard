# Workspace management system

Workspace is a reusable, guild-scoped button system for Ghost Vanguard. It is deliberately separate from the existing ticket desk: it can link to the ticket desk and configured support resources, but it does not create or replace them.

## What is implemented

- Durable per-guild profile, sessions, panels, counters, submissions, reviews, records, tasks, staff rows, audit history, operations and reminder jobs in SQLite.
- Guild authorization and the normal interaction guard are run before every Workspace command or component. DMs, unauthorized guilds, stale controls and cross-guild database reads are rejected.
- Stable button IDs. Working screens are ephemeral and bound to the initiating user. Persistent member and staff panel messages are updated in place and can be republished after deletion or restart.
- Generic profile with configurable modules, branding, labels, form requirements, review statuses and decisions, role mappings, channels, workbook mappings, timezone and reminders.
- Midtown Archives preset for guild `1556485316838293587`, spreadsheet `1G9PXfM8zpGgzUb-YjsxCnGR2yKwI9cfaXe0q7WpD6lE`, `America/Los_Angeles`, header row 7, data rows 8–207, and the four named worksheets. It is not automatically activated.
- Google Sheets uses the Sheets v4 API with `RAW` value writes. Values beginning with `=` are stored as literal text. Mapped ID columns are re-read on every write, and calculated columns are not written.
- Accepted and restricted decisions require an explicit access choice and reserve a local Record ID before the archive write. A retry reuses the same ID; an archive URL is never claimed unless one exists.
- Scheduled reminders remain disabled until a destination, schedule and timezone are configured. Authorization revocation disables the integration and removes controls from the integration's own panel messages where Discord permits it; records remain in SQLite.

## Setup command

The command is administrative setup only; ordinary users and staff use the panels afterward.

1. Ensure the bot is already authorized in the guild.
2. Configure Google authentication (below) and share the target spreadsheet with the service-account email as Editor, or use an access token with Sheets scope.
3. Run `/setup config workspace-setup`.
   - Choose `Generic` for a new server, or `Midtown Archives` only in the configured Midtown guild.
   - Select channels with Discord channel selectors. IDs are saved and validated against the actual guild; names are never used at runtime.
   - Select reviewer, manager and staff roles. Roles must belong to this guild and cannot be managed roles or `@everyone`.
   - For a generic workbook, pass `mapping_json` with worksheet names and column letters. Do not guess a mapping. Example:

```json
{
  "submissionReviews": {
    "name": "Intake Reviews",
    "columns": {
      "submissionId": "A", "receivedDate": "B", "contributor": "C",
      "documentTitle": "D", "sourceUrl": "E", "assignedReviewer": "F",
      "reviewStatus": "G", "decisionDate": "H", "recordId": "I",
      "reviewNotes": "J"
    }
  },
  "archiveRegister": { "name": "Records", "columns": { "recordId": "A", "title": "B" } },
  "staffRoster": { "name": "People", "columns": { "userId": "B", "username": "A" } },
  "directiveTracker": { "name": "Tasks", "columns": { "taskId": "A", "description": "B" } }
}
```

4. Setup reads the live spreadsheet metadata and mapped header cells before enabling writes. If a worksheet or header is missing, it prints the mismatch and saves nothing active.
5. Run `/setup config workspace-publish` with the panel kind `all`, or publish member/staff/tasks separately. The command edits the integration's existing message where possible; it does not create, rename, delete, reorganize or permission-change server channels.
6. `/setup config workspace-status` shows the enabled modules and validation state. `/setup config workspace-disable` preserves data and stops reminders. `/setup config workspace-enable` requires a previously validated profile.

The setup command can also accept `modules` as a comma-separated list of `submissions,reviews,records,tasks,staff,reports`. Disabled modules are omitted from panels and rejected by their controls.

## Google authentication

Use one of these environment configurations. Secrets must be supplied by the host's secret manager or `.env`; never commit them.

### Access token

```dotenv
WORKSPACE_GOOGLE_ACCESS_TOKEN=short-lived-oauth-access-token
```

The token must include `https://www.googleapis.com/auth/spreadsheets` and be renewed by the host before it expires.

### Service account JSON

```dotenv
WORKSPACE_GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"workspace-bot@project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nREDACTED\\n-----END PRIVATE KEY-----\\n"}
```

The value may also be base64-encoded. Split variables are supported:

```dotenv
WORKSPACE_GOOGLE_CLIENT_EMAIL=workspace-bot@project.iam.gserviceaccount.com
WORKSPACE_GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nREDACTED\n-----END PRIVATE KEY-----\n
```

Create a Google Cloud project, enable Google Sheets API, create a service account and key, then share each guild's workbook with the service-account email. The bot does not claim activation until the live workbook validation succeeds. The workbook's native formatting, tables, validations, protections, formulas and guide are not replaced; only mapped input cells are written. When prepared rows are exhausted, the default is to stop with an actionable error. Controlled row expansion is available only when `allowExpansion` is set in the stored profile and copies formula rows before writing.

## Member walkthrough

- **Submit** opens a five-step Discord modal flow without leaving the panel. It collects title, author/source, date and department connection, permission/restrictions, and uncertainty notes.
- A summary is shown before confirmation. On success the member receives a stable `SUB-YYYYMMDD-00001` receipt. The contributor's username, exact ID, timestamp and reference are captured automatically.
- **My Submissions** queries only the interacting member's exact ID. **Help** describes the process and points back to the existing support/ticket flow and configured resources.

## Staff walkthrough

- **Review Queue** shows stable ID, contributor, metadata, source, reviewer and status. Staff can assign, begin, request information, accept, restrict, decline and open the source.
- Consequential decisions show a confirmation summary. Accept and Restrict require one of `Public`, `Restricted`, or `Staff only`; that label does not alter Drive permissions. Acceptance creates one linked `REC-YYYYMMDD-00001` record, and retries reuse it.
- **Records** searches by Record ID/title, shows pending preservation honestly, and records correction requests without overwriting history.
- **Tasks** supports create, my/open/blocked/overdue views, owner, deadline, priority, blocked/in-progress/completed/cancelled status, and notes for handovers or revised instructions. IDs map to `Directive ID`.
- **Staff** synchronizes exact Discord user IDs. Leave/Inactive rows are preserved, and an incomplete member fetch never mass-removes rows. A full sync has a preview in the response before it applies changes.
- **Reports** shows live counts and refresh time. Reminders are deduplicated by guild and local schedule slot and use no mentions unless explicitly configured.
- **Settings** is visible only to configured managers and shows the current module, role, panel and reminder mappings.

## Midtown Archives notes

The preset is intentionally conservative. It contains the requested workbook mappings and timezone, but channel and role IDs remain empty because channel IDs were not available. Run setup with selectors for `support-information`, `staff-information`, `staff-documents`, `staff-directives`, `document-logs`, `ghost-vanguard-logging`, `documents`, `archives-notifications`, and the actual configured reminder destination as appropriate. Names are hints only; the selected IDs are what are stored.

No eight-member roster or Founder ID is invented. If the existing roster contains those exact members, select the real staff roles and run a previewed sync. `founderUserId` and `founderRoleLabel` may be set in the guild profile when the actual ID is verified. Leave/Inactive status and staff notes are preserved; rank changes are not inferred from those statuses.

## Recovery and limitations

- If a panel message is deleted, rerun `/setup config workspace-publish`; the stored message is fetched, and a replacement is posted only for that integration panel.
- If a session expires, reopen the panel. A stale button cannot commit a change.
- If Google Sheets fails after a local reservation, retry the same confirmation. The stable submission/record/task ID is reused; no success message is sent before the write succeeds.
- Public messages are not posted automatically. `publicPostingEnabled` is false in the preset and must be explicitly configured before adding a separately authorized publisher.
- The bot does not copy files into Drive. Without a verified archive URL, preservation is shown as pending.
- Google service-account authorization and Discord role/channel selection are external setup requirements; this repository cannot verify them without the operator's credentials and guild access.
