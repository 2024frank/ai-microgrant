import nodemailer from 'nodemailer';

// Lazy init — transporter is reused across calls.
let _transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    const port = parseInt(process.env.SMTP_PORT || '465');
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.hostinger.com',
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const LOGO_URL = `${APP_URL}/logo.png`;
const FROM = `AI Calendar by CommunityHub <${process.env.SMTP_USER || 'eve@communityhub.cloud'}>`;

const COLORS = {
  ink: '#212934',
  body: '#4a4e57',
  muted: '#7a7f88',
  border: '#dcdee1',
  surface: '#f6f7f9',
  green: '#34724a',
  greenSoft: '#f1faf3',
  amber: '#8d4d0a',
  amberSoft: '#fff8eb',
  red: '#9d3029',
} as const;

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function brandHeader(context: string): string {
  return `<tr>
    <td style="padding:22px 30px;border-bottom:1px solid ${COLORS.border};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="52" valign="middle">
            <img src="${LOGO_URL}" width="42" height="42" alt="CommunityHub AI Calendar" style="display:block;width:42px;height:42px;border:0;" />
          </td>
          <td valign="middle">
            <div style="font-size:16px;line-height:20px;font-weight:700;color:${COLORS.ink};">AI Calendar</div>
            <div style="margin-top:2px;font-size:12px;line-height:17px;color:${COLORS.muted};">CommunityHub · ${escapeHtml(context)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function emailShell(opts: { context: string; preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>AI Calendar · ${escapeHtml(opts.context)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.surface};font-family:Arial,'Helvetica Neue',sans-serif;color:${COLORS.ink};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${COLORS.surface};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${COLORS.border};border-radius:6px;">
          ${brandHeader(opts.context)}
          <tr><td style="padding:30px;">${opts.body}</td></tr>
          <tr>
            <td style="padding:18px 30px;border-top:1px solid ${COLORS.border};font-size:11px;line-height:17px;color:${COLORS.muted};">
              AI Calendar · CommunityHub<br />Oberlin, Ohio
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function sectionLabel(label: string): string {
  return `<p style="margin:26px 0 9px;font-size:13px;line-height:18px;font-weight:700;color:${COLORS.ink};">${escapeHtml(label)}</p>`;
}

function primaryButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 2px;">
    <tr><td bgcolor="${COLORS.green}" style="border-radius:4px;">
      <a href="${href}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-size:14px;line-height:18px;font-weight:700;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

export async function sendReviewNotification(opts: {
  reviewerEmail: string;
  reviewerName: string;
  pendingCount: number;
  sources: { name: string; count: number; pending?: number }[];
  oldestDate: string | null;
  previewEvents?: { title: string; source: string }[];
}) {
  const { reviewerEmail, reviewerName, pendingCount, sources, oldestDate, previewEvents = [] } = opts;
  const newCount = sources.reduce((sum, source) => sum + source.count, 0);
  const sourcePart = sources.length === 1
    ? `from ${sources[0].name}`
    : `from ${sources.length} sources`;
  const subject = `${newCount} new event${newCount !== 1 ? 's' : ''} ${sourcePart} need${newCount === 1 ? 's' : ''} your review`;

  const preview = previewEvents.slice(0, 5);
  const previewSection = preview.length > 0 ? `
    ${sectionLabel('New events')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${COLORS.border};">
      ${preview.map(event => `<tr>
        <td style="padding:11px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;line-height:20px;color:${COLORS.ink};">${escapeHtml(event.title)}</td>
        <td align="right" style="padding:11px 0 11px 16px;border-bottom:1px solid ${COLORS.border};font-size:12px;line-height:18px;color:${COLORS.muted};white-space:nowrap;">${escapeHtml(event.source)}</td>
      </tr>`).join('')}
    </table>
    ${previewEvents.length > 5 ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${COLORS.muted};">+ ${previewEvents.length - 5} more</p>` : ''}` : '';

  const sourceRows = sources.map(source => {
    const alreadyWaiting = source.pending != null ? Math.max(0, source.pending - source.count) : 0;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${COLORS.border};font-size:13px;line-height:19px;color:${COLORS.body};">${escapeHtml(source.name)}</td>
      <td align="right" style="padding:10px 0 10px 16px;border-bottom:1px solid ${COLORS.border};font-size:13px;line-height:19px;color:${COLORS.ink};white-space:nowrap;"><strong>${source.count} new</strong>${alreadyWaiting ? `<br /><span style="font-size:11px;color:${COLORS.muted};">${alreadyWaiting} already waiting</span>` : ''}</td>
    </tr>`;
  }).join('');

  const queueNote = pendingCount > newCount
    ? `<p style="margin:20px 0 0;font-size:13px;line-height:20px;color:${COLORS.body};"><strong style="color:${COLORS.ink};">${pendingCount} event${pendingCount !== 1 ? 's' : ''}</strong> are currently awaiting review.</p>`
    : '';
  const oldestNote = oldestDate
    ? `<p style="margin:18px 0 0;padding:11px 13px;border-left:3px solid ${COLORS.amber};background:${COLORS.amberSoft};font-size:12px;line-height:18px;color:${COLORS.amber};">Oldest pending event received ${escapeHtml(oldestDate)}.</p>`
    : '';

  const html = emailShell({
    context: 'Event review',
    preheader: subject,
    body: `
      <h1 style="margin:0 0 18px;font-size:24px;line-height:31px;font-weight:700;color:${COLORS.ink};">Events are ready for review</h1>
      <p style="margin:0 0 8px;font-size:15px;line-height:23px;color:${COLORS.ink};">Hi ${escapeHtml(reviewerName)},</p>
      <p style="margin:0;font-size:14px;line-height:22px;color:${COLORS.body};">${newCount} new event${newCount !== 1 ? 's' : ''} ${newCount === 1 ? 'has' : 'have'} arrived ${escapeHtml(sourcePart)}.</p>
      ${previewSection}
      ${sources.length > 0 ? `${sectionLabel('By source')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${COLORS.border};">${sourceRows}</table>` : ''}
      ${queueNote}
      ${oldestNote}
      ${primaryButton(`${APP_URL}/reviewer/queue`, 'Open review queue')}
    `,
  });

  return getTransporter().sendMail({
    from: FROM,
    to: reviewerEmail,
    subject,
    html,
    text: `Hi ${reviewerName},\n\n${newCount} new event${newCount !== 1 ? 's' : ''} ${newCount === 1 ? 'has' : 'have'} arrived ${sourcePart}.\n\nOpen the review queue: ${APP_URL}/reviewer/queue`,
  });
}

export async function sendWelcomeEmail(opts: { email: string; name: string; role: string; pendingCount?: number }) {
  const { email, name, role, pendingCount = 0 } = opts;
  const isReviewer = role === 'reviewer';

  const queueSection = pendingCount > 0 ? `
    <p style="margin:22px 0 0;padding:13px 15px;background:${COLORS.greenSoft};border-left:3px solid ${COLORS.green};font-size:13px;line-height:20px;color:${COLORS.body};">
      <strong style="color:${COLORS.green};">${pendingCount} event${pendingCount !== 1 ? 's' : ''}</strong> ${pendingCount === 1 ? 'is' : 'are'} waiting for review.
    </p>` : '';

  const reviewerActions = `${primaryButton(`${APP_URL}/reviewer/queue`, 'Open review queue')}
    <p style="margin:12px 0 0;font-size:13px;line-height:19px;"><a href="${APP_URL}/reviewer/dashboard" style="color:${COLORS.green};text-decoration:underline;">View your dashboard</a></p>`;
  const adminActions = primaryButton(`${APP_URL}/admin/stats`, 'Open dashboard');

  const html = emailShell({
    context: 'Welcome',
    preheader: `Your ${role} access is ready.`,
    body: `
      <h1 style="margin:0 0 18px;font-size:24px;line-height:31px;font-weight:700;color:${COLORS.ink};">Welcome to AI Calendar</h1>
      <p style="margin:0 0 8px;font-size:15px;line-height:23px;color:${COLORS.ink};">Hi ${escapeHtml(name)},</p>
      <p style="margin:0;font-size:14px;line-height:22px;color:${COLORS.body};">You now have <strong>${escapeHtml(role)}</strong> access. Sign in with Google to get started.</p>
      ${queueSection}
      ${sectionLabel('What you can do')}
      <ul style="margin:0;padding:0 0 0 20px;color:${COLORS.body};font-size:13px;line-height:21px;">
        <li style="margin:0 0 6px;">Review incoming events and approve or reject them.</li>
        <li style="margin:0 0 6px;">Edit event details before publishing.</li>
        <li style="margin:0 0 6px;">Return an event for correction with a note.</li>
        <li style="margin:0;">Receive review notifications when new events arrive.</li>
      </ul>
      ${isReviewer ? reviewerActions : adminActions}
    `,
  });

  const subject = `Welcome to AI Calendar — ${role} access`;
  const destination = isReviewer ? `${APP_URL}/reviewer/queue` : `${APP_URL}/admin/stats`;
  return getTransporter().sendMail({
    from: FROM,
    to: email,
    subject,
    html,
    text: `Hi ${name},\n\nYou now have ${role} access to AI Calendar by CommunityHub. Sign in with Google to get started.\n\n${destination}`,
  });
}

export async function sendAgentRunSummary(opts: {
  adminEmail: string;
  results: { source: string; status: string; inserted: number; error?: string }[];
  totalNew: number;
}) {
  const { adminEmail, results, totalNew } = opts;
  const runDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const rows = results.map(result => {
    const ok = result.status === 'ok';
    return `<tr>
      <td style="padding:11px 0;border-bottom:1px solid ${COLORS.border};font-size:13px;line-height:19px;color:${COLORS.ink};">${escapeHtml(result.source)}</td>
      <td style="padding:11px 12px;border-bottom:1px solid ${COLORS.border};font-size:12px;line-height:18px;font-weight:700;color:${ok ? COLORS.green : COLORS.red};">${ok ? 'Complete' : escapeHtml(result.status)}</td>
      <td align="right" style="padding:11px 0;border-bottom:1px solid ${COLORS.border};font-size:13px;line-height:19px;color:${COLORS.ink};">${result.inserted ?? 0}</td>
    </tr>
    ${result.error ? `<tr><td colspan="3" style="padding:8px 0 11px;border-bottom:1px solid ${COLORS.border};font-size:12px;line-height:18px;color:${COLORS.red};">${escapeHtml(result.error)}</td></tr>` : ''}`;
  }).join('');

  const html = emailShell({
    context: 'Import summary',
    preheader: `${totalNew} new event${totalNew !== 1 ? 's' : ''} added to the review queue.`,
    body: `
      <p style="margin:0 0 8px;font-size:12px;line-height:18px;color:${COLORS.muted};">${escapeHtml(runDate)}</p>
      <h1 style="margin:0 0 12px;font-size:24px;line-height:31px;font-weight:700;color:${COLORS.ink};">Import summary</h1>
      <p style="margin:0;font-size:14px;line-height:22px;color:${COLORS.body};"><strong style="color:${COLORS.ink};">${totalNew} new event${totalNew !== 1 ? 's' : ''}</strong> ${totalNew === 1 ? 'was' : 'were'} added to the review queue.</p>
      ${sectionLabel('Source results')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${COLORS.border};">
        <tr>
          <th align="left" style="padding:9px 0;border-bottom:1px solid ${COLORS.border};font-size:11px;line-height:17px;color:${COLORS.muted};font-weight:700;">Source</th>
          <th align="left" style="padding:9px 12px;border-bottom:1px solid ${COLORS.border};font-size:11px;line-height:17px;color:${COLORS.muted};font-weight:700;">Status</th>
          <th align="right" style="padding:9px 0;border-bottom:1px solid ${COLORS.border};font-size:11px;line-height:17px;color:${COLORS.muted};font-weight:700;">Added</th>
        </tr>
        ${rows}
      </table>
      ${primaryButton(`${APP_URL}/admin/stats`, 'View dashboard')}
    `,
  });

  return getTransporter().sendMail({
    from: FROM,
    to: adminEmail,
    subject: `Import summary: ${totalNew} new event${totalNew !== 1 ? 's' : ''} ready for review`,
    html,
    text: `${runDate}\n\n${totalNew} new event${totalNew !== 1 ? 's' : ''} ${totalNew === 1 ? 'was' : 'were'} added to the review queue.\n\nView the dashboard: ${APP_URL}/admin/stats`,
  });
}
