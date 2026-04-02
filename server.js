'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const multer   = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT       = __dirname;
const DB_DIR     = path.join(ROOT, 'db');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPL_DIR    = path.join(ROOT, 'uploads');

function companyDir(cid)  { return path.join(DB_DIR, 'companies', cid); }
function companyFile(cid, f) { return path.join(companyDir(cid), f); }

// ── JSON helpers ──────────────────────────────────────────────────────────────
function readJSON(fp, def) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return def; }
}
function writeJSON(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

// ── Company helpers ───────────────────────────────────────────────────────────
function getCompanies() {
  return readJSON(path.join(DB_DIR, 'superadmin', 'companies.json'), []);
}
function saveCompanies(data) {
  writeJSON(path.join(DB_DIR, 'superadmin', 'companies.json'), data);
}
function getCompanyUsers(cid) {
  const dir = companyDir(cid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return readJSON(companyFile(cid, 'users.json'), {});
}
function saveCompanyUsers(cid, data) {
  writeJSON(companyFile(cid, 'users.json'), data);
}
function getCompanyJobs(cid) {
  const dir = companyDir(cid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return readJSON(companyFile(cid, 'jobs.json'), []);
}
function saveCompanyJobs(cid, jobs) {
  writeJSON(companyFile(cid, 'jobs.json'), jobs);
}
function getCompanySettings(cid) {
  return readJSON(companyFile(cid, 'settings.json'), {});
}
function saveCompanySettings(cid, s) {
  writeJSON(companyFile(cid, 'settings.json'), s);
}
function getSignups() {
  return readJSON(path.join(DB_DIR, 'superadmin', 'signups.json'), []);
}
function saveSignups(data) {
  writeJSON(path.join(DB_DIR, 'superadmin', 'signups.json'), data);
}
function getHQ() {
  return readJSON(path.join(DB_DIR, 'superadmin', 'hq.json'), {});
}


// ── Activity log ──────────────────────────────────────────────────────────────
function addActivity(job, who, role, event, detail='') {
  if (!job.activityLog) job.activityLog = [];
  job.activityLog.push({ who, role, event, detail, at: new Date().toLocaleString() });
}

// ── Job ID ────────────────────────────────────────────────────────────────────
function nextJobId(cid) {
  const jobs = getCompanyJobs(cid);
  const nums = jobs.map(j => parseInt((j.id||'').replace(/[^0-9]/g,''))||0);
  return 'JOB-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3,'0');
}

// ── Checklist builder ─────────────────────────────────────────────────────────
function buildChecklist(job) {
  return [
    { id:'accepted', title:'Service Acceptance', subtitle:'Installer confirms the job', who:'installer', steps:[
      { id:'job_accepted', label:'Accept this service', done:false }
    ]},
    { id:'pre', title:'Pre-Service Confirmation', subtitle:'Complete approx. 1 hour before service', who:'installer', steps:[
      { id:'pre_confirm', label:'Confirm service is still happening', done:false }
    ]},
    { id:'service', title:'Service Check', subtitle:'Complete during the service', who:'installer', steps:[
      { id:'tech_onsite',      label:'Technician confirmed on-site', done:false },
      { id:'truck_onsite',     label:'Vehicle / truck confirmed on-site', done:false },
      { id:'service_complete', label:'Service complete', done:false }
    ]},
    { id:'documents', title:'Post-Service Documents', subtitle:'Upload after service is complete', who:'both', steps:[
      { id:'doc_job_card',   label:'Job card', done:false, requiresUpload:true, uploadedFiles:[] },
      { id:'doc_checklist',  label:'Inspection checklist', done:false, requiresUpload:true, uploadedFiles:[] },
      { id:'doc_images',     label:'Images of job', done:false, requiresUpload:true, multipleFiles:true, uploadedFiles:[] },
      { id:'doc_notes',      label:'Additional notes', done:false, isTextNote:true }
    ]}
  ];
}

// ── Job status ────────────────────────────────────────────────────────────────
function computeStatus(job) {
  if (job.truckUnavailable)   return 'Vehicle Unavailable';
  if (job.clientConfirmed)    return 'Completed';
  if (job.docCheckPending)    return 'Awaiting Document Check';
  if (job.systemCheckPending) return 'Awaiting System Check';
  const cl = job.checklist || [];
  const accepted = cl.find(s=>s.id==='accepted');
  if (!accepted?.steps[0]?.done) return 'Pending Acceptance';
  const pre     = cl.find(s=>s.id==='pre');
  const service = cl.find(s=>s.id==='service');
  const docs    = cl.find(s=>s.id==='documents');
  const allDone = s => s?.steps.every(x=>x.done||x.skipped);
  // Only upload steps (not text notes) determine doc completion for client prompt
  const docUploadsDone = docs?.steps.filter(s=>s.requiresUpload && !s.isTextNote).every(s=>s.done);
  const docNotesDone   = docs?.steps.filter(s=>s.isTextNote).every(s=>s.done||s.skipped);
  const allDocsDone    = docUploadsDone && docNotesDone;
  // Check if service_complete ticked
  const serviceComplete = service?.steps.find(s=>s.id==='service_complete')?.done;
  if (serviceComplete && !job.systemOk) return 'Awaiting System Check';
  if (allDocsDone && job.systemOk) return 'Awaiting Document Check';
  if (allDone(service) || job.systemOk) return 'Waiting for Docs';
  if (allDone(pre)) return 'In Progress';
  return 'In Progress';
}

// ── Token store ───────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(DB_DIR, 'superadmin', 'tokens.json');
let tokenStore = readJSON(TOKEN_FILE, {});
function saveTokens() { writeJSON(TOKEN_FILE, tokenStore); }

function getUserByToken(token) {
  return token ? tokenStore[token] : null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPL_DIR));
app.use(express.static(PUBLIC_DIR));

// Multer for file uploads — use memory storage so we can pass buffer to R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});
const _unusedDiskStorage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const cid = req.params.companyId || req.user?.companyId || 'general';
      const dir = path.join(UPL_DIR, cid);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now()+'_'+file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_'))
  }),
  limits: { fileSize: 20*1024*1024 }
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(role) {
  return (req, res, next) => {
    const auth  = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ','').trim();
    const user  = getUserByToken(token);
    if (!user) return res.status(401).json({ error:'Not logged in' });
    if (role && user.role !== role && user.role !== 'hq')
      return res.status(403).json({ error:'Forbidden' });
    req.user = user;
    next();
  };
}

function requireCompanyAuth(role) {
  return (req, res, next) => {
    const auth  = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ','').trim();
    const user  = getUserByToken(token);
    if (!user) return res.status(401).json({ error:'Not logged in' });
    // HQ can access any company
    if (user.role === 'hq') { req.user = user; return next(); }
    // Company users can only access their own company
    const cid = req.params.companyId;
    if (user.companyId !== cid) return res.status(403).json({ error:'Forbidden' });
    if (role && user.role !== role && user.role !== 'admin')
      return res.status(403).json({ error:'Forbidden' });
    req.user = user;
    next();
  };
}


// Client replies to truck unavailable
app.post('/api/:companyId/jobs/:id/truck-reply', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const { message } = req.body;
  if (!message || !message.trim()) return res.json({ ok:false, error:'Please type a message.' });
  const job = jobAction(cid, req.params.id, (job) => {
    job.clientTruckReply = { message: message.trim(), at: new Date().toLocaleString(), by: req.user.name };
    addActivity(job, req.user.name, 'client', '💬 Client replied to truck issue', message.trim());
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = [];
function broadcast(companyId, data) {
  const msg = 'data: '+JSON.stringify(data)+'\n\n';
  sseClients.filter(c=>c.companyId===companyId||c.role==='hq').forEach(c=>{
    try { c.res.write(msg); } catch(e) {}
  });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Check HQ login
  const hq = getHQ();
  if (username === hq.username && password === hq.password) {
    const token = crypto.randomBytes(32).toString('hex');
    tokenStore[token] = { username, role:'hq', name: hq.name, companyId: null };
    saveTokens();
    return res.json({ ok:true, role:'hq', name:hq.name, token });
  }

  // Search all active companies for this user
  const companies = getCompanies().filter(c=>c.status==='active');
  for (const company of companies) {
    const users = getCompanyUsers(company.companyId);
    const user  = users[username];
    if (user && user.password === password) {
      const token = crypto.randomBytes(32).toString('hex');
      const settings = getCompanySettings(company.companyId);
      tokenStore[token] = {
        username,
        role:             user.role,
        name:             user.name,
        companyId:        company.companyId,
        companyName:      settings.companyName || company.companyName,
        installer:        user.installer || null,
        clientId:         user.clientId  || null,
        clientCompanyName: user.companyName || null,
        installerCompanyName: (user.role==='installer' ? (user.companyName||user.installer||user.name||'') : null),
      };
      saveTokens();
      return res.json({
        ok:true,
        role:      user.role,
        name:      user.name,
        companyId: company.companyId,
        companyName: settings.companyName || company.companyName,
        installer: user.installer || null,
        clientId:  user.clientId  || null,
        clientCompanyName: user.companyName || null,
        token
      });
    }
  }
  res.json({ ok:false, error:'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ','').trim();
  if (token) { delete tokenStore[token]; saveTokens(); }
  res.json({ ok:true });
});

app.get('/api/me', (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ','').trim();
  const user  = getUserByToken(token);
  if (!user) return res.json({ loggedIn:false });
  // Return fresh companyName from DB for installers
  let freshCompanyName = user.companyName || '';
  if (user.role === 'installer' && user.companyId) {
    const users = getCompanyUsers(user.companyId);
    const dbUser = users[user.username];
    if (dbUser?.companyName) freshCompanyName = dbUser.companyName;
    else if (dbUser?.installer) freshCompanyName = dbUser.installer;
  }
  res.json({ loggedIn:true, ...user, companyName: freshCompanyName });
});

// ── SIGNUP ────────────────────────────────────────────────────────────────────
app.post('/api/signup', (req, res) => {
  const { companyName, adminName, username, password, email } = req.body;
  if (!companyName||!adminName||!username||!password)
    return res.json({ ok:false, error:'All fields are required' });

  // Check username not taken
  const companies = getCompanies();
  for (const c of companies) {
    const users = getCompanyUsers(c.companyId);
    if (users[username]) return res.json({ ok:false, error:'Username already taken' });
  }
  const hq = getHQ();
  if (username === hq.username) return res.json({ ok:false, error:'Username already taken' });

  const signups = getSignups();
  if (signups.find(s=>s.username===username))
    return res.json({ ok:false, error:'Signup already pending for this username' });

  signups.push({ companyName, adminName, username, password, email, requestedAt: new Date().toISOString() });
  saveSignups(signups);
  res.json({ ok:true });
});

// ── HQ ROUTES ─────────────────────────────────────────────────────────────────
app.get('/api/hq/companies', requireAuth('hq'), (req, res) => {
  const companies = getCompanies();
  const result = companies.map(c => {
    const users    = getCompanyUsers(c.companyId);
    const jobs     = getCompanyJobs(c.companyId);
    const settings = getCompanySettings(c.companyId);
    return {
      ...c,
      companyName:  settings.companyName || c.companyName,
      adminName:    settings.adminName   || c.adminName,
      userCount:    Object.keys(users).length,
      clientCount:  Object.values(users).filter(u=>u.role==='client').length,
      installerCount: Object.values(users).filter(u=>u.role==='installer').length,
      activeJobs:   jobs.filter(j=>j.status!=='Completed').length,
      totalJobs:    jobs.length,
    };
  });
  res.json(result);
});

app.get('/api/hq/signups', requireAuth('hq'), (req, res) => {
  res.json(getSignups());
});

app.post('/api/hq/signups/:username/approve', requireAuth('hq'), (req, res) => {
  const signups = getSignups();
  const idx = signups.findIndex(s=>s.username===req.params.username);
  if (idx === -1) return res.json({ ok:false, error:'Not found' });
  const s = signups[idx];

  // Create company
  const companyId = s.companyName.toLowerCase().replace(/[^a-z0-9]/g,'_').replace(/__+/g,'_');
  const companies = getCompanies();
  const uniqueId  = companies.find(c=>c.companyId===companyId)
    ? companyId + '_' + Date.now() : companyId;

  fs.mkdirSync(companyDir(uniqueId), { recursive: true });
  fs.mkdirSync(path.join(UPL_DIR, uniqueId), { recursive: true });

  // Create admin user
  const users = {};
  users[s.username] = { username:s.username, password:s.password, role:'admin', name:s.adminName, companyId:uniqueId };
  saveCompanyUsers(uniqueId, users);
  saveCompanyJobs(uniqueId, []);
  saveCompanySettings(uniqueId, {
    companyId: uniqueId, companyName: s.companyName, adminName: s.adminName,
    status:'active', createdAt: new Date().toISOString().slice(0,10),
    branding:{ logoUrl:null }, emails:{ adminEmail:s.email||'', clientEmail:'', installerEmail:'', resendApiKey:'' }
  });

  companies.push({ companyId:uniqueId, companyName:s.companyName, adminName:s.adminName, status:'active', createdAt:new Date().toISOString().slice(0,10) });
  saveCompanies(companies);

  signups.splice(idx, 1);
  saveSignups(signups);
  res.json({ ok:true, companyId:uniqueId });
});

app.post('/api/hq/signups/:username/reject', requireAuth('hq'), (req, res) => {
  const signups = getSignups().filter(s=>s.username!==req.params.username);
  saveSignups(signups);
  res.json({ ok:true });
});

app.post('/api/hq/companies', requireAuth('hq'), (req, res) => {
  const { companyName, adminName, username, password } = req.body;
  if (!companyName||!adminName||!username||!password)
    return res.json({ ok:false, error:'All fields required' });

  const companies = getCompanies();
  let companyId = companyName.toLowerCase().replace(/[^a-z0-9]/g,'_').replace(/__+/g,'_');
  if (companies.find(c=>c.companyId===companyId)) companyId += '_'+Date.now();

  fs.mkdirSync(companyDir(companyId), { recursive: true });
  fs.mkdirSync(path.join(UPL_DIR, companyId), { recursive: true });

  const users = {};
  users[username] = { username, password, role:'admin', name:adminName, companyId };
  saveCompanyUsers(companyId, users);
  saveCompanyJobs(companyId, []);
  saveCompanySettings(companyId, {
    companyId, companyName, adminName, status:'active',
    createdAt: new Date().toISOString().slice(0,10),
    branding:{ logoUrl:null }, emails:{ adminEmail:'', clientEmail:'', installerEmail:'', resendApiKey:'' }
  });

  companies.push({ companyId, companyName, adminName, status:'active', createdAt:new Date().toISOString().slice(0,10) });
  saveCompanies(companies);
  res.json({ ok:true, companyId });
});

app.delete('/api/hq/companies/:companyId', requireAuth('hq'), (req, res) => {
  const cid = req.params.companyId;
  const companies = getCompanies().filter(c=>c.companyId!==cid);
  saveCompanies(companies);
  res.json({ ok:true });
});

// HQ view a company's jobs
app.get('/api/hq/companies/:companyId/jobs', requireAuth('hq'), (req, res) => {
  const jobs = getCompanyJobs(req.params.companyId).map(j=>({...j, status:computeStatus(j)}));
  res.json(jobs);
});

app.get('/api/hq/companies/:companyId/users', requireAuth('hq'), (req, res) => {
  res.json(getCompanyUsers(req.params.companyId));
});

app.get('/api/hq/companies/:companyId/settings', requireAuth('hq'), (req, res) => {
  res.json(getCompanySettings(req.params.companyId));
});


// ── HQ SETTINGS ───────────────────────────────────────────────────────────────
app.get('/api/hq/settings', requireAuth('hq'), (req, res) => {
  const hq = getHQ();
  res.json({ resendApiKey: hq.resendApiKey || '', fromEmail: hq.fromEmail || '' });
});

app.put('/api/hq/settings', requireAuth('hq'), (req, res) => {
  const hq = getHQ();
  if (req.body.resendApiKey !== undefined) hq.resendApiKey = req.body.resendApiKey;
  if (req.body.fromEmail !== undefined) hq.fromEmail = req.body.fromEmail;
  writeJSON(path.join(DB_DIR, 'superadmin', 'hq.json'), hq);
  res.json({ ok:true });
});


// ── PUBLIC FORM DATA (any authenticated company user) ─────────────────────────
// Returns installer countries and client list for form dropdowns — no passwords
app.get('/api/:companyId/form-data', requireCompanyAuth(), (req, res) => {
  const cid   = req.params.companyId;
  const users = getCompanyUsers(cid);
  const vals  = Object.values(users);

  const installers = vals.filter(u=>u.role==='installer').map(u=>({
    name: u.name, installer: u.installer, countries: u.countries||[], companyName: u.companyName||u.name
  }));
  const clients = vals.filter(u=>u.role==='client').map(u=>({
    clientId: u.clientId||u.username, name: u.name, companyName: u.companyName||u.name
  }));

  res.json({ installers, clients });
});

// ── COMPANY ADMIN — USER MANAGEMENT ──────────────────────────────────────────
app.get('/api/:companyId/users', requireCompanyAuth('admin'), (req, res) => {
  const users = getCompanyUsers(req.params.companyId);
  // Strip passwords from response (except for admin viewing own company)
  const safe = {};
  Object.entries(users).forEach(([k,v]) => { safe[k] = {...v}; });
  res.json(safe);
});

app.post('/api/:companyId/users', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const { username, password, role, name, companyName, countries } = req.body;
  if (!username||!password||!role||!name) return res.json({ ok:false, error:'All fields required' });

  const users = getCompanyUsers(cid);
  if (users[username]) return res.json({ ok:false, error:'Username already exists' });

  const newUser = { username, password, role, name, companyId:cid, email:req.body.email||'', createdAt:new Date().toISOString().slice(0,10) };
  if (role === 'client') {
    newUser.clientId = username;
    newUser.companyName = companyName || '';
  }
  if (role === 'installer') {
    newUser.installer = name;
    newUser.countries = countries || [];
    newUser.companyName = companyName || '';
  }
  users[username] = newUser;
  saveCompanyUsers(cid, users);
  res.json({ ok:true });
});

app.put('/api/:companyId/users/:username', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const users = getCompanyUsers(cid);
  if (!users[req.params.username]) return res.json({ ok:false, error:'User not found' });
  const oldUsername = req.params.username;
  const { newUsername } = req.body;
  const allowed = ['password','name','companyName','countries','email'];
  allowed.forEach(k => { if (req.body[k] !== undefined) users[oldUsername][k] = req.body[k]; });
  // Handle username change
  if (newUsername && newUsername !== oldUsername) {
    if (users[newUsername]) return res.json({ ok:false, error:'Username already taken' });
    users[oldUsername].username = newUsername;
    users[newUsername] = users[oldUsername];
    delete users[oldUsername];
  }
  saveCompanyUsers(cid, users);
  // Sync name/company changes to existing jobs
  const allJobs = getCompanyJobs(cid);
  const updatedUser = users[newUsername || oldUsername];
  let jobsChanged = false;
  allJobs.forEach(job => {
    if (updatedUser?.role === 'client' && job.clientId === updatedUser.clientId) {
      if (req.body.name) { job.clientName = req.body.name; jobsChanged = true; }
      if (req.body.companyName) { job.clientCompanyName = req.body.companyName; jobsChanged = true; }
    }
    if (updatedUser?.role === 'installer') {
      const oldInstName = users[oldUsername]?.installer || users[oldUsername]?.name;
      if (job.technician === oldInstName) {
        if (req.body.name) { job.technician = req.body.name; jobsChanged = true; }
        jobsChanged = true;
      }
    }
  });
  if (jobsChanged) saveCompanyJobs(cid, allJobs);
  res.json({ ok:true });
});

app.delete('/api/:companyId/users/:username', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const users = getCompanyUsers(cid);
  delete users[req.params.username];
  saveCompanyUsers(cid, users);
  res.json({ ok:true });
});

// ── COMPANY SETTINGS ──────────────────────────────────────────────────────────
app.get('/api/:companyId/settings', requireCompanyAuth('admin'), (req, res) => {
  res.json(getCompanySettings(req.params.companyId));
});

app.put('/api/:companyId/settings', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const settings = getCompanySettings(cid);
  const allowed = ['companyName','adminName','branding','emails'];
  allowed.forEach(k => { if (req.body[k] !== undefined) settings[k] = req.body[k]; });
  saveCompanySettings(cid, settings);

  // Update company index
  const companies = getCompanies();
  const c = companies.find(x=>x.companyId===cid);
  if (c) { c.companyName = settings.companyName; c.adminName = settings.adminName; saveCompanies(companies); }
  res.json({ ok:true });
});

// Logo upload
app.post('/api/:companyId/settings/logo', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const logoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(UPL_DIR, cid, 'branding');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, 'logo_'+Date.now()+path.extname(file.originalname))
    }),
    limits: { fileSize: 5*1024*1024 }
  }).single('logo');

  logoUpload(req, res, (err) => {
    if (err) return res.json({ ok:false, error:err.message });
    if (!req.file) return res.json({ ok:false, error:'No file uploaded' });
    const logoUrl = '/uploads/'+cid+'/branding/'+req.file.filename;
    const settings = getCompanySettings(cid);
    settings.branding = settings.branding || {};
    settings.branding.logoUrl = logoUrl;
    saveCompanySettings(cid, settings);
    res.json({ ok:true, logoUrl });
  });
});

// ── JOBS ──────────────────────────────────────────────────────────────────────
app.get('/api/:companyId/jobs', requireCompanyAuth(), (req, res) => {
  const cid  = req.params.companyId;
  const user = req.user;
  let jobs   = getCompanyJobs(cid);
  const users = getCompanyUsers(cid);

  // Enrich jobs with live client/installer names from current user DB
  jobs = jobs.map(j => {
    const clientUser = j.clientId ? Object.values(users).find(u=>u.clientId===j.clientId) : null;
    if (clientUser) {
      j = { ...j,
        clientName:        clientUser.name        || j.clientName,
        clientCompanyName: clientUser.companyName || j.clientCompanyName,
      };
    }
    return j;
  });

  if (user.role === 'installer') {
    const myName = user.installer || user.name || '';
    jobs = jobs.filter(j => j.technician && (
      j.technician === myName || j.technician === user.name
    ));
  }
  if (user.role === 'client') jobs = jobs.filter(j=>j.clientId===user.clientId);

  // Update statuses
  jobs = jobs.map(j => ({ ...j, status: computeStatus(j) }));
  res.json(jobs);
});

app.get('/api/:companyId/jobs/:id', requireCompanyAuth(), (req, res) => {
  const jobs = getCompanyJobs(req.params.companyId);
  const job  = jobs.find(j=>j.id===req.params.id);
  if (!job) return res.status(404).json({ error:'Not found' });
  res.json({ ...job, status: computeStatus(job) });
});

app.post('/api/:companyId/jobs', requireCompanyAuth(), (req, res) => {
  const cid = req.params.companyId;
  const { location, truck, country, date, time, unitType, serviceType, clientId, technician } = req.body;
  if (!location||!date||!country) return res.status(400).json({ error:'Location, country and date are required' });
  if (!serviceType) return res.status(400).json({ error:'Please select a service type' });

  // Installer assignment — check how many installers in this country
  const users     = getCompanyUsers(cid);
  const countryLower = (country||'').toLowerCase().trim();
  const installers = Object.values(users).filter(u=>u.role==='installer' && (u.countries||[]).some(co=>co.toLowerCase().trim()===countryLower));

  let assignedTechnician = technician || '';
  let needsAssignment    = false;

  if (!assignedTechnician) {
    if (installers.length === 1) {
      assignedTechnician = installers[0].installer || installers[0].name;
    } else if (installers.length > 1) {
      needsAssignment = true;
    } else {
      // No installer for this country - admin must assign manually
      needsAssignment = true;
    }
  }

  // Get client info
  // If a client is submitting, use their own clientId
  const effectiveClientId = (req.user.role==='client' && req.user.clientId) ? req.user.clientId : clientId;
  const clientUser = effectiveClientId ? Object.values(users).find(u=>u.clientId===effectiveClientId) : null;
  const clientName = clientUser?.name || '';
  const clientCompanyName = clientUser?.companyName || clientUser?.name || '';

  console.log(`[JOB CREATE] cid=${cid} country=${country} serviceType=${serviceType} clientId=${req.user.clientId||'?'} effectiveClientId=${effectiveClientId}`);
  const id  = nextJobId(cid);
  const job = {
    id, location, truck:truck||'',
    technician: assignedTechnician,
    needsAssignment,
    country: country||'',
    date, time:time||'',
    serviceType: serviceType||'Installation',
    unitType: serviceType==='Inspection'?'N/A':(unitType||'Basic'),
    name: location,
    clientId: effectiveClientId||clientId||'',
    clientName, clientCompanyName,
    startDate: new Date().toISOString().slice(0,10),
    completionDate: null, notes: [], status:'Pending Acceptance'
  };
  job.checklist = buildChecklist(job);
  job.activityLog = [{ who:'System', role:'system', event:'Job created', detail:`${job.clientCompanyName||job.clientName} — ${job.country}`, at:new Date().toLocaleString() }];
  const jobs = getCompanyJobs(cid);
  jobs.push(job);
  saveCompanyJobs(cid, jobs);
  console.log(`[JOB SAVED] ${id} technician=${job.technician||'UNASSIGNED'} needsAssignment=${job.needsAssignment}`);
  addMessage(cid, id, 'job_created', `New job created: ${job.location} (${job.country}) for ${job.clientCompanyName||job.clientName}`, 'system');
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true, id });
});


// ── Add completed record (admin backdating) ───────────────────────────────────
app.post('/api/:companyId/jobs/record', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const { location, date, time, country, truck, technician, clientId,
          serviceType, unitType, notes, completion } = req.body;
  if (!location || !date) return res.json({ ok:false, error:'Location and date are required' });

  const users = getCompanyUsers(cid);
  const clientUser = clientId ? Object.values(users).find(u=>u.clientId===clientId) : null;

  const id = nextJobId(cid);

  // Build a fully-completed checklist
  function makeStep(id, label, done=true, extra={}) {
    return { id, label, done, ...extra };
  }
  const checklist = [
    { id:'accepted', title:'Service Acceptance', who:'installer', steps:[makeStep('job_accepted','Accept this service')] },
    { id:'pre',      title:'Pre-Service Confirmation', who:'installer', steps:[makeStep('pre_confirm','Confirm service is still happening')] },
    { id:'service',  title:'Service Check', who:'installer', steps:[
      makeStep('tech_onsite','Technician confirmed on-site'),
      makeStep('truck_onsite','Vehicle / truck confirmed on-site'),
      makeStep('service_complete','Service complete'),
    ]},
    { id:'documents', title:'Post-Service Documents', who:'both', steps:[
      { id:'doc_job_card',  label:'Job card',            done:false, requiresUpload:true,  uploadedFiles:[] },
      { id:'doc_checklist', label:'Inspection checklist',done:false, requiresUpload:true,  uploadedFiles:[] },
      { id:'doc_images',    label:'Images of job',       done:false, requiresUpload:true,  multipleFiles:true, uploadedFiles:[] },
      { id:'doc_notes',     label:'Additional notes',    done: !!(notes&&notes.trim()), isTextNote:true, noteText:notes||'', skipped:!(notes&&notes.trim()) },
    ]},
  ];

  const job = {
    id, location, name:location, truck:truck||'', technician:technician||'',
    country, date, time:time||'', serviceType:serviceType||'Installation',
    unitType:serviceType==='Inspection'?'N/A':(unitType||'Basic'),
    clientId:clientId||'', clientName:clientUser?.name||'',
    clientCompanyName:clientUser?.companyName||'',
    startDate:date, completionDate:completion||date,
    notes:[], status:'Completed',
    accepted:true, acceptedAt:date,
    truckConfirmed:true, systemOk:true, systemOkAt:completion||date,
    clientConfirmed:true, clientConfirmedAt:completion||date,
    checklist,
    activityLog:[
      { who:'Admin', role:'admin', event:'Record added manually', detail:`${location} — ${country}`, at:new Date().toLocaleString() }
    ]
  };

  const jobs = getCompanyJobs(cid);
  jobs.push(job);
  saveCompanyJobs(cid, jobs);
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true, id });
});

app.put('/api/:companyId/jobs/:id', requireCompanyAuth('admin'), (req, res) => {
  const cid  = req.params.companyId;
  const jobs = getCompanyJobs(cid);
  const idx  = jobs.findIndex(j=>j.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  jobs[idx] = { ...jobs[idx], ...req.body, id:jobs[idx].id };
  saveCompanyJobs(cid, jobs);
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

app.delete('/api/:companyId/jobs/:id', requireCompanyAuth('admin'), (req, res) => {
  const cid    = req.params.companyId;
  const jobId  = req.params.id;
  const jobs   = getCompanyJobs(cid).filter(j=>j.id!==jobId);
  saveCompanyJobs(cid, jobs);
  // Delete associated messages
  const msgs = getMessages(cid).filter(m=>m.job_id!==jobId);
  saveMessages(cid, msgs);
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Assign technician (when multiple installers in country)
app.post('/api/:companyId/jobs/:id/assign', requireCompanyAuth('admin'), (req, res) => {
  const cid  = req.params.companyId;
  const jobs = getCompanyJobs(cid);
  const job  = jobs.find(j=>j.id===req.params.id);
  if (!job) return res.status(404).json({ error:'Not found' });
  job.technician     = req.body.technician;
  job.needsAssignment = false;
  saveCompanyJobs(cid, jobs);
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// ── JOB ACTIONS ───────────────────────────────────────────────────────────────
function jobAction(companyId, jobId, fn) {
  const jobs = getCompanyJobs(companyId);
  const idx  = jobs.findIndex(j=>j.id===jobId);
  if (idx===-1) return null;
  fn(jobs[idx], jobs);
  saveCompanyJobs(companyId, jobs);
  return jobs[idx];
}

// Toggle checklist step
app.post('/api/:companyId/jobs/:id/step', requireCompanyAuth(), (req, res) => {
  const cid = req.params.companyId;
  const { secId, stepId, done, skipped, noteText } = req.body;
  const job = jobAction(cid, req.params.id, (job) => {
    const sec  = job.checklist?.find(s=>s.id===secId);
    const step = sec?.steps.find(s=>s.id===stepId);
    if (step) {
      if (typeof done    !== 'undefined') step.done    = done;
      if (typeof skipped !== 'undefined') step.skipped = skipped;
      if (typeof noteText!== 'undefined') { step.noteText = noteText; if (!step.done) step.done = noteText.trim().length > 0; }
    }
    // Re-check docCheckPending whenever a doc step changes
    if (secId === 'documents') {
      const docSec      = job.checklist?.find(s=>s.id==='documents');
      const uploadSteps = docSec?.steps.filter(s=>s.requiresUpload && !s.isTextNote);
      const noteSteps   = docSec?.steps.filter(s=>s.isTextNote);
      if (uploadSteps?.every(s=>s.done) && noteSteps?.every(s=>s.done||s.skipped)) {
        job.docCheckPending = true;
      }
    }
    job.status = computeStatus(job);
    if (secId==='service' && stepId==='service_complete' && done) {
      job.systemCheckPending = true;
    }
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Client confirms system OK
app.post('/api/:companyId/jobs/:id/system-ok', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    job.systemCheckPending = false;
    job.systemOk = true;
    addActivity(job, req.user.name, 'client', '✓ System confirmed working');
    job.status = computeStatus(job);
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Client confirms documents
app.post('/api/:companyId/jobs/:id/confirm-ok', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    job.clientConfirmed   = true;
    job.clientConfirmedAt = new Date().toLocaleString();
    addActivity(job, req.user.name, 'client', '🎉 Documents confirmed — job complete');
    job.status = 'Completed';
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Client reports problem
app.post('/api/:companyId/jobs/:id/report-problem', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const { message, checkpoint } = req.body;
  if (!message || !message.trim()) return res.json({ ok:false, error:'Please describe the problem.' });
  const job = jobAction(cid, req.params.id, (job) => {
    job.problemReport = {
      message: message.trim(),
      checkpoint: checkpoint || 'system', // 'system' or 'documents'
      reportedAt: new Date().toLocaleString(),
      reportedBy: req.user.name,
      status: 'open'
    };
    // Reset confirmation so client gets the prompt again after fix
    if (checkpoint === 'system') { job.systemCheckPending = true; job.systemOk = false; }
    if (checkpoint === 'documents') { job.docCheckPending = true; job.clientConfirmed = false; }
    addActivity(job, req.user.name, 'client', '⚠ Problem reported', message.trim());
    job.status = computeStatus(job);
    addMessage(cid, job.id, 'problem_reported', `⚠ Problem on ${job.id}: "${message.trim()}"`, 'client');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Installer marks problem as fixed
app.post('/api/:companyId/jobs/:id/problem-fixed', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const { note } = req.body;
  if (!note || !note.trim()) return res.json({ ok:false, error:'Please describe what you fixed.' });
  const job = jobAction(cid, req.params.id, (job) => {
    if (job.problemReport) {
      job.problemReport.status      = 'fixed';
      job.problemReport.fixedBy     = req.user.name;
      job.problemReport.fixedAt     = new Date().toLocaleString();
      job.problemReport.fixNote     = note.trim();
    }
    addActivity(job, req.user.name, 'installer', '🔧 Problem fixed', note.trim());
    addMessage(cid, job.id, 'problem_fixed', `🔧 Installer fixed issue on ${job.id}: "${note.trim()}"`, 'installer');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Admin resolves problem — client gets prompt again
app.post('/api/:companyId/jobs/:id/problem-resolved', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    const checkpoint = job.problemReport?.checkpoint || 'system';
    job.problemReport = null;
    // Re-trigger the client prompt
    if (checkpoint === 'system') { job.systemCheckPending = true; job.systemOk = false; }
    if (checkpoint === 'documents') { job.docCheckPending = true; job.clientConfirmed = false; }
    addActivity(job, req.user.name, 'admin', '✓ Problem resolved — client re-prompted');
    job.status = computeStatus(job);
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Truck unavailable
app.post('/api/:companyId/jobs/:id/truck-unavailable', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.json({ ok:false, error:'Please provide a reason.' });
  const job = jobAction(cid, req.params.id, (job) => {
    job.truckUnavailable       = true;
    job.truckUnavailableReason = reason.trim();
    job.truckUnavailableAt     = new Date().toLocaleString();
    job.clientTruckReply       = null;
    addActivity(job, req.user.name, 'installer', '🚫 Truck marked unavailable', reason.trim());
    addMessage(cid, job.id, 'truck_unavailable', `🚫 Truck unavailable on ${job.id}: "${reason.trim()}"`, 'installer');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

app.post('/api/:companyId/jobs/:id/truck-unavailable/undo', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    job.truckUnavailable       = false;
    job.truckUnavailableReason = '';
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Set truck number
app.post('/api/:companyId/jobs/:id/set-truck', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    if (!job.truckConfirmed) { job.truck = req.body.truck; job.truckConfirmed = true; }
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Admin edit field
app.post('/api/:companyId/jobs/:id/edit', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    const allowed = ['truck','date','time','unitType','serviceType','technician'];
    allowed.forEach(k => { if (req.body[k] !== undefined) job[k] = req.body[k]; });
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Add note
app.post('/api/:companyId/jobs/:id/notes', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    job.notes = job.notes || [];
    job.notes.push({ text: req.body.text, date: new Date().toLocaleString(), by: req.user.name });
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Also accept /note (singular) for admin
app.post('/api/:companyId/jobs/:id/note', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    job.notes = job.notes || [];
    job.notes.push({ text: req.body.text, date: new Date().toLocaleString(), by: req.user.name });
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Delete a note by index
app.delete('/api/:companyId/jobs/:id/note/:idx', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const idx = parseInt(req.params.idx);
  const job = jobAction(cid, req.params.id, (job) => {
    if (job.notes && job.notes[idx] !== undefined) job.notes.splice(idx, 1);
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// Reschedule
app.post('/api/:companyId/jobs/:id/reschedule', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const { proposedDate, proposedTime, note } = req.body;
  if (!proposedDate) return res.json({ ok:false, error:'Date required' });
  const job = jobAction(cid, req.params.id, (job) => {
    job.rescheduleThread = job.rescheduleThread || [];
    job.rescheduleThread.push({ by:req.user.name, role:'installer', proposedDate, proposedTime, note, at:new Date().toLocaleString() });
    job.rescheduleProposal = { proposedDate, proposedTime, note, proposedBy:req.user.name+' (installer)', status:'pending' };
    addActivity(job, req.user.name, 'installer', '📅 Reschedule proposed', `${proposedDate}${proposedTime?' at '+proposedTime:''}${note?' — '+note:''}`);
    addMessage(cid, job.id, 'reschedule_proposed', `📅 Installer proposed new time for ${job.id}: ${proposedDate}${proposedTime?' at '+proposedTime:''}`, 'installer');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

app.post('/api/:companyId/jobs/:id/reschedule/suggest', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const { proposedDate, proposedTime, note } = req.body;
  const job = jobAction(cid, req.params.id, (job) => {
    job.rescheduleThread = job.rescheduleThread || [];
    job.rescheduleThread.push({ by:req.user.name, role:'client', proposedDate, proposedTime, note, at:new Date().toLocaleString() });
    job.rescheduleProposal = { proposedDate, proposedTime, note, proposedBy:req.user.name+' (client)', status:'pending' };
    addActivity(job, req.user.name, 'client', '📅 Reschedule proposed', `${proposedDate}${proposedTime?' at '+proposedTime:''}${note?' — '+note:''}`);
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});


// Client responds to installer's reschedule proposal
app.post('/api/:companyId/jobs/:id/reschedule/respond', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const { accept } = req.body;
  const job = jobAction(cid, req.params.id, (job) => {
    if (!job.rescheduleProposal) return;
    job.rescheduleThread = job.rescheduleThread || [];
    if (accept) {
      if (job.rescheduleProposal.proposedDate) job.date = job.rescheduleProposal.proposedDate;
      if (job.rescheduleProposal.proposedTime) job.time = job.rescheduleProposal.proposedTime;
      job.rescheduleProposal.status = 'accepted';
      job.rescheduleThread = job.rescheduleThread || [];
      job.rescheduleThread.push({ by:req.user.name, role:'client', action:'accepted', at:new Date().toLocaleString() });
      // Auto-start: if installer proposed this reschedule, client accepting it starts the job
      if (!job.accepted) {
        job.accepted   = true;
        job.acceptedAt = new Date().toLocaleString();
        // Tick the checklist acceptance step so computeStatus moves past Pending Acceptance
        const acceptSec  = job.checklist?.find(s=>s.id==='accepted');
        const acceptStep = acceptSec?.steps.find(s=>s.id==='job_accepted');
        if (acceptStep) acceptStep.done = true;
        addActivity(job, 'System', 'system', 'Job auto-started — client accepted new time');
      }
      job.status = computeStatus(job);
      addActivity(job, req.user.name, 'client', '✓ New time accepted', job.date+(job.time?' at '+job.time:''));
    } else {
      job.rescheduleProposal.status = 'rejected';
      job.rescheduleThread.push({ by:req.user.name, role:'client', action:'rejected', at:new Date().toLocaleString() });
    }
    job.status = computeStatus(job);
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

app.post('/api/:companyId/jobs/:id/reschedule/installer-respond', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const { accept } = req.body;
  const job = jobAction(cid, req.params.id, (job) => {
    if (!job.rescheduleProposal) return;
    job.rescheduleThread = job.rescheduleThread || [];
    if (accept) {
      job.date = job.rescheduleProposal.proposedDate || job.date;
      job.time = job.rescheduleProposal.proposedTime || job.time;
      job.rescheduleProposal.status = 'accepted';
      job.rescheduleThread.push({ by:req.user.name, role:'installer', action:'accepted', at:new Date().toLocaleString() });
    } else {
      job.rescheduleProposal.status = 'rejected';
      job.rescheduleThread.push({ by:req.user.name, role:'installer', action:'rejected', at:new Date().toLocaleString() });
    }
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// ── FILE UPLOAD ───────────────────────────────────────────────────────────────
app.post('/api/:companyId/jobs/:id/upload', requireCompanyAuth(), upload.single('file'), async (req, res) => {
  const cid = req.params.companyId;
  const jobId = req.params.id;
  if (!req.file) return res.json({ ok:false, error:'No file' });
  const { secId, stepId } = req.body;
  try {
    // Upload to R2 (or local fallback) under companyId/jobId/filename
    const { uploadFile } = require('./storage');
    const ts       = Date.now();
    const safeName = ts + '_' + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    const result   = await uploadFile(cid, jobId, safeName, req.file.buffer, req.file.mimetype);
    const fileUrl  = result.url;
    const job = jobAction(cid, jobId, (job) => {
      const sec  = job.checklist?.find(s=>s.id===secId);
      const step = sec?.steps.find(s=>s.id===stepId);
      if (step) {
        step.uploadedFiles = step.uploadedFiles || [];
        step.uploadedFiles.push({ filename:safeName, original:req.file.originalname, fileUrl });
        step.done = true;
      }
      const docSec      = job.checklist?.find(s=>s.id==='documents');
      const uploadSteps = docSec?.steps.filter(s=>s.requiresUpload && !s.isTextNote);
      const noteSteps   = docSec?.steps.filter(s=>s.isTextNote);
      const uploadsDone = uploadSteps?.every(s=>s.done);
      const notesDone   = noteSteps?.every(s=>s.done||s.skipped);
      if (uploadsDone && notesDone) job.docCheckPending = true;
    });
    if (!job) return res.json({ ok:false, error:'Job not found' });
    broadcast(cid, { type:'refresh' });
    res.json({ ok:true, fileUrl });
  } catch(err) {
    console.error('Upload error:', err);
    res.json({ ok:false, error:'Upload failed: ' + err.message });
  }
});

app.delete('/api/:companyId/jobs/:id/file', requireCompanyAuth(), async (req, res) => {
  const cid = req.params.companyId;
  const jobId = req.params.id;
  const { secId, stepId, filename } = req.body;
  try {
    const { deleteFile } = require('./storage');
    await deleteFile(cid, jobId, filename);
  } catch(e) { /* ignore delete errors */ }
  const job = jobAction(cid, jobId, (job) => {
    const sec  = job.checklist?.find(s=>s.id===secId);
    const step = sec?.steps.find(s=>s.id===stepId);
    if (step?.uploadedFiles) {
      step.uploadedFiles = step.uploadedFiles.filter(f=>f.filename!==filename);
      step.done = step.uploadedFiles.length > 0;
    }
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});


// Client replies to truck unavailable
app.post('/api/:companyId/jobs/:id/truck-reply', requireCompanyAuth('client'), (req, res) => {
  const cid = req.params.companyId;
  const { message } = req.body;
  if (!message || !message.trim()) return res.json({ ok:false, error:'Please type a message.' });
  const job = jobAction(cid, req.params.id, (job) => {
    job.clientTruckReply = { message: message.trim(), at: new Date().toLocaleString(), by: req.user.name };
    addActivity(job, req.user.name, 'client', '💬 Client replied to truck issue', message.trim());
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/:companyId/events', (req, res) => {
  const auth  = req.headers['authorization'] || req.query.token || '';
  const token = auth.replace('Bearer ','').trim();
  const user  = getUserByToken(token);
  if (!user) return res.status(401).end();

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.write('data: {"type":"connected"}\n\n');

  const client = { res, companyId: req.params.companyId, role: user.role };
  sseClients.push(client);
  req.on('close', () => {
    const i = sseClients.indexOf(client);
    if (i>-1) sseClients.splice(i,1);
  });
});


// ── ACCEPT JOB (installer) ────────────────────────────────────────────────────
app.post('/api/:companyId/jobs/:id/accept', requireCompanyAuth('installer'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    const sec  = job.checklist?.find(s=>s.id==='accepted');
    const step = sec?.steps.find(s=>s.id==='job_accepted');
    if (step) step.done = true;
    job.accepted   = true;
    job.acceptedAt = new Date().toLocaleString();
    addActivity(job, req.user.name, 'installer', 'Job accepted');
    job.status = computeStatus(job);
    addMessage(cid, job.id, 'job_accepted', `${req.user.name} accepted job ${job.id}: ${job.location}`, 'installer');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});

// ── MESSAGES (per company, stored in company dir) ─────────────────────────────
function getMessages(cid) {
  return readJSON(companyFile(cid, 'messages.json'), []);
}
function saveMessages(cid, msgs) {
  writeJSON(companyFile(cid, 'messages.json'), msgs);
}

app.get('/api/:companyId/messages', requireCompanyAuth('admin'), (req, res) => {
  res.json(getMessages(req.params.companyId));
});

app.get('/api/:companyId/messages/unread', requireCompanyAuth('admin'), (req, res) => {
  const msgs = getMessages(req.params.companyId);
  res.json({ count: msgs.filter(m=>!m.read).length });
});

app.delete('/api/:companyId/messages', requireCompanyAuth('admin'), (req, res) => {
  saveMessages(req.params.companyId, []);
  res.json({ ok:true });
});

app.post('/api/:companyId/messages/read', requireCompanyAuth('admin'), (req, res) => {
  const cid  = req.params.companyId;
  const msgs = getMessages(cid).map(m=>({...m, read:true}));
  saveMessages(cid, msgs);
  res.json({ ok:true });
});

// Helper to add a message
function addMessage(cid, jobId, type, body, fromRole='system') {
  const msgs = getMessages(cid);
  msgs.unshift({ id:Date.now(), job_id:jobId, type, body, from_role:fromRole, read:false, created_at:new Date().toLocaleString() });
  if (msgs.length > 200) msgs.splice(200);
  saveMessages(cid, msgs);
  broadcast(cid, { type:'new_message' });
}


// ── CREDENTIALS CHANGE ────────────────────────────────────────────────────────
// Admin changes their own credentials
app.post('/api/:companyId/users/:username/credentials', requireCompanyAuth('admin'), (req, res) => {
  const cid  = req.params.companyId;
  const users = getCompanyUsers(cid);
  const user  = users[req.params.username];
  if (!user) return res.json({ ok:false, error:'User not found' });
  const { newUsername, password } = req.body;
  if (password) user.password = password;
  if (newUsername && newUsername !== req.params.username) {
    if (users[newUsername]) return res.json({ ok:false, error:'Username already taken' });
    users[newUsername] = { ...user, username:newUsername };
    delete users[req.params.username];
    // Update token
    const auth = req.headers['authorization']||'';
    const token = auth.replace('Bearer ','').trim();
    if (tokenStore[token]) { tokenStore[token].username = newUsername; saveTokens(); }
  } else {
    users[req.params.username] = user;
  }
  saveCompanyUsers(cid, users);
  res.json({ ok:true });
});

// HQ changes a company admin's credentials
app.post('/api/hq/companies/:companyId/users/:username/credentials', requireAuth('hq'), (req, res) => {
  const cid   = req.params.companyId;
  const users = getCompanyUsers(cid);
  const user  = users[req.params.username];
  if (!user) return res.json({ ok:false, error:'User not found' });
  const { newUsername, newPassword } = req.body;
  if (newPassword) user.password = newPassword;
  if (newUsername && newUsername !== req.params.username) {
    if (users[newUsername]) return res.json({ ok:false, error:'Username already taken' });
    users[newUsername] = { ...user, username:newUsername };
    delete users[req.params.username];
  } else {
    users[req.params.username] = user;
  }
  saveCompanyUsers(cid, users);
  res.json({ ok:true });
});

// HQ changes its own credentials
app.post('/api/hq/credentials', requireAuth('hq'), (req, res) => {
  const { newUsername, newPassword } = req.body;
  const hq = getHQ();
  if (newPassword) hq.password = newPassword;
  if (newUsername) hq.username = newUsername;
  writeJSON(path.join(DB_DIR, 'superadmin', 'hq.json'), hq);
  // Invalidate token so they log in again
  const auth  = req.headers['authorization']||'';
  const token = auth.replace('Bearer ','').trim();
  if (token) { delete tokenStore[token]; saveTokens(); }
  res.json({ ok:true });
});




// ── Legacy R2 file proxy ──────────────────────────────────────────────────────
// Migrated jobs have file URLs pointing to /r2/ which were served by the old system.
// This route proxies those requests to the old system's URL if configured,
// or redirects directly if OLD_SYSTEM_URL is set as an environment variable.
const OLD_SYSTEM_URL = process.env.OLD_SYSTEM_URL || '';
app.get('/r2/*', async (req, res) => {
  // Strip /r2/ prefix to get the storage key
  const key = req.params[0];
  try {
    const { getFileStream, R2_CONFIGURED } = require('./storage');
    if (R2_CONFIGURED) {
      const result = await getFileStream(key);
      if (result) {
        res.setHeader('Content-Type', result.contentType || 'application/octet-stream');
        result.stream.pipe(res);
        return;
      }
    }
  } catch(e) { /* fall through */ }
  // Fallback: redirect to old system if configured
  if (OLD_SYSTEM_URL) return res.redirect(OLD_SYSTEM_URL + '/r2/' + key);
  res.status(404).json({ error: 'File not found' });
});


// ── Admin force-complete ──────────────────────────────────────────────────────
app.post('/api/:companyId/jobs/:id/force-complete', requireCompanyAuth('admin'), (req, res) => {
  const cid = req.params.companyId;
  const job = jobAction(cid, req.params.id, (job) => {
    // Tick all checklist steps
    (job.checklist||[]).forEach(sec => sec.steps.forEach(step => { step.done = true; }));
    job.forceCompleted      = true;
    job.forceCompletedBy    = req.user.name || 'Admin';
    job.forceCompletedAt    = new Date().toLocaleString();
    job.clientConfirmed     = true;
    job.clientConfirmedAt   = new Date().toLocaleString();
    job.completionDate      = new Date().toISOString().slice(0,10);
    job.status              = 'Completed';
    addActivity(job, req.user.name, 'admin', '⚠ Job force-completed by admin', req.body.reason||'');
  });
  if (!job) return res.status(404).json({ error:'Not found' });
  broadcast(cid, { type:'refresh' });
  res.json({ ok:true });
});


// ── Email via Resend ──────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const hq = getHQ();
  const apiKey = process.env.RESEND_API_KEY || hq.resendApiKey || '';
  const from   = process.env.FROM_EMAIL     || hq.fromEmail    || 'notification@web-anchor.com';
  if (!apiKey || !to) return { ok:false, error: !apiKey ? 'No API key configured' : 'No recipient' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer '+apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    const data = await res.json();
    if (data.id) return { ok:true, id:data.id };
    return { ok:false, error: data.message || JSON.stringify(data) };
  } catch(e) {
    return { ok:false, error: e.message };
  }
}

function jobEmailHtml(heading, body, jobInfo) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f6f9;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;margin-bottom:12px">TRIFUSION</div>
    <h2 style="color:#1e293b;margin:0 0 12px">${heading}</h2>
    <p style="color:#475569;line-height:1.6;margin:0 0 16px">${body}</p>
    ${jobInfo ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;color:#374151">${jobInfo}</div>` : ''}
    <p style="font-size:11px;color:#94a3b8;margin:0">Powered by WebAncher</p>
  </div></body></html>`;
}


app.post('/api/test-email', requireAuth(), async (req, res) => {
  const { to } = req.body;
  const toEmail = to || req.user.email || '';
  if (!toEmail) return res.json({ ok:false, error:'Please enter an email address to test with.' });
  const result = await sendEmail({
    to: toEmail,
    subject: 'Trifusion — Test Email ✓',
    html: jobEmailHtml('Test Email', 'This is a test email from your Trifusion system. If you received this, your email sending is working correctly! ✓', '<strong>From:</strong> Trifusion via WebAncher')
  });
  if (result.ok) res.json({ ok:true, to:toEmail });
  else res.json({ ok:false, error:result.error });
});

// ── PAGE ROUTES ───────────────────────────────────────────────────────────────
app.get('/',         (req,res) => res.sendFile(path.join(PUBLIC_DIR,'login.html')));
app.get('/signup',   (req,res) => res.sendFile(path.join(PUBLIC_DIR,'signup','index.html')));
app.get('/hq',       (req,res) => res.sendFile(path.join(PUBLIC_DIR,'hq','index.html')));
app.get('/:cid/admin',     (req,res) => res.sendFile(path.join(PUBLIC_DIR,'company','admin','index.html')));
app.get('/:cid/client',    (req,res) => res.sendFile(path.join(PUBLIC_DIR,'company','client','index.html')));
app.get('/:cid/installer', (req,res) => res.sendFile(path.join(PUBLIC_DIR,'company','installer','index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
// ── Database seed (runs on startup if DB is empty) ────────────────────────────
function seedDatabase() {
  // Seed superadmin
  const hqFile = path.join(DB_DIR, 'superadmin', 'hq.json');
  fs.mkdirSync(path.dirname(hqFile), { recursive: true });
  if (!fs.existsSync(hqFile)) {
    writeJSON(hqFile, { username:'webancherhq', password:'hq@WebAncher2025', name:'WebAncher HQ', resendApiKey:'' });
    console.log('[SEED] Created HQ credentials');
  }

  const companiesFile = path.join(DB_DIR, 'superadmin', 'companies.json');
  if (!fs.existsSync(companiesFile)) {
    writeJSON(companiesFile, [{ companyId:'trifusion', companyName:'Trifusion', adminName:'Zander', status:'active', createdAt:'2025-01-01' }]);
    console.log('[SEED] Created companies');
  }

  // Seed Trifusion company
  const trifDir = path.join(DB_DIR, 'companies', 'trifusion');
  fs.mkdirSync(trifDir, { recursive: true });

  const usersFile = path.join(trifDir, 'users.json');
  if (!fs.existsSync(usersFile)) {
    writeJSON(usersFile, {
      admin:   { username:'admin',   password:'admin123',   role:'admin',     name:'Zander',  companyId:'trifusion', email:'', createdAt:'2025-01-01' },
      david:   { username:'david',   password:'korridor123',role:'client',    name:'David',   clientId:'david',  companyName:'Korridor', companyId:'trifusion', email:'', createdAt:'2025-01-01' },
      natan:   { username:'natan',   password:'korridor456',role:'client',    name:'Natan',   clientId:'natan',  companyName:'Korridor', companyId:'trifusion', email:'', createdAt:'2025-01-01' },
      brigade: { username:'brigade', password:'brigade123', role:'installer', name:'Brigade', installer:'Brigade', companyName:'Brigade', countries:['South Africa'], companyId:'trifusion', email:'', createdAt:'2025-01-01' },
      zamaka:  { username:'zamaka',  password:'zamaka123',  role:'installer', name:'Zamaka',  installer:'Zamaka',  companyName:'Zamaka',  countries:['Zambia'],       companyId:'trifusion', email:'', createdAt:'2025-01-01' },
    });
    console.log('[SEED] Created Trifusion users');
  }

  const settingsFile = path.join(trifDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    writeJSON(settingsFile, { companyName:'Trifusion', adminName:'Zander', branding:{}, emails:{}, jobCounter:0 });
    console.log('[SEED] Created Trifusion settings');
  }

  const jobsFile = path.join(trifDir, 'jobs.json');
  if (!fs.existsSync(jobsFile)) {
    writeJSON(jobsFile, []);
    console.log('[SEED] Created empty jobs file');
  }

  const tokensFile = path.join(DB_DIR, 'superadmin', 'tokens.json');
  if (!fs.existsSync(tokensFile)) {
    writeJSON(tokensFile, {});
    console.log('[SEED] Created tokens file');
  }

  const signupsFile = path.join(DB_DIR, 'superadmin', 'signups.json');
  if (!fs.existsSync(signupsFile)) {
    writeJSON(signupsFile, []);
  }

  // Patch existing installers missing companyName
  try {
    const trifDir2 = path.join(DB_DIR, 'companies', 'trifusion');
    const uFile2 = path.join(trifDir2, 'users.json');
    if (fs.existsSync(uFile2)) {
      const u2 = readJSON(uFile2, {});
      let patched = false;
      Object.values(u2).forEach(user => {
        if (user.role === 'installer' && !user.companyName) {
          user.companyName = user.installer || user.name || '';
          patched = true;
        }
      });
      if (patched) { writeJSON(uFile2, u2); console.log('[SEED] Patched installer companyNames'); }
    }
  } catch(e) {}
  console.log('[SEED] Database check complete');
}

seedDatabase();


app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Trifusion Platform v2                ║');
  console.log(`║   Open:  http://localhost:${PORT}          ║`);
  console.log('╚════════════════════════════════════════╝');
});
