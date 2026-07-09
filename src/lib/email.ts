import nodemailer from 'nodemailer';

// Lazy init — transporter is reused across calls
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

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const FROM    = `AI Events Ingestion Software <${process.env.SMTP_USER || 'eve@communityhub.cloud'}>`;

export async function sendReviewNotification(opts: {
  reviewerEmail:  string;
  reviewerName:   string;
  pendingCount:   number;
  sources:        { name: string; count: number; pending?: number }[];
  oldestDate:     string | null;
  previewEvents?: { title: string; source: string }[];
}) {
  const { reviewerEmail, reviewerName, pendingCount, sources, oldestDate, previewEvents = [] } = opts;

  // Subject: "3 new events from Apollo Theatre need your review"
  //       or "12 new events from 3 sources need your review"
  const newCount   = sources.reduce((s, r) => s + r.count, 0);
  const sourcePart = sources.length === 1
    ? `from ${sources[0].name}`
    : `from ${sources.length} sources`;
  const subject = `${newCount} new event${newCount !== 1 ? 's' : ''} ${sourcePart} need${newCount === 1 ? 's' : ''} your review`;

  // Source breakdown rows — show "X new" and, if there's a backlog, "+ Y already waiting"
  const sourceRows = sources
    .map(s => {
      const alreadyWaiting = s.pending != null ? Math.max(0, s.pending - s.count) : null;
      return `<tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#444;">${s.name}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;">
          <span style="font-weight:700;color:#3a8c3f;">${s.count} new</span>${alreadyWaiting ? `<span style="color:#bbb;font-size:12px;margin-left:8px;">+ ${alreadyWaiting} already waiting</span>` : ''}
        </td>
      </tr>`;
    }).join('');

  // Event preview rows — show up to 5 titles
  const preview = previewEvents.slice(0, 5);
  const previewSection = preview.length > 0 ? `
  <p style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">What came in</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:8px;">
    ${preview.map((e, i) => `<tr style="background:${i % 2 === 0 ? 'white' : '#fafafa'};">
      <td style="padding:9px 12px;font-size:13px;color:#333;border-bottom:1px solid #f5f5f5;">${e.title}</td>
      <td style="padding:9px 12px;font-size:11px;color:#aaa;text-align:right;border-bottom:1px solid #f5f5f5;white-space:nowrap;">${e.source}</td>
    </tr>`).join('')}
  </table>
  ${previewEvents.length > 5
    ? `<p style="font-size:12px;color:#aaa;margin:0 0 20px;text-align:right;">+ ${previewEvents.length - 5} more</p>`
    : `<div style="margin-bottom:20px;"></div>`
  }` : '';

  // Oldest pending warning
  const oldestNote = oldestDate
    ? `<p style="font-size:12px;color:#c05e00;margin:0 0 16px;background:#fff8f0;padding:8px 12px;border-radius:6px;border-left:3px solid #e67e22;">Oldest pending event received ${oldestDate}</p>`
    : '';

  // Total pending callout (only show if different from newCount)
  const totalNote = pendingCount > newCount
    ? `<p style="font-size:13px;color:#888;margin:0 0 24px;">Total in queue: <strong style="color:#333;">${pendingCount} event${pendingCount !== 1 ? 's' : ''}</strong> awaiting review</p>`
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#1a1a1a;padding:22px 32px;">
    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888;">CommunityHub</p>
    <h1 style="color:white;margin:4px 0 0;font-size:18px;font-weight:700;">AI Events Ingestion Software</h1>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:28px 32px 8px;">
    <p style="margin:0 0 6px;font-size:15px;color:#111;font-weight:600;">Hi ${reviewerName},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
      ${newCount} new event${newCount !== 1 ? 's' : ''} just arrived ${sourcePart} and ${newCount === 1 ? 'is' : 'are'} waiting for your review.
    </p>

    ${previewSection}

    ${sources.length > 0 ? `
    <p style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">By source</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:20px;">${sourceRows}</table>` : ''}

    ${totalNote}
    ${oldestNote}

    <div style="margin:24px 0 20px;">
      <a href="${APP_URL}/reviewer/queue" style="display:inline-block;background:#3a8c3f;color:white;text-decoration:none;padding:12px 28px;border-radius:7px;font-size:14px;font-weight:700;letter-spacing:0.2px;">
        Open review queue
      </a>
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:16px 32px;border-top:1px solid #eee;">
    <p style="margin:0;font-size:11px;color:#bbb;">AI Events Ingestion Software &middot; CommunityHub &middot; Oberlin, OH</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return getTransporter().sendMail({ from: FROM, to: reviewerEmail, subject, html });
}

export async function sendWelcomeEmail(opts: { email: string; name: string; role: string; pendingCount?: number }) {
  const { email, name, role, pendingCount = 0 } = opts;

  const queueSection = pendingCount > 0 ? `
  <div style="background:#e8f5e9;border-radius:10px;padding:20px 24px;margin:24px 0;text-align:center;">
    <div style="font-size:48px;font-weight:800;color:#3a8c3f;line-height:1;">${pendingCount}</div>
    <div style="font-size:13px;color:#2a6b2e;font-weight:600;margin-top:4px;">event${pendingCount !== 1 ? 's' : ''} waiting for review right now</div>
  </div>` : '';

  const actions = role === 'reviewer' ? `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;">
    <tr>
      <td style="padding:0 6px 0 0;">
        <a href="${APP_URL}/reviewer/queue" style="display:block;background:#3a8c3f;color:white;text-decoration:none;padding:13px 0;border-radius:8px;font-size:14px;font-weight:700;text-align:center;">
          📋 Review queue
        </a>
      </td>
      <td style="padding:0 0 0 6px;">
        <a href="${APP_URL}/reviewer/dashboard" style="display:block;background:white;color:#3a8c3f;text-decoration:none;padding:12px 0;border-radius:8px;font-size:14px;font-weight:700;text-align:center;border:2px solid #3a8c3f;">
          📊 My dashboard
        </a>
      </td>
    </tr>
  </table>` : `
  <div style="text-align:center;margin:28px 0 8px;">
    <a href="${APP_URL}/admin/stats" style="display:inline-block;background:#3a8c3f;color:white;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:700;">
      📊 Go to dashboard →
    </a>
  </div>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f7f0;font-family:system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f0;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(58,140,63,0.1);">
<tr><td style="background:#3a8c3f;padding:28px 32px;text-align:center;">
  <h1 style="color:white;margin:0 0 4px;font-size:20px;font-weight:800;letter-spacing:0.5px;">AI EVENTS INGESTION SOFTWARE</h1>
  <p style="color:rgba(255,255,255,0.8);margin:0;font-size:13px;">CommunityHub</p>
</td></tr>
<tr><td style="padding:32px;">
  <p style="margin:0 0 8px;font-size:16px;color:#333;font-weight:600;">Hi ${name},</p>
  <p style="margin:0 0 16px;font-size:14px;color:#666;line-height:1.6;">
    You've been added as a <strong style="color:#3a8c3f;">${role}</strong> on AI Events Ingestion Software.
    Sign in with Google to get started.
  </p>
  ${queueSection}
  <p style="margin:0 0 4px;font-size:13px;color:#666;line-height:1.6;">Here's what you can do:</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 20px;">
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#444;">📋</td>
      <td style="padding:6px 0;font-size:13px;color:#444;padding-left:8px;">Review incoming events from AI agents and approve or reject them</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#444;">✏️</td>
      <td style="padding:6px 0;font-size:13px;color:#444;padding-left:8px;">Edit event details before approving</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#444;">🔁</td>
      <td style="padding:6px 0;font-size:13px;color:#444;padding-left:8px;">Send events back to the AI for correction with a note</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#444;">🔔</td>
      <td style="padding:6px 0;font-size:13px;color:#444;padding-left:8px;">Get notified by email when new events arrive</td>
    </tr>
  </table>
  ${actions}
</td></tr>
<tr><td style="background:#f8f9fa;padding:16px 32px;border-top:1px solid #eee;">
  <p style="margin:0;font-size:11px;color:#aaa;text-align:center;">AI Events Ingestion Software · CommunityHub</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return getTransporter().sendMail({
    from:    FROM,
    to:      email,
    subject: pendingCount > 0
      ? `You're in — ${pendingCount} event${pendingCount !== 1 ? 's' : ''} waiting for your review`
      : `You've been added to AI Events Ingestion Software as a ${role}`,
    html,
  });
}

export async function sendAgentRunSummary(opts: {
  adminEmail: string;
  results:    { source: string; status: string; inserted: number; error?: string }[];
  totalNew:   number;
}) {
  const { adminEmail, results, totalNew } = opts;

  const rows = results.map(r => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${r.source}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">
      <span style="color:${r.status === 'ok' ? '#3a8c3f' : '#c0392b'};font-weight:600;">${r.status === 'ok' ? '✓' : '✗'} ${r.status}</span>
    </td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:600;color:#3a8c3f;">${r.inserted ?? 0}</td>
    <td style="padding:8px 12px;font-size:11px;color:#c0392b;">${r.error || ''}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f7f0;font-family:system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f0;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(58,140,63,0.1);">
<tr><td style="background:#3a8c3f;padding:24px 32px;text-align:center;">
  <h1 style="color:white;margin:0;font-size:18px;font-weight:800;">Agent Run Complete</h1>
  <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px;">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
</td></tr>
<tr><td style="padding:32px;">
  <div style="background:#e8f5e9;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px;">
    <div style="font-size:40px;font-weight:800;color:#3a8c3f;">${totalNew}</div>
    <div style="font-size:12px;color:#2a6b2e;font-weight:600;">new events added to review queue</div>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:24px;">
    <thead><tr style="background:#f8f9fa;">
      <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;">Source</th>
      <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;">Status</th>
      <th style="padding:8px 12px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;">New events</th>
      <th style="padding:8px 12px;font-size:11px;color:#888;text-transform:uppercase;">Error</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="text-align:center;">
    <a href="${APP_URL}/admin/stats" style="display:inline-block;background:#3a8c3f;color:white;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:600;">
      View dashboard →
    </a>
  </div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return getTransporter().sendMail({
    from:    FROM,
    to:      adminEmail,
    subject: `Agent run: ${totalNew} new event${totalNew !== 1 ? 's' : ''} ready for review`,
    html,
  });
}
