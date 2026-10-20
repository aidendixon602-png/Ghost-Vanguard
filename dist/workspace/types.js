export const WORKSPACE_MODULES = ['submissions', 'reviews', 'records', 'tasks', 'staff', 'reports'];
export const MIDTOWN_GUILD_ID = '1556485316838293587';
export const MIDTOWN_SPREADSHEET_ID = '1G9PXfM8zpGgzUb-YjsxCnGR2yKwI9cfaXe0q7WpD6lE';
const columns = (entries) => entries;
export const MIDTOWN_PRESET = {
    guildId: MIDTOWN_GUILD_ID,
    enabled: false,
    modules: { submissions: true, reviews: true, records: true, tasks: true, staff: true, reports: true },
    branding: {
        departmentName: 'Midtown Archives', shortName: 'Archives',
        description: 'Internal staff operations workspace.', primaryColor: 0x13233f, accentColor: 0xc9a646,
        memberPanelTitle: 'Midtown Archives · Workspace',
        memberPanelDescription: 'Submit material and check your own submissions. Staff use the separate dashboard.',
        staffPanelTitle: 'Midtown Archives · Staff Workspace',
        staffPanelDescription: 'Review submissions, manage records and directives, synchronize staff, and view reports.',
        buttonLabels: { submit: 'Submit', mine: 'My Submissions', help: 'Help', queue: 'Review Queue', records: 'Records', tasks: 'Tasks', staff: 'Staff', reports: 'Reports', settings: 'Settings' },
    },
    forms: { submission: {
            titleLabel: 'Document title', sourceLabel: 'Author / source link', dateLabel: 'Document date',
            connectionLabel: 'Connection to this department', permissionLabel: 'Sharing permission / restrictions',
            notesLabel: 'Missing pages, edits, estimates, and other notes', requireSource: false, requireConnection: true,
        } },
    review: { statuses: ['Received', 'Under review', 'Needs information', 'Accepted', 'Restricted', 'Declined'], accessChoices: ['Public', 'Restricted', 'Staff only'], managerCanDecide: true, reviewerCanRequestInformation: true, publicPostingEnabled: false },
    roles: { reviewerRoleIds: [], managerRoleIds: [], staffRoleIds: [], rankPriority: [], preserveExistingRoster: true, confirmedCapacity: null, proposedCapacity: null, excludeFromCapacityUserIds: [] },
    channels: { memberPanelId: null, staffPanelId: null, taskPanelId: null, documentEntryId: null, directiveEntryId: null, auditLogId: null, reminderId: null, publicDocumentsId: null, publicArchiveNotificationsId: null },
    sheets: {
        spreadsheetId: MIDTOWN_SPREADSHEET_ID, headerRow: 7, firstDataRow: 8, lastDataRow: 207, allowExpansion: false,
        archiveRegister: { name: 'Archive Register', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: columns({ recordId: 'A', title: 'B', documentDate: 'C', author: 'D', sourceUrl: 'E', midtownConnection: 'F', accessLevel: 'G', recordStatus: 'H', archiveUrl: 'I', reviewedBy: 'J', reviewDate: 'K', notes: 'L', nextAction: 'M' }), headers: columns({ recordId: 'Record ID', title: 'Title', documentDate: 'Document Date', author: 'Author / Authority', sourceUrl: 'Source URL', midtownConnection: 'Midtown Connection', accessLevel: 'Access Level', recordStatus: 'Record Status', archiveUrl: 'Archive URL', reviewedBy: 'Reviewed By', reviewDate: 'Review Date', notes: 'Notes', nextAction: 'Next Action' }) },
        submissionReviews: { name: 'Submission Reviews', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: columns({ submissionId: 'A', receivedDate: 'B', contributor: 'C', documentTitle: 'D', sourceUrl: 'E', assignedReviewer: 'F', reviewStatus: 'G', decisionDate: 'H', recordId: 'I', reviewNotes: 'J', nextAction: 'K' }), headers: columns({ submissionId: 'Submission ID', receivedDate: 'Received Date', contributor: 'Contributor', documentTitle: 'Document Title', sourceUrl: 'Source URL', assignedReviewer: 'Assigned Reviewer', reviewStatus: 'Review Status', decisionDate: 'Decision Date', recordId: 'Record ID', reviewNotes: 'Review Notes', nextAction: 'Next Action' }) },
        staffRoster: { name: 'Staff Roster', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: columns({ username: 'A', userId: 'B', role: 'C', rosterStatus: 'D', joinedDate: 'E', lastReview: 'F', updated: 'G', reference: 'H', mention: 'I', notes: 'J' }), headers: columns({ username: 'Discord Username', userId: 'Discord User ID', role: 'Role', rosterStatus: 'Roster Status', joinedDate: 'Joined Date', lastReview: 'Last Review', updated: 'Updated', reference: 'Reference', mention: 'Discord Mention', notes: 'Staff Notes' }) },
        directiveTracker: { name: 'Directive Tracker', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: columns({ taskId: 'A', description: 'B', issuedDate: 'C', issuedBy: 'D', assignedTo: 'E', dueDate: 'F', status: 'G', priority: 'H', completedDate: 'I', daysOverdue: 'J', notes: 'K', nextAction: 'L' }), headers: columns({ taskId: 'Directive ID', description: 'Directive / Task', issuedDate: 'Issued Date', issuedBy: 'Issued By', assignedTo: 'Assigned To', dueDate: 'Due Date', status: 'Status', priority: 'Priority', completedDate: 'Completed Date', daysOverdue: 'Days Overdue', notes: 'Notes', nextAction: 'Next Action' }) },
    },
    reminders: { enabled: false, channelId: null, schedule: 'weekly', timezone: 'America/Los_Angeles', weekday: 1, hour: 9, minute: 0, mentionResponsible: false },
};
export function isWorkspaceModule(value) {
    return WORKSPACE_MODULES.includes(value);
}
export function validDiscordId(value) {
    return typeof value === 'string' && /^\d{17,20}$/.test(value);
}
export function guildFromConfig(config, guild) {
    return config.guildId === guild.id;
}
