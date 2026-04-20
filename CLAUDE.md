# Trifusion V3 — Project Context for Claude Code

## What this is
Multi-company fleet management and installation tracking SaaS platform built for WebAncher. Four portals: Admin, Client, Installer, and HQ.

## Live deployment
- **Railway URL:** (update with your V3 Railway URL once deployed)
- **GitHub repo:** ZanderVDB/trifusion-v3
- **Data persistence:** Railway volume mounted at `/app/db`

## File structure
```
server.js                          — Express server, all API routes
public/
  login.html                       — Login page (all roles)
  auth.js                          — Shared auth helpers (getAuth, setAuth, apiFetch etc.)
  shared.css                       — Shared styles used by all portals
  hq/index.html                    — WebAncher HQ portal
  company/admin/index.html         — Admin portal
  company/client/index.html        — Client portal
  company/installer/index.html     — Installer portal
```

## Portal routes
```
/                    → Login
/hq                  → HQ portal (WebAncher staff)
/trifusion/admin     → Admin portal
/trifusion/client    → Client portal
/trifusion/installer → Installer portal
```

## Test credentials
| Portal    | Username     | Password          |
|-----------|-------------|-------------------|
| HQ        | webancherhq | hq@WebAncher2025  |
| Admin     | admin       | admin123          |
| Client    | david       | korridor123       |
| Client    | natan       | korridor456       |
| Installer | brigade     | brigade123        |
| Installer | zamaka      | zamaka123         |

## Tech stack
- **Backend:** Node.js + Express
- **Data storage:** JSON files on Railway volume (`/app/db`)
- **Email:** Resend API (key stored in HQ settings, not env vars)
- **Frontend:** Vanilla JS, no framework
- **Auth:** Token-based, stored in memory (`tokenStore`) + persisted to JSON

## Key data paths (on Railway)
- `/app/db/superadmin/companies.json` — company registry
- `/app/db/superadmin/hq.json` — HQ settings (Resend API key, fromEmail)
- `/app/db/{companyId}/users.json` — per-company users
- `/app/db/{companyId}/jobs.json` — per-company jobs
- `/app/db/{companyId}/settings.json` — per-company settings

## Critical patterns — always follow these

### 1. Any route that calls sendEmail MUST be async
`sendEmail` uses `fetch` internally. Without `async/await` it fires and silently fails.
```js
// CORRECT
app.post('/api/...', requireCompanyAuth(), async (req, res) => {
  await sendEmail({ to, subject, html });
});
// WRONG — email will silently fail
app.post('/api/...', requireCompanyAuth(), (req, res) => {
  sendEmail({ to, subject, html }); // never awaited
});
```

### 2. Save data to DB, not localStorage
Any data that must survive logout (emails, settings, credentials) must be written to the JSON files via `saveCompanyUsers()`, `writeJSON()`, etc. localStorage clears on logout.

### 3. Read active tab from DOM, not JS variables
For split-view layout state, read the active tab from which button has the `.active` CSS class — not from a JS variable that may be overridden by `auth.js`.

### 4. Email lookup
- Installers: looked up by `getUserEmail(cid, technician)` which matches `u.installer === identifier`
- Clients: looked up by finding `u.clientId === clientId`
- Admin: looked up by `getAdminEmail(cid)` which finds the user with `role === 'admin'`

## Email system
All emails sent via Resend API. Config stored in HQ settings (not env vars).

### All email triggers
| Event | Recipient | Subject |
|-------|-----------|---------|
| Admin creates job | Installer | New Job Assigned — JOB-XXX |
| Admin creates job for client | Client | New Service Scheduled For You — JOB-XXX |
| Client creates job | Client | Service Request Received — JOB-XXX |
| Client creates job | Admin | New Client Request — JOB-XXX |
| Admin assigns installer | Installer | You've Been Assigned — JOB-XXX |
| Installer accepts job | Client | Installer Accepted — JOB-XXX |
| Vehicle unavailable | Client | Vehicle Unavailable — Action Required |
| Client replies to vehicle issue | Installer | Client Replied to Vehicle Issue — JOB-XXX |
| Installer ticks Service Complete | Client | Action Required — Is the system working? |
| Client reports problem | Installer | Client Reported a Problem — JOB-XXX |
| Client reports problem | Admin | Problem Reported on JOB-XXX |
| Installer resolves problem | Client | Issue Addressed — Please Re-confirm |
| All documents uploaded | Client | Documents Ready for Review — JOB-XXX |
| Installer proposes reschedule | Client | Reschedule Proposed — JOB-XXX |
| Client counter-proposes | Installer | Client Counter-Proposed Reschedule — JOB-XXX |
| Job completed normally | Client + Installer | Job Completed — JOB-XXX |
| Job completed normally | Admin | Job Completed — JOB-XXX |
| Admin force-closes job | Client + Installer | Job Closed by Admin — JOB-XXX |

## Job status flow
Pending Acceptance → In Progress → Awaiting System Check → Waiting for Docs → Awaiting Document Check → Completed

## Checklist structure (per job)
1. `accepted` — installer acceptance
2. `onsite` — technician + vehicle on location
3. `service` — service steps + service_complete
4. `documents` — job card, inspection checklist, images, notes

## Key helpers in server.js
- `sendEmail({ to, subject, html })` — async, Resend API
- `getUserEmail(cid, identifier)` — finds email by installer/username/name
- `getAdminEmail(cid)` — finds admin user's email
- `jobLink(html)` — wraps email with "Open Trifusion Portal" button
- `jobEmailHtml(heading, body, info)` — builds styled email HTML
- `getCompanyUsers(cid)` — reads users.json for a company
- `getCompanyJobs(cid)` — reads jobs.json for a company
- `jobAction(cid, jobId, fn)` — reads job, applies fn, saves
- `computeStatus(job)` — derives status from checklist state
- `broadcast(cid, payload)` — SSE push to all connected clients

## What's working well (don't break)
- Email system — all 19 triggers firing correctly
- Split-view dashboard (Needs Attention / Active) on all portals
- Job lifecycle end-to-end
- Document uploads
- Vehicle unavailable flow
- Reschedule proposal / counter-proposal flow
- Mobile responsive layout on all portals
- Admin settings (credentials save to DB, persist across logout)

## Areas for improvement (V3 focus)
- UI/UX polish and modernisation
- Better mobile experience
- Performance improvements
- Any new features requested by WebAncher
