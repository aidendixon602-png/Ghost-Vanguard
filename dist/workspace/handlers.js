import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, } from 'discord.js';
import { AppError } from '../errors.js';
import { defaults } from '../bot/registry.js';
import { activeWorkspaceConfig } from './config.js';
import { memberOf, requireManager, requireModule, requireReviewer, requireStaff, selectedChannel } from './permissions.js';
import { WorkspaceStore } from './store.js';
import { memberSubmissionText, parseSourceField, submissionReceipt, validateSubmissionDraft, writeSubmissionRow } from './submissions.js';
import { applyReviewAction, reviewDetail } from './reviews.js';
import { recordDetail, requestCorrection } from './records.js';
import { createAndWriteTask, parseDueDate, taskText, updateAndWriteTask, writeTaskRow } from './tasks.js';
import { previewGuildStaff, staffText, syncGuildStaff } from './staff.js';
import { reportsPayload } from './reports.js';
import { embed } from '../ui/ui.js';
const base = { ...defaults, category: 'workspace', requiresAuthorization: true, access: 'member', responseKind: 'info', cooldown: 700, ephemeralDefault: true };
const modal = { ...base, deferral: 'modal' };
const action = { ...base, deferral: 'defer' };
function configAt(ctx, guildId, module) {
    const cfg = activeWorkspaceConfig(ctx.store, guildId);
    if (!cfg)
        throw new AppError('VALIDATION_ERROR', 'Workspace setup is incomplete in this guild. A manager must validate the workbook and publish the panels.');
    if (module)
        requireModule(cfg, module);
    return cfg;
}
function userButton(id, label, style = ButtonStyle.Secondary) { return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style); }
function sourceButton(url) { return new ButtonBuilder().setLabel('Open Source').setStyle(ButtonStyle.Link).setURL(url); }
function row(...buttons) { return new ActionRowBuilder().addComponents(...buttons); }
function noMentions() { return { parse: [] }; }
async function auditMessage(ctx, cfg, guildId, actorId, actionName, itemId, detail) {
    if (!cfg.channels.auditLogId)
        return;
    try {
        const channel = await selectedChannel(ctx.client.guilds.cache.get(guildId), cfg.channels.auditLogId, 'Workspace audit log');
        await channel.send({ embeds: [embed(`${cfg.branding.shortName} · Workspace audit`, `**Action:** ${actionName}\n**Item:** ${itemId || 'n/a'}\n**Actor:** <@${actorId}>\n${detail}`, cfg.branding.accentColor)], allowedMentions: noMentions() });
    }
    catch { /* audit delivery must never turn a completed data operation into a false failure */ }
}
function validStable(value) { return /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function pageNumber(value) { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 1000)
    throw new AppError('VALIDATION_ERROR', 'That page control is stale. Refresh the Workspace screen.'); return n; }
function field(i, id) { return String(i.fields.getTextInputValue(id) ?? '').trim(); }
function shorten(value, max = 900) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function homePayload(cfg, userId) {
    return { embeds: [embed(`${cfg.branding.shortName} · Workspace`, cfg.branding.staffPanelDescription, cfg.branding.primaryColor)], components: [row(userButton(`wsnav:home:${userId}`, 'Home', ButtonStyle.Primary))], allowedMentions: noMentions() };
}
function memberHelp(cfg) {
    const resources = [`Use **Submit** for a new entry and **My Submissions** for statuses visible to you.`, `Staff may request more information; unclear facts and sharing permission are kept as unconfirmed notes.`, `For help or private support, use the server’s existing support or ticket flow rather than opening a competing system.`, `Configured resources: Handbook, FAQ, information, chain-of-command, careers, links, and the server’s existing support entry point.`];
    if (cfg.channels.documentEntryId)
        resources.push(`Focused entry point: <#${cfg.channels.documentEntryId}>`);
    return { embeds: [embed(`${cfg.branding.shortName} · Help`, resources.join('\n\n'), cfg.branding.primaryColor)], components: [row(userButton('wsmember:mine', 'My Submissions'), userButton('wsnav:home:self', 'Home'))], allowedMentions: noMentions() };
}
function submissionModal(cfg, sessionId) {
    const f = cfg.forms.submission;
    const input = (id, label, style, required, max, placeholder) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder.slice(0, 100)));
    return new ModalBuilder().setCustomId(`wsmode:submission:${sessionId}`).setTitle(`${cfg.branding.shortName} · Submit`.slice(0, 45)).addComponents(input('title', f.titleLabel, TextInputStyle.Short, true, 200, 'Title as accurately as known'), input('source', f.sourceLabel, TextInputStyle.Paragraph, f.requireSource, 1000, 'Author / issuing organization and permitted link, if known'), input('metadata', `${f.dateLabel} and ${f.connectionLabel}`, TextInputStyle.Paragraph, f.requireConnection, 1200, 'Date if known; then explain the connection'), input('permission', f.permissionLabel, TextInputStyle.Paragraph, false, 1000, 'State what is known, unknown, or restricted'), input('notes', f.notesLabel, TextInputStyle.Paragraph, false, 2000, 'Missing pages, edits, estimates, or uncertainty'));
}
function taskModal(cfg, sessionId, editId) {
    const input = (id, label, style, required, max, placeholder) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder.slice(0, 100)));
    return new ModalBuilder().setCustomId(`wsmode:${editId ? 'taskedit' : 'task'}:${sessionId}`).setTitle(`${cfg.branding.shortName} · ${editId ? 'Edit task' : 'Create task'}`.slice(0, 45)).addComponents(input('description', 'Task description', TextInputStyle.Paragraph, true, 1200, 'What needs to be done'), input('owner', 'Owner user ID', TextInputStyle.Short, false, 20, 'Exact Discord user ID or blank'), input('due', 'Due date YYYY-MM-DD', TextInputStyle.Short, false, 10, 'Leave blank if no deadline'), input('priority', 'Priority', TextInputStyle.Short, true, 10, 'Normal, High, or Urgent'), input('notes', 'Notes and handover context', TextInputStyle.Paragraph, false, 1600, 'Blockers, revised instructions, or handover notes'));
}
function reviewModal(cfg, sessionId, reviewAction) {
    const input = (id, label, style, required, max, placeholder) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder.slice(0, 100)));
    if (reviewAction === 'assign')
        return new ModalBuilder().setCustomId(`wsmode:review:${sessionId}`).setTitle(`${cfg.branding.shortName} · Assign reviewer`.slice(0, 45)).addComponents(input('reviewer', 'Reviewer user ID', TextInputStyle.Short, true, 20, 'Exact Discord user ID'), input('notes', 'Staff notes', TextInputStyle.Paragraph, false, 1200, 'Optional assignment note'));
    if (reviewAction === 'accept' || reviewAction === 'restrict')
        return new ModalBuilder().setCustomId(`wsmode:review:${sessionId}`).setTitle(`${cfg.branding.shortName} · ${reviewAction}`.slice(0, 45)).addComponents(input('explanation', 'Explanation', TextInputStyle.Paragraph, true, 1600, 'Why this decision is authorized'), input('access', 'Access choice', TextInputStyle.Short, true, 20, 'Public, Restricted, or Staff only'), input('references', 'References and notes', TextInputStyle.Paragraph, false, 1200, 'Relevant source or internal reference'));
    return new ModalBuilder().setCustomId(`wsmode:review:${sessionId}`).setTitle(`${cfg.branding.shortName} · Review`.slice(0, 45)).addComponents(input('explanation', 'Explanation', TextInputStyle.Paragraph, true, 1600, 'Reason for the decision or information request'), input('references', 'References and notes', TextInputStyle.Paragraph, false, 1200, 'Relevant source or internal reference'));
}
function correctionModal(sessionId) {
    const input = (id, label, required, max, placeholder) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(max).setPlaceholder(placeholder));
    return new ModalBuilder().setCustomId(`wsmode:correction:${sessionId}`).setTitle('Workspace · Correction request').addComponents(input('issue', 'Reported issue', true, 1200, 'What is wrong?'), input('evidence', 'Supporting evidence', false, 1200, 'Links or evidence'), input('reference', 'Relevant reference', false, 500, 'Ticket, message, or other reference'));
}
function recordsPayload(store, cfg, guildId, userId, query = '') {
    const rows = store.records(guildId, query, 10);
    const text = rows.length ? rows.map(r => `**${r.record_id}** · ${r.title}\nAccess: ${r.access_level} · Status: ${r.record_status}`).join('\n\n') : query ? `No records matched **${query}**.` : 'No archive records have been linked yet.';
    const buttons = rows.slice(0, 5).map(r => userButton(`wsrecord:detail:${userId}:${r.record_id}`, String(r.record_id), ButtonStyle.Secondary));
    buttons.push(userButton('wsopen:recordsearch', 'Search', ButtonStyle.Primary), userButton(`wsnav:home:${userId}`, 'Home'));
    return { embeds: [embed(`${cfg.branding.shortName} · Records`, text, cfg.branding.primaryColor)], components: [row(...buttons.slice(0, 5)), row(...buttons.slice(5))].filter(r => r.components.length), allowedMentions: noMentions() };
}
function tasksPayload(store, cfg, guildId, userId, filter = 'open') {
    const rows = store.tasks(guildId, filter, userId, 10);
    const text = rows.length ? rows.map(taskText).join('\n\n') : `No ${filter === 'all' ? '' : filter + ' '}tasks found.`;
    const taskButtons = rows.slice(0, 5).map(r => userButton(`wstask:detail:${userId}:${r.task_id}`, String(r.task_id), ButtonStyle.Secondary));
    return { embeds: [embed(`${cfg.branding.shortName} · Tasks · ${filter}`, text, cfg.branding.primaryColor)], components: [row(userButton('wsopen:task', 'Create Task', ButtonStyle.Primary), userButton('wstask:open', 'Open'), userButton('wstask:blocked', 'Blocked'), userButton('wstask:overdue', 'Overdue')), taskButtons.length ? row(...taskButtons) : row(userButton(`wsnav:home:${userId}`, 'Home'))], allowedMentions: noMentions() };
}
function queuePayload(store, cfg, guildId, userId, page = 0) {
    const all = store.reviewQueue(guildId, undefined, undefined, 100);
    const slice = all.slice(page * 5, page * 5 + 5);
    const text = slice.length ? slice.map(r => `**${r.submission_id}** · ${r.title}\n<@${r.contributor_id}> · ${r.status} · Reviewer: ${r.assigned_reviewer ? `<@${r.assigned_reviewer}>` : 'Unassigned'}`).join('\n\n') : 'The review queue is empty.';
    const itemButtons = slice.map(r => userButton(`wsreview:detail:${userId}:${r.submission_id}`, String(r.submission_id), ButtonStyle.Secondary));
    const max = Math.max(0, Math.ceil(all.length / 5) - 1);
    return { embeds: [embed(`${cfg.branding.shortName} · Review Queue · ${Math.min(page, max) + 1}/${max + 1}`, text, cfg.branding.primaryColor)], components: [itemButtons.length ? row(...itemButtons) : row(userButton(`wsnav:home:${userId}`, 'Home')), row(userButton(`wsnav:queue:${userId}:${Math.max(0, page - 1)}`, 'Previous').setDisabled(page <= 0), userButton(`wsnav:queue:${userId}:${Math.min(max, page + 1)}`, 'Next').setDisabled(page >= max), userButton(`wsnav:home:${userId}`, 'Home'))], allowedMentions: noMentions() };
}
function reviewActions(cfg, submission, userId) {
    const buttons = [userButton(`wsopen:review:${submission.submission_id}:assign`, 'Assign Reviewer')];
    if (typeof submission.source_url === 'string' && /^https?:\/\//i.test(submission.source_url))
        buttons.push(sourceButton(submission.source_url));
    if (submission.status === 'Received')
        buttons.push(userButton(`wsreview:action:${userId}:${submission.submission_id}:begin`, 'Begin Review', ButtonStyle.Primary));
    if (!['Accepted', 'Restricted', 'Declined'].includes(String(submission.status))) {
        buttons.push(userButton(`wsopen:review:${submission.submission_id}:request`, 'Request Information'));
        buttons.push(userButton(`wsopen:review:${submission.submission_id}:accept`, 'Accept', ButtonStyle.Success));
        buttons.push(userButton(`wsopen:review:${submission.submission_id}:restrict`, 'Restrict', ButtonStyle.Danger));
        buttons.push(userButton(`wsopen:review:${submission.submission_id}:decline`, 'Decline', ButtonStyle.Danger));
    }
    buttons.push(userButton(`wsreview:back:${userId}`, 'Back'));
    return buttons;
}
function reviewPayload(store, cfg, guildId, userId, submissionId) {
    const submission = store.submission(guildId, submissionId);
    if (!submission)
        throw new AppError('VALIDATION_ERROR', 'That submission no longer exists. Refresh the queue.');
    const review = store.review(guildId, submissionId);
    const buttons = reviewActions(cfg, submission, userId);
    return { embeds: [embed(`${cfg.branding.shortName} · Review`, reviewDetail(submission, review), cfg.branding.primaryColor)], components: [row(...buttons.slice(0, 5)), row(...buttons.slice(5))], allowedMentions: noMentions() };
}
async function handleButton(ctx, i) {
    const guildId = i.guildId;
    const store = new WorkspaceStore(ctx.store);
    if (i.customId.startsWith('wsmember:')) {
        const cfg = configAt(ctx, guildId);
        const actionName = i.customId.slice('wsmember:'.length);
        if (actionName === 'mine') {
            requireModule(cfg, 'submissions');
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · My Submissions`, memberSubmissionText(store.submissionsByMember(guildId, i.user.id)), cfg.branding.primaryColor)], components: [row(userButton('wsmember:help', 'Help'), userButton('wsnav:home:self', 'Home'))], allowedMentions: noMentions() });
        }
        if (actionName === 'help')
            return i.editReply(memberHelp(cfg));
        throw new AppError('VALIDATION_ERROR', 'That member control is no longer available.');
    }
    if (i.customId.startsWith('wsstaff:')) {
        const cfg = configAt(ctx, guildId);
        const member = memberOf(i);
        const name = i.customId.slice('wsstaff:'.length);
        if (name === 'queue') {
            requireReviewer(member, cfg);
            requireModule(cfg, 'reviews');
            return i.editReply(queuePayload(store, cfg, guildId, i.user.id));
        }
        requireStaff(member, cfg);
        if (name === 'records') {
            requireModule(cfg, 'records');
            return i.editReply(recordsPayload(store, cfg, guildId, i.user.id));
        }
        if (name === 'tasks') {
            requireModule(cfg, 'tasks');
            return i.editReply(tasksPayload(store, cfg, guildId, i.user.id));
        }
        if (name === 'staff') {
            requireModule(cfg, 'staff');
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Staff`, staffText(store.staff(guildId)), cfg.branding.primaryColor)], components: [row(userButton('wsstaff:sync', 'Refresh Staff', ButtonStyle.Primary), userButton(`wsnav:home:${i.user.id}`, 'Home'))], allowedMentions: noMentions() });
        }
        if (name === 'sync') {
            requireManager(member, cfg);
            requireModule(cfg, 'staff');
            const preview = await previewGuildStaff(ctx.store, i.guild);
            const session = store.session(guildId, i.user.id, 'staff-sync', { changes: preview.changes.length });
            const summary = preview.changes.slice(0, 20).map(c => `${c.kind}: \`${c.userId}\``).join('\n') || 'No changes detected.';
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Preview staff changes`, `This is a preview only; no roster rows were changed.\n${summary}${preview.changes.length > 20 ? `\n…and ${preview.changes.length - 20} more.` : ''}`, cfg.branding.primaryColor)], components: [row(userButton(`wsconfirm:staff:${session.sessionId}`, 'Apply changes', ButtonStyle.Primary), userButton(`wscancel:${session.sessionId}`, 'Cancel'))], allowedMentions: noMentions() });
        }
        if (name === 'reports') {
            requireModule(cfg, 'reports');
            return i.editReply(reportsPayload(ctx.store, guildId));
        }
        if (name === 'settings') {
            requireManager(member, cfg);
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Settings`, `Modules: ${Object.entries(cfg.modules).filter(([, on]) => on).map(([key]) => key).join(', ') || 'none'}\nReviewer roles: ${cfg.roles.reviewerRoleIds.map(id => `<@&${id}>`).join(', ') || 'not configured'}\nManager roles: ${cfg.roles.managerRoleIds.map(id => `<@&${id}>`).join(', ') || 'not configured'}\nMember panel: ${cfg.channels.memberPanelId ? `<#${cfg.channels.memberPanelId}>` : 'not configured'}\nStaff panel: ${cfg.channels.staffPanelId ? `<#${cfg.channels.staffPanelId}>` : 'not configured'}\nReminders: ${cfg.reminders.enabled ? `enabled in ${cfg.reminders.timezone}` : 'disabled'}\n\nUse \/setup config workspace-setup to change configuration.`, cfg.branding.primaryColor)], components: [row(userButton(`wsnav:home:${i.user.id}`, 'Home'))], allowedMentions: noMentions() });
        }
        throw new AppError('VALIDATION_ERROR', 'That staff control is no longer available.');
    }
    if (i.customId.startsWith('wstask:')) {
        const cfg = configAt(ctx, guildId, 'tasks');
        requireStaff(memberOf(i), cfg);
        const name = i.customId.slice('wstask:'.length);
        if (name === 'open')
            return i.editReply(tasksPayload(store, cfg, guildId, i.user.id, 'open'));
        if (name === 'blocked')
            return i.editReply(tasksPayload(store, cfg, guildId, i.user.id, 'blocked'));
        if (name === 'overdue')
            return i.editReply(tasksPayload(store, cfg, guildId, i.user.id, 'overdue'));
        if (name.startsWith('detail:')) {
            const [userId, taskId] = name.slice('detail:'.length).split(':');
            if (userId !== i.user.id || !taskId || !validStable(taskId))
                throw new AppError('PERMISSION_ERROR', 'This task screen belongs to another user.');
            const task = store.task(guildId, taskId);
            if (!task)
                throw new AppError('VALIDATION_ERROR', 'That task no longer exists.');
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Task`, taskText(task), cfg.branding.primaryColor)], components: [row(userButton(`wsopen:taskedit:${taskId}`, 'Edit Task', ButtonStyle.Primary), userButton(`wstask:status:${i.user.id}:${taskId}:completed`, 'Complete', ButtonStyle.Success), userButton(`wstask:status:${i.user.id}:${taskId}:blocked`, 'Block', ButtonStyle.Danger)), row(userButton('wstask:open', 'Back'), userButton(`wsnav:home:${i.user.id}`, 'Home'))], allowedMentions: noMentions() });
        }
        if (name.startsWith('status:')) {
            const [userId, taskId, next] = name.slice('status:'.length).split(':');
            if (userId !== i.user.id || !taskId || !['completed', 'blocked', 'inprogress', 'cancelled'].includes(next))
                throw new AppError('VALIDATION_ERROR', 'That task control is stale.');
            const status = next === 'completed' ? 'Completed' : next === 'blocked' ? 'Blocked' : next === 'cancelled' ? 'Cancelled' : 'In progress';
            const result = await updateAndWriteTask(ctx.store, guildId, taskId, i.user.id, { status });
            return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Task updated`, taskText(result), cfg.branding.primaryColor)], components: [row(userButton('wstask:open', 'Back'), userButton(`wsnav:home:${i.user.id}`, 'Home'))], allowedMentions: noMentions() });
        }
    }
    if (i.customId.startsWith('wsrecord:')) {
        const cfg = configAt(ctx, guildId, 'records');
        requireStaff(memberOf(i), cfg);
        const parts = i.customId.split(':');
        if (parts.length !== 4 || parts[2] !== i.user.id || !validStable(parts[3]))
            throw new AppError('PERMISSION_ERROR', 'This record screen belongs to another user.');
        const record = store.record(guildId, parts[3]);
        if (!record)
            throw new AppError('VALIDATION_ERROR', 'That Record ID no longer exists.');
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Record`, recordDetail(record), cfg.branding.primaryColor)], components: [row(userButton(`wsopen:correction:${record.record_id}`, 'Request Correction', ButtonStyle.Secondary), userButton('wsstaff:records', 'Back'), userButton(`wsnav:home:${i.user.id}`, 'Home'))], allowedMentions: noMentions() });
    }
    if (i.customId.startsWith('wsreview:')) {
        const cfg = configAt(ctx, guildId, 'reviews');
        requireReviewer(memberOf(i), cfg);
        const parts = i.customId.split(':');
        const name = parts[1];
        if (name === 'detail') {
            if (parts[2] !== i.user.id || !parts[3] || !validStable(parts[3]))
                throw new AppError('PERMISSION_ERROR', 'This review screen belongs to another user.');
            return i.editReply(reviewPayload(store, cfg, guildId, i.user.id, parts[3]));
        }
        if (name === 'back')
            return i.editReply(queuePayload(store, cfg, guildId, i.user.id, 0));
        if (name === 'action') {
            if (parts[2] !== i.user.id || !parts[3] || parts[4] !== 'begin')
                throw new AppError('VALIDATION_ERROR', 'That review action is stale.');
            const result = await applyReviewAction(ctx.store, guildId, parts[3], i.user.id, 'begin', 'Review begun.');
            return i.editReply(reviewPayload(store, cfg, guildId, i.user.id, result.submission.submission_id));
        }
    }
    if (i.customId.startsWith('wsnav:')) {
        const parts = i.customId.split(':');
        const name = parts[1];
        if (name !== 'home' && parts[2] !== i.user.id && parts[2] !== 'self')
            throw new AppError('PERMISSION_ERROR', 'This navigation control belongs to another user.');
        const cfg = configAt(ctx, guildId);
        if (name === 'home')
            return i.editReply(homePayload(cfg, i.user.id));
        if (name === 'queue') {
            requireReviewer(memberOf(i), cfg);
            return i.editReply(queuePayload(store, cfg, guildId, i.user.id, pageNumber(parts[3] ?? '0')));
        }
    }
    if (i.customId.startsWith('wsconfirm:') || i.customId.startsWith('wscancel:'))
        return handleConfirmation(ctx, i);
    throw new AppError('VALIDATION_ERROR', 'This Workspace control is no longer available. Refresh the panel or open it again.');
}
async function handleOpen(ctx, i) {
    const guildId = i.guildId;
    const ws = new WorkspaceStore(ctx.store);
    const cfg = configAt(ctx, guildId);
    const parts = i.customId.split(':');
    const kind = parts[1];
    if (kind === 'submission') {
        requireModule(cfg, 'submissions');
        const session = ws.session(guildId, i.user.id, 'submission-draft', { reference: i.message?.id ?? i.channelId ?? null });
        return i.showModal(submissionModal(cfg, session.sessionId));
    }
    if (kind === 'task') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'tasks');
        const session = ws.session(guildId, i.user.id, 'task-draft', {});
        return i.showModal(taskModal(cfg, session.sessionId));
    }
    if (kind === 'taskedit') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'tasks');
        const taskId = parts[2];
        if (!taskId || !validStable(taskId))
            throw new AppError('VALIDATION_ERROR', 'That task control is stale.');
        const session = ws.session(guildId, i.user.id, 'task-edit', { taskId });
        return i.showModal(taskModal(cfg, session.sessionId, taskId));
    }
    if (kind === 'review') {
        requireReviewer(memberOf(i), cfg);
        requireModule(cfg, 'reviews');
        const submissionId = parts[2];
        const reviewAction = parts[3];
        if (!submissionId || !reviewAction || !validStable(submissionId) || !['assign', 'request', 'accept', 'restrict', 'decline'].includes(reviewAction))
            throw new AppError('VALIDATION_ERROR', 'That review control is stale.');
        const submission = ws.submission(guildId, submissionId);
        if (!submission)
            throw new AppError('VALIDATION_ERROR', 'That submission no longer exists.');
        const session = ws.session(guildId, i.user.id, 'review-draft', { submissionId, reviewAction });
        return i.showModal(reviewModal(cfg, session.sessionId, reviewAction));
    }
    if (kind === 'correction') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'records');
        const recordId = parts[2];
        if (!recordId || !validStable(recordId))
            throw new AppError('VALIDATION_ERROR', 'That record control is stale.');
        if (!ws.record(guildId, recordId))
            throw new AppError('VALIDATION_ERROR', 'That record no longer exists.');
        const session = ws.session(guildId, i.user.id, 'correction-draft', { recordId });
        return i.showModal(correctionModal(session.sessionId));
    }
    if (kind === 'recordsearch') {
        requireStaff(memberOf(i), cfg);
        const session = ws.session(guildId, i.user.id, 'record-search', {});
        const m = new ModalBuilder().setCustomId(`wsmode:recordsearch:${session.sessionId}`).setTitle('Workspace · Search records').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Record ID or title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)));
        return i.showModal(m);
    }
    throw new AppError('VALIDATION_ERROR', 'That Workspace form is no longer available.');
}
async function handleModal(ctx, i) {
    const guildId = i.guildId;
    const ws = new WorkspaceStore(ctx.store);
    const cfg = configAt(ctx, guildId);
    const parts = i.customId.split(':');
    const kind = parts[1];
    const sessionId = parts[2];
    if (!sessionId || !validStable(sessionId))
        throw new AppError('VALIDATION_ERROR', 'This Workspace form expired. Open it again.');
    if (kind === 'submission') {
        requireModule(cfg, 'submissions');
        const session = ws.getSession(guildId, sessionId, i.user.id, 'submission-draft');
        if (!session)
            throw new AppError('VALIDATION_ERROR', 'This submission form expired. Open Submit again.');
        const source = parseSourceField(field(i, 'source'));
        const metadata = field(i, 'metadata');
        const lines = metadata.split(/\r?\n/);
        const draft = { title: field(i, 'title'), author: source.author, sourceUrl: source.sourceUrl, documentDate: lines[0] ?? '', connection: lines.slice(1).join(' ').trim(), sharingPermission: field(i, 'permission'), restrictions: '', notes: field(i, 'notes') };
        const errors = validateSubmissionDraft(draft, { source: cfg.forms.submission.requireSource, connection: cfg.forms.submission.requireConnection });
        if (errors.length)
            throw new AppError('VALIDATION_ERROR', errors.join('\n'));
        ws.updateSession(session, { draft });
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Confirm submission`, [`**Title:** ${draft.title}`, `**Author:** ${draft.author || 'Not provided'}`, `**Source:** ${draft.sourceUrl || 'Not provided'}`, `**Date:** ${draft.documentDate || 'Unknown'}`, `**Connection:** ${draft.connection || 'Not provided'}`, `**Permission:** ${draft.sharingPermission || 'Unknown — not confirmed'}`, `**Notes:** ${shorten(draft.notes || 'None')}`, '', 'Confirming will create a Submission Reviews row.'].join('\n'), cfg.branding.primaryColor)], components: [row(userButton(`wsconfirm:submission:${sessionId}`, 'Confirm submission', ButtonStyle.Primary), userButton(`wscancel:${sessionId}`, 'Cancel'))], allowedMentions: noMentions() });
    }
    if (kind === 'task' || kind === 'taskedit') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'tasks');
        const session = ws.getSession(guildId, sessionId, i.user.id, kind === 'task' ? 'task-draft' : 'task-edit');
        if (!session)
            throw new AppError('VALIDATION_ERROR', 'This task form expired. Open it again.');
        const priority = field(i, 'priority');
        if (!['Normal', 'High', 'Urgent'].includes(priority))
            throw new AppError('VALIDATION_ERROR', 'Priority must be Normal, High, or Urgent.');
        parseDueDate(field(i, 'due'));
        const draft = { description: field(i, 'description'), ownerId: field(i, 'owner'), dueDate: field(i, 'due'), priority: priority, notes: field(i, 'notes') };
        if (!draft.description)
            throw new AppError('VALIDATION_ERROR', 'A task description is required.');
        ws.updateSession(session, { ...session.data, draft });
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Confirm task`, [`**Description:** ${draft.description}`, `**Owner:** ${draft.ownerId || 'Unassigned'}`, `**Due:** ${draft.dueDate || 'No deadline'}`, `**Priority:** ${draft.priority}`, `**Notes:** ${shorten(draft.notes || 'None')}`, '', 'Confirming writes the Directive Tracker row.'].join('\n'), cfg.branding.primaryColor)], components: [row(userButton(`wsconfirm:${kind}:${sessionId}`, editSessionLabel(kind), ButtonStyle.Primary), userButton(`wscancel:${sessionId}`, 'Cancel'))], allowedMentions: noMentions() });
    }
    if (kind === 'review') {
        requireReviewer(memberOf(i), cfg);
        requireModule(cfg, 'reviews');
        const session = ws.getSession(guildId, sessionId, i.user.id, 'review-draft');
        if (!session)
            throw new AppError('VALIDATION_ERROR', 'This review form expired. Refresh the review.');
        const data = { ...session.data, explanation: field(i, 'explanation'), access: field(i, 'access'), references: field(i, 'references'), reviewer: field(i, 'reviewer'), notes: field(i, 'notes') };
        if (session.data.reviewAction === 'assign' && !/^\d{17,20}$/.test(data.reviewer))
            throw new AppError('VALIDATION_ERROR', 'Reviewer must be an exact Discord user ID.');
        if (['accept', 'restrict'].includes(session.data.reviewAction) && !cfg.review.accessChoices.includes(data.access))
            throw new AppError('VALIDATION_ERROR', `Access must be one of: ${cfg.review.accessChoices.join(', ')}.`);
        if (!data.explanation && session.data.reviewAction !== 'assign')
            throw new AppError('VALIDATION_ERROR', 'An explanation is required.');
        ws.updateSession(session, data);
        const summary = [`**Submission:** ${session.data.submissionId}`, `**Action:** ${session.data.reviewAction}`, data.reviewer ? `**Reviewer:** <@${data.reviewer}>` : '', data.access ? `**Access:** ${data.access}` : '', `**Explanation:** ${shorten(data.explanation || data.notes || 'None')}`, data.references ? `**References:** ${shorten(data.references)}` : '', '', 'This is a confirmation step for a staff decision.'].filter(Boolean).join('\n');
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Confirm review action`, summary, cfg.branding.primaryColor)], components: [row(userButton(`wsconfirm:review:${sessionId}`, 'Confirm review action', ButtonStyle.Primary), userButton(`wscancel:${sessionId}`, 'Cancel'))], allowedMentions: noMentions() });
    }
    if (kind === 'correction') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'records');
        const session = ws.getSession(guildId, sessionId, i.user.id, 'correction-draft');
        if (!session)
            throw new AppError('VALIDATION_ERROR', 'This correction form expired.');
        const data = { ...session.data, issue: field(i, 'issue'), evidence: field(i, 'evidence'), reference: field(i, 'reference') };
        ws.updateSession(session, data);
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Confirm correction request`, `**Record:** ${data.recordId}\n**Issue:** ${shorten(data.issue)}\n**Evidence:** ${shorten(data.evidence || 'None')}\n**Reference:** ${shorten(data.reference || 'None')}`, cfg.branding.primaryColor)], components: [row(userButton(`wsconfirm:correction:${sessionId}`, 'Submit correction request', ButtonStyle.Primary), userButton(`wscancel:${sessionId}`, 'Cancel'))], allowedMentions: noMentions() });
    }
    if (kind === 'recordsearch') {
        requireStaff(memberOf(i), cfg);
        const session = ws.getSession(guildId, sessionId, i.user.id, 'record-search');
        if (!session)
            throw new AppError('VALIDATION_ERROR', 'This search form expired.');
        const query = field(i, 'query');
        ws.deleteSession(guildId, sessionId);
        return i.editReply(recordsPayload(ws, cfg, guildId, i.user.id, query));
    }
    throw new AppError('VALIDATION_ERROR', 'That Workspace form is no longer available.');
}
function editSessionLabel(kind) { return kind === 'taskedit' ? 'Confirm task changes' : 'Create task'; }
async function handleConfirmation(ctx, i) {
    const guildId = i.guildId;
    const ws = new WorkspaceStore(ctx.store);
    const parts = i.customId.startsWith('wscancel:') ? ['cancel', partsSafe(i.customId.slice('wscancel:'.length))] : i.customId.slice('wsconfirm:'.length).split(':');
    if (i.customId.startsWith('wscancel:')) {
        const sessionId = parts[1];
        if (!validStable(sessionId))
            throw new AppError('VALIDATION_ERROR', 'This cancellation is stale.');
        ws.deleteSession(guildId, sessionId);
        return i.editReply({ content: 'Workspace action cancelled. No external write was made.', embeds: [], components: [], allowedMentions: noMentions() });
    }
    const kind = parts[0];
    const sessionId = parts[1];
    if (!validStable(sessionId))
        throw new AppError('VALIDATION_ERROR', 'This confirmation is stale.');
    const session = ws.getSession(guildId, sessionId, i.user.id);
    if (!session)
        throw new AppError('VALIDATION_ERROR', 'This confirmation expired. Refresh the Workspace screen and try again.');
    const cfg = configAt(ctx, guildId);
    if (kind === 'staff') {
        requireManager(memberOf(i), cfg);
        requireModule(cfg, 'staff');
        const result = await syncGuildStaff(ctx.store, i.guild, i.user.id);
        ws.deleteSession(guildId, sessionId);
        await auditMessage(ctx, cfg, guildId, i.user.id, 'staff synchronized', '', `Rows applied: ${result.applied}`);
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Staff synchronized`, `Applied ${result.applied} rows after confirmation.\n${result.changes.slice(0, 20).map(c => `${c.kind}: ${c.userId}`).join('\n') || 'No changes detected.'}`, cfg.branding.primaryColor)], components: [rowButton(`wsnav:home:${i.user.id}`, 'Home')], allowedMentions: noMentions() });
    }
    if (kind === 'submission') {
        requireModule(cfg, 'submissions');
        let row;
        const draft = session.data.draft;
        if (!draft)
            throw new AppError('VALIDATION_ERROR', 'Submission draft is missing.');
        const existingId = session.data.submissionId;
        if (existingId)
            row = ws.submission(guildId, existingId);
        if (!row) {
            row = ws.createSubmission(guildId, i.user.id, i.user.username, draft, session.data.reference ?? i.message?.id ?? null);
            ws.updateSession(session, { ...session.data, submissionId: row.submission_id });
        }
        const sheetRow = await writeSubmissionRow(cfg, row, undefined);
        ctx.store.run('UPDATE workspace_submissions SET sheet_row=?,last_error=NULL,updated_at=? WHERE guild_id=? AND submission_id=?', sheetRow, Date.now(), guildId, row.submission_id);
        ws.deleteSession(guildId, sessionId);
        ws.audit(guildId, i.user.id, 'submission/confirmed', String(row.submission_id), 'Receipt issued after Sheet write.');
        await auditMessage(ctx, cfg, guildId, i.user.id, 'submission received', String(row.submission_id), `Status: Received`);
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Submission received`, submissionReceipt(ctx.store.get('SELECT * FROM workspace_submissions WHERE guild_id=? AND submission_id=?', guildId, row.submission_id)), cfg.branding.primaryColor)], components: [rowButton(`wsmember:mine`, 'My Submissions'), rowButton(`wsnav:home:${i.user.id}`, 'Home')], allowedMentions: noMentions() });
    }
    if (kind === 'task' || kind === 'taskedit') {
        requireStaff(memberOf(i), cfg);
        requireModule(cfg, 'tasks');
        const draft = session.data.draft;
        if (!draft)
            throw new AppError('VALIDATION_ERROR', 'Task draft is missing.');
        let task;
        if (kind === 'taskedit') {
            task = await updateAndWriteTask(ctx.store, guildId, String(session.data.taskId), i.user.id, { ownerId: draft.ownerId || null, dueAt: parseDueDate(draft.dueDate), priority: draft.priority, notes: draft.notes });
        }
        else {
            const existing = ctx.store.get('SELECT * FROM workspace_tasks WHERE guild_id=? AND issued_by=? AND description=? AND sheet_row IS NULL ORDER BY issued_at DESC LIMIT 1', guildId, i.user.id, draft.description);
            if (existing) {
                const sheetRow = await writeTaskRow(cfg, existing);
                ctx.store.run('UPDATE workspace_tasks SET sheet_row=?,updated_at=? WHERE guild_id=? AND task_id=?', sheetRow, Date.now(), guildId, existing.task_id);
                task = ctx.store.get('SELECT * FROM workspace_tasks WHERE guild_id=? AND task_id=?', guildId, existing.task_id);
            }
            else
                task = await createAndWriteTask(ctx.store, guildId, i.user.id, draft);
        }
        ws.deleteSession(guildId, sessionId);
        await auditMessage(ctx, cfg, guildId, i.user.id, kind === 'taskedit' ? 'task updated' : 'task created', String(task.task_id), `Status: ${task.status}`);
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Task saved`, taskText(task), cfg.branding.primaryColor)], components: [rowButton('wstask:open', 'Open Tasks'), rowButton(`wsnav:home:${i.user.id}`, 'Home')], allowedMentions: noMentions() });
    }
    if (kind === 'review') {
        requireReviewer(memberOf(i), cfg);
        requireModule(cfg, 'reviews');
        const data = session.data;
        const reviewAction = data.reviewAction;
        const result = await applyReviewAction(ctx.store, guildId, String(data.submissionId), i.user.id, reviewAction, [data.explanation, data.references, data.notes].filter(Boolean).join('\n'), data.access || undefined, undefined, data.reviewer || i.user.id);
        ws.deleteSession(guildId, sessionId);
        await auditMessage(ctx, cfg, guildId, i.user.id, `review ${reviewAction}`, String(result.submission.submission_id), `Status: ${result.submission.status}${result.record ? ` · Record: ${result.record.record_id}` : ''}`);
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Review updated`, reviewDetail(result.submission, ws.review(guildId, result.submission.submission_id)), cfg.branding.primaryColor)], components: [rowButton(`wsreview:back:${i.user.id}`, 'Back to queue'), rowButton(`wsnav:home:${i.user.id}`, 'Home')], allowedMentions: noMentions() });
    }
    if (kind === 'correction') {
        requireStaff(memberOf(i), cfg);
        const data = session.data;
        const record = await requestCorrection(ctx.store, guildId, String(data.recordId), i.user.id, String(data.issue), String(data.evidence ?? ''), String(data.reference ?? ''));
        ws.deleteSession(guildId, sessionId);
        await auditMessage(ctx, cfg, guildId, i.user.id, 'correction requested', String(data.recordId), 'Original record preserved; correction history appended.');
        return i.editReply({ embeds: [embed(`${cfg.branding.shortName} · Correction request recorded`, recordDetail(record), cfg.branding.primaryColor)], components: [rowButton('wsstaff:records', 'Back to records'), rowButton(`wsnav:home:${i.user.id}`, 'Home')], allowedMentions: noMentions() });
    }
    throw new AppError('VALIDATION_ERROR', 'That Workspace confirmation is no longer available.');
}
function rowButton(id, label, style = ButtonStyle.Secondary) { return row(userButton(id, label, style)); }
function partsSafe(value) { return value; }
export function registerWorkspaceControls(registry) {
    registry.component({ prefix: 'wsmember:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wsstaff:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wstask:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wsrecord:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wsreview:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wsnav:', kinds: ['button'], metadata: action, execute: handleButton });
    registry.component({ prefix: 'wsconfirm:', kinds: ['button'], metadata: action, execute: handleConfirmation });
    registry.component({ prefix: 'wscancel:', kinds: ['button'], metadata: action, execute: handleConfirmation });
    registry.component({ prefix: 'wsopen:', kinds: ['button'], metadata: modal, execute: handleOpen });
    registry.component({ prefix: 'wsmode:', kinds: ['modal'], metadata: action, execute: handleModal });
}
