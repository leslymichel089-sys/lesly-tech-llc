// server.js — Lesly Tech LLC, site vitrine officiel (v2).
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');

const dbm = require('./db');
const { middleware: i18n, descFor } = require('./i18n');
const { middleware: csrf, verify: csrfVerify } = require('./csrf');
const ai = require('./ai');
const watchdog = require('./watchdog');
const notify = require('./notify');

// Les couvertures sont versionnées en base64 (*.jpg.b64) car certains modes de
// déploiement ne transportent pas le binaire. On les restaure en .jpg au démarrage.
(function restoreCovers() {
  try {
    const dir = path.join(__dirname, 'public', 'img', 'covers');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jpg.b64')) continue;
      const target = path.join(dir, f.slice(0, -4));
      let ok = false;
      try {
        const head = fs.readFileSync(target).subarray(0, 3);
        ok = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
      } catch { ok = false; }
      if (!ok) {
        const b64 = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\s+/g, '');
        fs.writeFileSync(target, Buffer.from(b64, 'base64'));
        console.log('[covers] restauré:', path.basename(target));
      }
    }
  } catch (e) { console.error('[covers]', e.message); }
})();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'changez-moi-en-production',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
}));
app.use(i18n);
app.use(csrf);

// Upload d'images produits.
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + (/^\.(png|jpe?g|webp|gif)$/.test(ext) ? ext : '.png'));
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Helpers ----------
function parseLinksTextarea(text) {
  const links = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim(); if (!t) continue;
    const i = t.indexOf('|');
    if (i > 0) {
      const label = t.slice(0, i).trim(), url = t.slice(i + 1).trim();
      if (label && /^https?:\/\//i.test(url)) links.push({ label, url });
    }
  }
  return links;
}
function linksToTextarea(links) {
  return (links || []).map((l) => `${l.label} | ${l.url}`).join('\n');
}

// ---------- Variables globales des vues ----------
app.use((req, res, next) => {
  res.locals.siteUrl = SITE_URL;
  res.locals.descFor = descFor;
  res.locals.isAdmin = !!req.session.admin;
  next();
});

// ---------- Page de maintenance (site désactivé ; l'admin reste accessible) ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/lang')) return next();
  if (dbm.getSetting('site_enabled') === '0') {
    return res.status(503).render('maintenance', { page: 'maintenance' });
  }
  next();
});

// ---------- Watchdog branché sur le routeur IA ----------
ai.onEvent((ev) => {
  if (ev.kind === 'failover') {
    watchdog.fire('ai_failover', 'Bascule IA',
      `OmniRoute a basculé (${ev.error}) — relais : ${ev.to}.`).catch(() => {});
  } else if (ev.kind === 'all_failed') {
    watchdog.fire('ai_failover', 'IA : tous les providers en échec',
      `Aucun provider IA n'a répondu : ${(ev.errors || []).join(' ; ')}`.slice(0, 500)).catch(() => {});
  }
});

// ---------- Compteur de visites + pic de visites (watchdog) ----------
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/go')) {
    dbm.logVisit(req.path);
    watchdog.checkVisitsSpike().catch(() => {});
  }
  next();
});

// ---------- Langue ----------
app.get('/lang/:code', (req, res) => {
  const code = ['fr', 'en', 'ht', 'es'].includes(req.params.code) ? req.params.code : 'fr';
  res.setHeader('Set-Cookie', `lang=${code}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`);
  res.redirect(req.get('Referer') || '/');
});

// ---------- Pages publiques ----------
app.get('/', (req, res) => {
  const products = dbm.qAll.all().map(dbm.rowToProduct);
  res.render('index', { page: 'home', products });
});

app.get('/catalogue', (req, res) => {
  const filter = ['app', 'ebook', 'autre'].includes(req.query.type) ? req.query.type : '';
  let products = filter
    ? dbm.qByType.all(filter).map(dbm.rowToProduct)
    : dbm.qAll.all().map(dbm.rowToProduct);
  res.render('catalogue', { page: 'catalogue', products, filter });
});

app.get('/ebooks', (req, res) => {
  const ebooks = dbm.qByType.all('ebook').map(dbm.rowToProduct);
  res.render('ebooks', { page: 'ebooks', ebooks });
});

app.get('/produit/:id', (req, res) => {
  const p = dbm.rowToProduct(dbm.qById.get(req.params.id));
  if (!p || !p.active) return res.status(404).render('404', { page: '' });
  const related = dbm.qAll.all().map(dbm.rowToProduct).filter((x) => x.id !== p.id).slice(0, 3);
  res.render('produit', { page: 'produit', product: p, related });
});

// Redirection comptée vers une plateforme externe.
app.get('/go/:id/:index', (req, res) => {
  const p = dbm.rowToProduct(dbm.qById.get(req.params.id));
  const link = p && p.links[parseInt(req.params.index, 10)];
  if (!p || !p.active || !link) return res.status(404).render('404', { page: '' });
  dbm.logClick(p.id, link.label, link.url);
  res.redirect(302, link.url);
});

app.get('/confidentialite', (req, res) => res.render('legal', { page: 'confidentialite', doc: 'privacy' }));
app.get('/propriete-intellectuelle', (req, res) => res.render('legal', { page: 'propriete', doc: 'ip' }));

// ---------- Admin ----------
function hasSecret() { return !!dbm.getSetting('admin_code_hash'); }
function requireLogin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin');
  next();
}

app.get('/admin', (req, res) => {
  if (!hasSecret()) return res.render('admin/setup', { page: 'admin', error: null });
  if (!req.session.admin) return res.render('admin/login', { page: 'admin', error: null });
  const s = dbm.stats();
  const products = dbm.db.prepare('SELECT * FROM products ORDER BY id').all().map(dbm.rowToProduct);
  const enabled = dbm.getSetting('site_enabled') !== '0';
  res.render('admin/dashboard', { page: 'admin', products, enabled, stats: s });
});

app.post('/admin/setup', (req, res) => {
  if (hasSecret()) return res.redirect('/admin');
  const code = String(req.body.code || ''), confirm = String(req.body.confirm || '');
  if (code.length < 6)
    return res.render('admin/setup', { page: 'admin', error: res.locals.t('admin_setup_error_short') });
  if (code !== confirm)
    return res.render('admin/setup', { page: 'admin', error: res.locals.t('admin_setup_error_mismatch') });
  dbm.setSetting('admin_code_hash', bcrypt.hashSync(code, 10));
  req.session.admin = true;
  res.redirect('/admin');
});

app.post('/admin/login', (req, res) => {
  if (!hasSecret()) return res.redirect('/admin');
  const hash = dbm.getSetting('admin_code_hash');
  if (bcrypt.compareSync(String(req.body.code || ''), hash)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { page: 'admin', error: res.locals.t('admin_login_error') });
});

app.post('/admin/logout', requireLogin, (req, res) => {
  req.session.admin = false;
  res.redirect('/');
});

app.post('/admin/toggle-site', requireLogin, (req, res) => {
  const enabled = dbm.getSetting('site_enabled') !== '0';
  dbm.setSetting('site_enabled', enabled ? '0' : '1');
  watchdog.fire('site_toggle', 'Site ' + (enabled ? 'désactivé' : 'réactivé'),
    enabled ? 'Le site vitrine a été DÉSACTIVÉ (les visiteurs voient la page de maintenance).'
            : 'Le site vitrine a été RÉACTIVÉ.').catch(() => {});
  res.redirect('/admin');
});

// ---------- Admin : CRUD produits ----------
app.get('/admin/products/new', requireLogin, (req, res) => {
  res.render('admin/product_form', { page: 'admin', product: null, linksText: '' });
});

app.post('/admin/products', requireLogin, upload.single('image'), csrfVerify, (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim();
  dbm.db.prepare(`
    INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, links, version, active)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @links, @version, @active)
  `).run({
    title,
    type: ['app', 'ebook', 'autre'].includes(b.type) ? b.type : 'autre',
    desc_fr: String(b.desc_fr || ''), desc_en: String(b.desc_en || ''),
    desc_ht: String(b.desc_ht || ''), desc_es: String(b.desc_es || ''),
    image: req.file ? '/uploads/' + req.file.filename : '',
    links: JSON.stringify(parseLinksTextarea(b.links)),
    version: String(b.version || '').trim() || '1.0',
    active: b.active ? 1 : 0,
  });
  watchdog.fire('product_added', 'Produit ajouté', `« ${title} » a été ajouté au catalogue.`).catch(() => {});
  res.redirect('/admin');
});

app.get('/admin/products/:id/edit', requireLogin, (req, res) => {
  const p = dbm.rowToProduct(dbm.qById.get(req.params.id));
  if (!p) return res.status(404).render('404', { page: '' });
  res.render('admin/product_form', { page: 'admin', product: p, linksText: linksToTextarea(p.links) });
});

app.post('/admin/products/:id', requireLogin, upload.single('image'), csrfVerify, (req, res) => {
  const p = dbm.qById.get(req.params.id);
  if (!p) return res.status(404).render('404', { page: '' });
  const b = req.body;
  let image = p.image;
  if (req.file) {
    if (image && image.startsWith('/uploads/')) { try { fs.unlinkSync(path.join(__dirname, 'public', image)); } catch (e) {} }
    image = '/uploads/' + req.file.filename;
  }
  dbm.db.prepare(`
    UPDATE products SET title=@title, type=@type, desc_fr=@desc_fr, desc_en=@desc_en,
      desc_ht=@desc_ht, desc_es=@desc_es, image=@image, links=@links, version=@version, active=@active
    WHERE id=@id
  `).run({
    id: p.id, title: String(b.title || '').trim(),
    type: ['app', 'ebook', 'autre'].includes(b.type) ? b.type : 'autre',
    desc_fr: String(b.desc_fr || ''), desc_en: String(b.desc_en || ''),
    desc_ht: String(b.desc_ht || ''), desc_es: String(b.desc_es || ''),
    image, links: JSON.stringify(parseLinksTextarea(b.links)),
    version: String(b.version || '').trim() || '1.0',
    active: b.active ? 1 : 0,
  });
  res.redirect('/admin');
});

app.post('/admin/products/:id/delete', requireLogin, (req, res) => {
  const p = dbm.qById.get(req.params.id);
  if (p) {
    if (p.image && p.image.startsWith('/uploads/')) { try { fs.unlinkSync(path.join(__dirname, 'public', p.image)); } catch (e) {} }
    dbm.db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    watchdog.fire('product_removed', 'Produit retiré', `« ${p.title} » a été retiré du catalogue.`).catch(() => {});
  }
  res.redirect('/admin');
});

app.post('/admin/products/:id/toggle-active', requireLogin, (req, res) => {
  dbm.db.prepare('UPDATE products SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/products/:id/toggle-update', requireLogin, (req, res) => {
  const p = dbm.qById.get(req.params.id);
  dbm.db.prepare('UPDATE products SET update_available = 1 - update_available WHERE id = ?').run(req.params.id);
  if (p) {
    const activated = !p.update_available;
    watchdog.fire('update_flag', 'Drapeau « mise à jour » modifié',
      `« ${p.title} » : badge « mise à jour disponible » ${activated ? 'ACTIVÉ' : 'retiré'}.`).catch(() => {});
  }
  res.redirect('/admin');
});

// ---------- Admin : API stats live (JSON) ----------
app.get('/admin/api/stats', requireLogin, (req, res) => {
  const s = dbm.stats();
  res.json({
    ok: true,
    enabled: dbm.getSetting('site_enabled') !== '0',
    visitsTotal: s.visitsTotal,
    visitsDays: s.visitsDays.slice().reverse(),
    productsCount: s.productsCount,
    clicksTotal: s.clicksTotal,
    clicksByLink: s.clicksByLink,
    recentActivity: s.recentActivity,
    generatedAt: new Date().toISOString(),
  });
});

// ---------- Admin : génération de description via OmniRoute ----------
app.post('/admin/ai/generate', requireLogin, async (req, res) => {
  try {
    const text = await ai.generateDescription(
      String(req.body.prompt || ''), String(req.body.lang || req.lang || 'fr'));
    res.json({ ok: true, text });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- Admin : configuration IA (DeepSeek -> Kimi -> secours) ----------
const AI_FIELDS = [
  ['deepseek_key', 'DEEPSEEK_API_KEY', 'ai_deepseek_key', true],
  ['deepseek_base_url', 'DEEPSEEK_BASE_URL', 'ai_deepseek_base_url'],
  ['deepseek_model', 'DEEPSEEK_MODEL', 'ai_deepseek_model'],
  ['kimi_key', 'KIMI_API_KEY', 'ai_kimi_key', true],
  ['kimi_base_url', 'KIMI_BASE_URL', 'ai_kimi_base_url'],
  ['kimi_model', 'KIMI_MODEL', 'ai_kimi_model'],
];

function aiSourceOf(envName, dbKey) {
  if (process.env[envName]) return 'env';
  if (dbm.getSetting(dbKey)) return 'admin';
  return null;
}

function aiPageData() {
  const creds = {}, credSrc = {};
  for (const [form, envName, dbKey, secret] of AI_FIELDS) {
    credSrc[form] = aiSourceOf(envName, dbKey);
    const v = dbm.getSetting(dbKey) || '';
    creds[form] = secret ? (v ? MASK : '') : v;
  }
  return { aiCreds: creds, aiCredSrc: credSrc };
}

app.get('/admin/ai', requireLogin, (req, res) => {
  res.render('admin/ai', { page: 'admin', ...aiPageData(), saved: false });
});

app.post('/admin/ai/credentials', requireLogin, (req, res) => {
  for (const [form, envName, dbKey] of AI_FIELDS) {
    const v = String(req.body[form] || '').trim();
    if (v && v !== MASK) dbm.setSetting(dbKey, v);
  }
  res.render('admin/ai', { page: 'admin', ...aiPageData(), saved: true });
});
// ---------- Admin : notifications / watchdog ----------
const CRED_FIELDS = [
  ['smtp_host', 'SMTP_HOST', 'notif_smtp_host'],
  ['smtp_port', 'SMTP_PORT', 'notif_smtp_port'],
  ['smtp_user', 'SMTP_USER', 'notif_smtp_user'],
  ['smtp_pass', 'SMTP_PASS', 'notif_smtp_pass', true],
  ['smtp_from', 'SMTP_FROM', 'notif_smtp_from'],
  ['email_to', 'NOTIF_EMAIL_TO', 'notif_email_to'],
  ['telegram_token', 'TELEGRAM_BOT_TOKEN', 'notif_telegram_token', true],
  ['telegram_chat', 'TELEGRAM_CHAT_ID', 'notif_telegram_chat'],
  ['callmebot_key', 'CALLMEBOT_APIKEY', 'notif_callmebot_key', true],
  ['whatsapp_phone', 'WHATSAPP_PHONE', 'notif_whatsapp_phone'],
  ['twilio_sid', 'TWILIO_ACCOUNT_SID', 'notif_twilio_sid'],
  ['twilio_token', 'TWILIO_AUTH_TOKEN', 'notif_twilio_token', true],
  ['twilio_from', 'TWILIO_WHATSAPP_FROM', 'notif_twilio_from'],
  ['whatsapp_to', 'WHATSAPP_TO', 'notif_whatsapp_to'],
];
const MASK = '••••••••';
function notifPageData() {
  const creds = {}, credSrc = {};
  for (const [form, envName, dbKey, secret] of CRED_FIELDS) {
    credSrc[form] = notify.sourceOf(envName, dbKey);
    const v = dbm.getSetting(dbKey) || '';
    creds[form] = secret ? (v ? MASK : '') : v;
  }
  const eff = (envName, dbKey) => notify.val(envName, dbKey);
  return {
    channels: notify.channelStatus(),
    alerts: watchdog.ALERT_TYPES.map((t) => ({ type: t, enabled: watchdog.isAlertEnabled(t) })),
    threshold: dbm.getSetting('visits_spike_threshold') || '100',
    creds, credSrc,
    smtp_secure: /^(1|true|yes)$/i.test(eff('SMTP_SECURE', 'notif_smtp_secure')),
    smtp_secure_src: notify.sourceOf('SMTP_SECURE', 'notif_smtp_secure'),
    whatsapp_mode: eff('WHATSAPP_MODE', 'notif_whatsapp_mode') || 'callmebot',
    whatsapp_mode_src: notify.sourceOf('WHATSAPP_MODE', 'notif_whatsapp_mode'),
    windows_on: /^(1|true|yes)$/i.test(eff('WINDOWS_NOTIFY', 'notif_windows')),
    windows_src: notify.sourceOf('WINDOWS_NOTIFY', 'notif_windows'),
    log: dbm.recentNotifLog(),
    mask: MASK,
  };
}
app.get('/admin/notifications', requireLogin, (req, res) => {
  res.render('admin/notifications', { page: 'admin', ...notifPageData(), testResult: null, saved: false });
});
app.post('/admin/notifications/settings', requireLogin, (req, res) => {
  for (const t of watchdog.ALERT_TYPES) dbm.setSetting('alert_' + t, req.body['alert_' + t] ? '1' : '0');
  const th = parseInt(req.body.visits_spike_threshold, 10);
  if (Number.isFinite(th) && th >= 0) dbm.setSetting('visits_spike_threshold', String(th));
  res.render('admin/notifications', { page: 'admin', ...notifPageData(), testResult: null, saved: true });
});
app.post('/admin/notifications/credentials', requireLogin, (req, res) => {
  for (const [form, , dbKey] of CRED_FIELDS) {
    const v = String(req.body[form] || '').trim();
    if (v && v !== MASK) dbm.setSetting(dbKey, v);
  }
  dbm.setSetting('notif_smtp_secure', req.body.smtp_secure ? '1' : '0');
  dbm.setSetting('notif_whatsapp_mode', ['callmebot', 'twilio'].includes(req.body.whatsapp_mode) ? req.body.whatsapp_mode : 'callmebot');
  dbm.setSetting('notif_windows', req.body.windows ? '1' : '0');
  res.render('admin/notifications', { page: 'admin', ...notifPageData(), testResult: null, saved: true });
});
app.post('/admin/notifications/test', requireLogin, async (req, res) => {
  const testResult = await watchdog.testAlert();
  res.render('admin/notifications', { page: 'admin', ...notifPageData(), testResult, saved: false });
});

// ---------- Erreurs -> alerte watchdog ----------
app.use((err, req, res, next) => {
  console.error('[erreur]', err && err.stack ? err.stack : err);
  watchdog.fire('server_error', 'Erreur serveur',
    `${req.method} ${req.path} : ${(err && err.message) || err}`.slice(0, 500)).catch(() => {});
  res.status(500).send('Erreur interne du serveur.');
});

// ---------- 404 ----------
app.use((req, res) => res.status(404).render('404', { page: '' }));

app.listen(PORT, () => {
  console.log(`[site] Lesly Tech LLC v2 en ligne sur ${SITE_URL}`);
});
