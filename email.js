// ─── EMAIL NOTIFICATIONS ──────────────────────────────────────────────────────
let config, resendClient;

function init() {
  try {
    config = require('./email.config.js');
    // Environment variable takes priority over config file (used on Railway)
    const apiKey = process.env.RESEND_API_KEY || config.RESEND_API_KEY;
    if (!apiKey || apiKey.includes('YOUR_API_KEY')) {
      console.log('[Email] Not configured — set RESEND_API_KEY environment variable');
      return false;
    }
    // Override config with environment variables if set
    config.RESEND_API_KEY = apiKey;
    if (process.env.FROM_EMAIL) config.FROM_EMAIL = process.env.FROM_EMAIL;
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    console.log('[Email] Notifications enabled ✓');
    return true;
  } catch(e) {
    console.log('[Email] Not available:', e.message);
    return false;
  }
}

const enabled = init();

// ── Email templates ──────────────────────────────────────────────────────────
function wrap(title, body) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f1f5f9;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#0ea5e9,#6366f1);padding:24px 28px">
      <div style="font-weight:700;font-size:20px;color:#fff">Trifusion</div>
      <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:2px">Installation Management</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#0f172a">${title}</h2>
      ${body}
    </div>
    <div style="padding:16px 28px;background:#f8fafc;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0">
      This is an automated message from Trifusion. Do not reply to this email.
    </div>
  </div>
</body></html>`;
}

function row(label, value) {
  return `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f1f5f9">
    <span style="font-size:12px;color:#64748b;min-width:110px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">${label}</span>
    <span style="font-size:13px;color:#1e293b;font-weight:500">${value}</span>
  </div>`;
}

function jobDetails(job) {
  return `<div style="background:#f8fafc;border-radius:8px;padding:14px 16px;margin:16px 0">
    ${row('Job', job.id)}
    ${row('Location', job.location)}
    ${row('Date', job.date + (job.time ? ' at ' + job.time : ''))}
    ${row('Unit Type', job.unitType)}
    ${row('Truck', job.truck || 'TBC')}
    ${row('Installer', job.technician)}
  </div>`;
}

// ── Send helper ───────────────────────────────────────────────────────────────
async function send(to, subject, html) {
  if (!enabled || !to) return;
  const toAddr = typeof to === 'string' ? config.EMAILS[to] || to : to;
  if (!toAddr || toAddr.includes('example.com') || toAddr.includes('yourdomain')) return;
  try {
    await resendClient.emails.send({ from: config.FROM_EMAIL, to: toAddr, subject, html });
    console.log(`[Email] Sent "${subject}" → ${toAddr}`);
  } catch(e) {
    console.log(`[Email] Failed to send: ${e.message}`);
  }
}

// ── Notification functions ────────────────────────────────────────────────────

// New installation booked by David → notify installer + admin
async function notifyNewService(job) {
  const installer = job.technician?.toLowerCase();
  await send(installer, `New Service — ${job.id}: ${job.location}`, wrap(
    '🆕 New Service Assigned',
    `<p style="color:#475569;font-size:14px">A new installation has been booked and assigned to you.</p>
    ${jobDetails(job)}
    <p style="color:#475569;font-size:13px">Please log in to Trifusion to accept or propose a reschedule.</p>`
  ));
  await send('admin', `New Service Created — ${job.id}`, wrap(
    '🆕 New Service',
    `<p style="color:#475569;font-size:14px">A new installation has been submitted.</p>${jobDetails(job)}`
  ));
}

// Installer proposes reschedule → notify David + admin
async function notifyRescheduleProposed(job, proposal) {
  const proposed = (proposal.proposedDate || job.date) + (proposal.proposedTime ? ' at ' + proposal.proposedTime : '');
  await send('david', `Reschedule Request — ${job.id}: ${job.location}`, wrap(
    '⚠ Installer Requesting Reschedule',
    `<p style="color:#475569;font-size:14px"><b>${job.technician}</b> cannot make the scheduled time and has proposed an alternative.</p>
    ${jobDetails(job)}
    <div style="background:#fef3c7;border-radius:8px;padding:14px 16px;margin:12px 0">
      <div style="font-weight:700;color:#92400e;margin-bottom:4px">Proposed New Time</div>
      <div style="font-size:15px;color:#78350f;font-weight:600">${proposed}</div>
      ${proposal.note ? `<div style="font-size:13px;color:#92400e;margin-top:6px">Note: ${proposal.note}</div>` : ''}
    </div>
    <p style="color:#475569;font-size:13px">Please log in to Trifusion to accept, decline or suggest an alternative time.</p>`
  ));
  await send('admin', `Reschedule Proposed — ${job.id}`, wrap(
    '⚠ Reschedule Proposed',
    `<p style="color:#475569;font-size:14px">${job.technician} proposed a reschedule for ${job.id} (${job.location}) to <b>${proposed}</b>.</p>`
  ));
}

// David accepts reschedule → notify installer
async function notifyRescheduleAccepted(job) {
  const installer = job.technician?.toLowerCase();
  await send(installer, `Time Accepted — ${job.id}: ${job.location}`, wrap(
    '✅ Reschedule Accepted',
    `<p style="color:#475569;font-size:14px">David has accepted the rescheduled time.</p>
    ${jobDetails(job)}
    <div style="background:#d1fae5;border-radius:8px;padding:14px 16px;margin:12px 0">
      <div style="font-weight:700;color:#065f46">Confirmed Time</div>
      <div style="font-size:15px;color:#064e3b;font-weight:600;margin-top:4px">${job.date}${job.time ? ' at ' + job.time : ''}</div>
    </div>`
  ));
}

// David rejects reschedule → notify installer
async function notifyRescheduleRejected(job) {
  const installer = job.technician?.toLowerCase();
  await send(installer, `Time Rejected — ${job.id}: ${job.location}`, wrap(
    '❌ Reschedule Not Accepted',
    `<p style="color:#475569;font-size:14px">David has not accepted the proposed time.</p>
    ${jobDetails(job)}
    <p style="color:#475569;font-size:13px">Please log in to Trifusion to suggest another time or contact admin.</p>`
  ));
}

// David suggests alternative → notify installer
async function notifyClientSuggestion(job, proposal) {
  const installer = job.technician?.toLowerCase();
  const proposed = (proposal.proposedDate || job.date) + (proposal.proposedTime ? ' at ' + proposal.proposedTime : '');
  await send(installer, `Alternative Time Suggested — ${job.id}: ${job.location}`, wrap(
    '💬 David Suggests Alternative Time',
    `<p style="color:#475569;font-size:14px">David has suggested a different time.</p>
    ${jobDetails(job)}
    <div style="background:#ede9fe;border-radius:8px;padding:14px 16px;margin:12px 0">
      <div style="font-weight:700;color:#4c1d95">Suggested Time</div>
      <div style="font-size:15px;color:#3b0764;font-weight:600;margin-top:4px">${proposed}</div>
      ${proposal.note ? `<div style="font-size:13px;color:#4c1d95;margin-top:6px">Note: ${proposal.note}</div>` : ''}
    </div>`
  ));
}

// Installer marks service complete → notify David + admin
async function notifyServiceComplete(job) {
  await send('david', `Installation Complete — ${job.id}: ${job.location}`, wrap(
    '🚛 Installation Complete',
    `<p style="color:#475569;font-size:14px">The installer has completed the installation. Please check your system.</p>
    ${jobDetails(job)}
    <p style="color:#475569;font-size:13px">Please log in to Trifusion to confirm everything is working correctly.</p>`
  ));
  await send('admin', `Installation Complete — ${job.id}`, wrap(
    '🚛 Installation Complete',
    `<p style="color:#475569;font-size:14px">${job.technician} has marked the service complete for ${job.id} (${job.location}).</p>`
  ));
}

// All documents uploaded → notify David + admin
async function notifyDocumentsReady(job) {
  await send('david', `Documents Ready — ${job.id}: ${job.location}`, wrap(
    '📄 Documents Submitted',
    `<p style="color:#475569;font-size:14px">All post-installation documents have been submitted by ${job.technician}.</p>
    ${jobDetails(job)}
    <p style="color:#475569;font-size:13px">Log in to Trifusion to view and download the documents.</p>`
  ));
  await send('admin', `Documents Ready — ${job.id}`, wrap(
    '📄 All Documents Submitted',
    `<p style="color:#475569;font-size:14px">All documents for ${job.id} (${job.location}) have been submitted.</p>`
  ));
}

// Client reports problem → notify admin + installer
async function notifyProblemReported(job, reason) {
  await send('admin', `⚠ Problem Reported — ${job.id}: ${job.location}`, wrap(
    '⚠ Client Reported a Problem',
    `<p style="color:#475569;font-size:14px">David has reported a problem with the installation.</p>
    ${jobDetails(job)}
    <div style="background:#fee2e2;border-radius:8px;padding:14px 16px;margin:12px 0">
      <div style="font-weight:700;color:#991b1b;margin-bottom:4px">Problem Description</div>
      <div style="font-size:14px;color:#7f1d1d">${reason}</div>
    </div>`
  ));
  const installer = job.technician?.toLowerCase();
  await send(installer, `⚠ Problem Reported — ${job.id}: ${job.location}`, wrap(
    '⚠ Client Reported a Problem',
    `<p style="color:#475569;font-size:14px">David has reported a problem with the service at ${job.location}. Admin has been notified.</p>
    ${jobDetails(job)}`
  ));
}

// Client confirms all good → notify admin
async function notifyClientConfirmed(job) {
  await send('admin', `✓ System OK — ${job.id}: ${job.location}`, wrap(
    '✓ Client Confirmed System OK',
    `<p style="color:#475569;font-size:14px">David has confirmed the service at ${job.location} is working correctly on the system.</p>
    ${jobDetails(job)}`
  ));
}

module.exports = {
  notifyNewService,
  notifyRescheduleProposed,
  notifyRescheduleAccepted,
  notifyRescheduleRejected,
  notifyClientSuggestion,
  notifyServiceComplete,
  notifyDocumentsReady,
  notifyProblemReported,
  notifyClientConfirmed,
};
