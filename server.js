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
const SqliteStore = require('./session-store');
const publish = require('./publish');

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

// Uploads d'images produits : sur le disque persistant (à côté de la base),
// sinon ils seraient effacés à chaque redéploiement Render.
const uploadDir = path.join(dbm.DATA_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
// Migration : les anciens uploads de public/uploads sont recopiés sur le disque persistant.
(function migrateUploads() {
  const oldDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(oldDir) || path.resolve(oldDir) === path.resolve(uploadDir)) return;
  for (const f of fs.readdirSync(oldDir)) {
    if (f.startsWith('.')) continue;
    const target = path.join(uploadDir, f);
    if (!fs.existsSync(target)) {
      try { fs.copyFileSync(path.join(oldDir, f), target); console.log('[uploads] migré:', f); } catch (e) {}
    }
  }
})();
// Chemin disque d'une image « /uploads/xxx » (basename : pas de remontée de dossier).
function uploadFilePath(image) {
  return path.join(uploadDir, path.basename(String(image || '')));
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

if (!process.env.SESSION_SECRET) {
  console.warn('[sécurité] SESSION_SECRET non défini : secret par défaut utilisé. À définir avant toute mise en ligne.');
}
app.use(session({
  store: new SqliteStore(dbm.db),
  secret: process.env.SESSION_SECRET || 'changez-moi-en-production',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: SITE_URL.startsWith('https://'), maxAge: 12 * 3600 * 1000 },
}));

// Connecte l'admin dans une session NEUVE (anti-fixation de session).
function loginAdmin(req, res, next, redirectTo = '/admin') {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.admin = true;
    req.session.save((err2) => (err2 ? next(err2) : res.redirect(redirectTo)));
  });
}
app.use(i18n);
app.use(csrf);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Upload d'images et de vidéos (dossier persistant défini plus haut).
// Les PDF/EPUB d'ebooks ne sont jamais acceptés : les ventes restent protégées.
const IMAGE_MAX = 5 * 1024 * 1024, VIDEO_MAX = 80 * 1024 * 1024;
const IMAGE_RE = /^image\/(png|jpe?g|webp|gif)$/i, VIDEO_RE = /^video\/(mp4|webm|quicktime)$/i;
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5);
    const safe = file.fieldname === 'video'
      ? (/^\.(mp4|webm|mov)$/.test(ext) ? ext : '.mp4')
      : (/^\.(png|jpe?g|webp|gif)$/.test(ext) ? ext : '.png');
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + safe);
  },
});
const multerMedia = multer({
  storage,
  limits: { fileSize: VIDEO_MAX },
  fileFilter: (req, file, cb) => cb(null, file.fieldname === 'video'
    ? VIDEO_RE.test(file.mimetype || '') : IMAGE_RE.test(file.mimetype || '')),
}).fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]);
// Expose req.file (image) et req.videoFile ; une image > 5 Mo est refusée.
function upload(req, res, next) {
  multerMedia(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop lourd (vidéo : 80 Mo maximum).' : 'Envoi du fichier impossible.';
      return res.status(413).send(msg + ' <a href="javascript:history.back()">Retour</a>');
    }
    const files = req.files || {};
    req.file = files.image && files.image[0];
    req.videoFile = files.video && files.video[0];
    if (req.file && req.file.size > IMAGE_MAX) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      if (req.videoFile) { try { fs.unlinkSync(req.videoFile.path); } catch (e) {} }
      return res.status(413).send('Image trop lourde (5 Mo maximum). <a href="javascript:history.back()">Retour</a>');
    }
    next();
  });
}
// Supprime un fichier envoyé (image ou vidéo) s'il vient de /uploads/.
function removeUpload(webPath) {
  if (webPath && String(webPath).startsWith('/uploads/')) { try { fs.unlinkSync(uploadFilePath(webPath)); } catch (e) {} }
}

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
  res.locals.contactEmail = process.env.CONTACT_EMAIL || 'leslymichel089@gmail.com';
  res.locals.publisherEmail = process.env.PUBLISHER_EMAIL || 'leseditionslevent777@gmail.com';
  res.locals.currentPath = req.path;
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
  const filter = publish.TYPES.includes(req.query.type) ? req.query.type : '';
  const q = String(req.query.q || '').trim().toLowerCase();
  let products = filter
    ? dbm.qByType.all(filter).map(dbm.rowToProduct)
    : dbm.qAll.all().map(dbm.rowToProduct);
  if (q) {
    products = products.filter((p) => [p.title, p.desc_fr, p.desc_en, p.desc_ht, p.desc_es]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  res.render('catalogue', { page: 'catalogue', products, filter, q: String(req.query.q || '') });
});

app.get('/ebooks', (req, res) => {
  const ebooks = dbm.qByType.all('ebook').map(dbm.rowToProduct);
  res.render('ebooks', { page: 'ebooks', ebooks });
});

app.get('/produit/:id', (req, res) => {
  const p = dbm.rowToProduct(dbm.qById.get(req.params.id));
  if (!p || !p.active) return res.status(404).render('404', { page: '' });
  const related = dbm.qAll.all().map(dbm.rowToProduct).filter((x) => x.id !== p.id).slice(0, 3);
  const embed = !p.media && p.type === 'video' ? publish.firstVideoEmbed(p.links) : null;
  res.render('produit', { page: 'produit', product: p, related, embed });
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
app.get('/conditions', (req, res) => res.render('legal', { page: 'conditions', doc: 'terms' }));
// Anti-spam contact : champ piège invisible + 3 messages/heure par IP + 30/heure au total.
const CONTACT_IP_MAX = 3, CONTACT_ALL_MAX = 30, CONTACT_WINDOW = 3600 * 1000;
const renderContact = (res, extra = {}) =>
  res.render('contact', { page: 'contact', status: null, form: {}, ...extra });

app.get('/contact', (req, res) => renderContact(res));
app.post('/contact', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 100),
    email: String(req.body.email || '').trim().slice(0, 200),
    message: String(req.body.message || '').trim().slice(0, 5000),
  };
  // Un robot remplit le champ piège « website » : on fait semblant d'accepter, sans rien envoyer.
  if (String(req.body.website || '').trim()) return renderContact(res, { status: 'sent' });

  if (!form.name || !form.message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    return res.status(400).render('contact', { page: 'contact', status: 'invalid', form });
  }
  const ip = req.ip || 'unknown';
  if (dbm.rateCount('contact_ip', ip, CONTACT_WINDOW) >= CONTACT_IP_MAX
    || dbm.rateCount('contact_all', '*', CONTACT_WINDOW) >= CONTACT_ALL_MAX) {
    return res.status(429).render('contact', { page: 'contact', status: 'limited', form });
  }
  dbm.rateHit('contact_ip', ip);
  dbm.rateHit('contact_all', '*');

  // Toujours conservé en base (consultable dans /admin/messages), puis notifié si un canal existe.
  dbm.addContactMessage({ ...form, ip });
  notify.sendAll('Nouveau message de contact', `Nom: ${form.name}\nEmail: ${form.email}\n\n${form.message}`).catch(() => {});
  renderContact(res, { status: 'sent' });
});

// ---------- Newsletter ----------
app.post('/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const ok = valid ? dbm.addSubscriber(email) : false;
  const referer = req.get('Referer') || '/';
  const sep = referer.includes('?') ? '&' : '?';
  res.redirect(referer + sep + (ok ? 'newsletter=ok' : 'newsletter=error'));
});

// ---------- SEO technique ----------
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'lesly-tech-llc', time: new Date().toISOString() });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /go\nDisallow: /lang\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
});

app.get('/sitemap.xml', (req, res) => {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const products = dbm.qAll.all().map(dbm.rowToProduct);
  const paths = [
    SITE_URL + '/',
    SITE_URL + '/catalogue',
    SITE_URL + '/ebooks',
    SITE_URL + '/confidentialite',
    SITE_URL + '/propriete-intellectuelle',
    SITE_URL + '/conditions',
    SITE_URL + '/contact',
    ...products.map((p) => SITE_URL + '/produit/' + p.id),
  ];
  const langs = ['fr', 'en', 'ht', 'es'];
  const alt = (u) => langs.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(u + (u.includes('?') ? '&' : '?') + 'lang=' + l)}"/>`).join('\n');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    paths.map((u) => '  <url>\n    <loc>' + esc(u) + '</loc>\n' + alt(u) + '\n  </url>').join('\n') +
    '\n</urlset>';
  res.type('application/xml').send(xml);
});


// ---------- Admin ----------
function hasSecret() { return !!dbm.getSetting('admin_code_hash'); }
function requireLogin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin');
  next();
}

// Anti-force brute, stocké en base (survit aux redémarrages) :
// 5 échecs / 15 min par IP, et 30 échecs / heure tous visiteurs confondus.
const ADMIN_CODE_RE = /^\d{4}$/; // code admin : exactement 4 chiffres (choix du PDG)

// Réinitialisation du code admin sans connaître l'ancien : définir ADMIN_CODE_RESET=1234
// (4 chiffres) dans l'environnement Render, redémarrer, puis RETIRER la variable.
(function resetAdminCodeFromEnv() {
  const v = String(process.env.ADMIN_CODE_RESET || '').trim();
  if (!v) return;
  if (!ADMIN_CODE_RE.test(v)) { console.warn('[admin] ADMIN_CODE_RESET ignoré : 4 chiffres attendus.'); return; }
  dbm.setSetting('admin_code_hash', bcrypt.hashSync(v, 10));
  dbm.db.prepare('DELETE FROM sessions').run();          // déconnecte toutes les sessions ouvertes
  dbm.db.prepare("DELETE FROM rate_events WHERE bucket LIKE 'login_%'").run();
  console.warn('[admin] Code admin réinitialisé via ADMIN_CODE_RESET — retirez cette variable maintenant.');
})();
const LOGIN_IP_MAX = 5, LOGIN_IP_WINDOW = 15 * 60 * 1000;
const LOGIN_ALL_MAX = 30, LOGIN_ALL_WINDOW = 3600 * 1000;
function loginBlocked(req) {
  return dbm.rateCount('login_ip', req.ip || 'unknown', LOGIN_IP_WINDOW) >= LOGIN_IP_MAX
    || dbm.rateCount('login_all', '*', LOGIN_ALL_WINDOW) >= LOGIN_ALL_MAX;
}
function loginFailed(req) {
  dbm.rateHit('login_ip', req.ip || 'unknown');
  dbm.rateHit('login_all', '*');
}
const ratePurgeTimer = setInterval(() => { try { dbm.ratePurge(); } catch (e) {} }, 3600 * 1000);
if (ratePurgeTimer.unref) ratePurgeTimer.unref();

app.get('/admin', (req, res) => {
  if (!hasSecret()) return res.render('admin/setup', { page: 'admin', error: null });
  if (!req.session.admin) return res.render('admin/login', { page: 'admin', error: null });
  const s = dbm.stats();
  const products = dbm.db.prepare('SELECT * FROM products ORDER BY id').all().map(dbm.rowToProduct);
  const enabled = dbm.getSetting('site_enabled') !== '0';
  res.render('admin/dashboard', {
    page: 'admin',
    products,
    enabled,
    stats: s,
    ...aiPageData(),
    aiSaved: req.query.ai === 'saved',
  });
});

app.post('/admin/setup', (req, res, next) => {
  if (hasSecret()) return res.redirect('/admin');
  const code = String(req.body.code || ''), confirm = String(req.body.confirm || '');
  if (!ADMIN_CODE_RE.test(code))
    return res.render('admin/setup', { page: 'admin', error: res.locals.t('admin_setup_error_short') });
  if (code !== confirm)
    return res.render('admin/setup', { page: 'admin', error: res.locals.t('admin_setup_error_mismatch') });
  dbm.setSetting('admin_code_hash', bcrypt.hashSync(code, 10));
  loginAdmin(req, res, next);
});

app.post('/admin/login', (req, res, next) => {
  if (!hasSecret()) return res.redirect('/admin');
  if (loginBlocked(req)) {
    return res.status(429).render('admin/login', { page: 'admin', error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  }
  const hash = dbm.getSetting('admin_code_hash');
  if (bcrypt.compareSync(String(req.body.code || ''), hash)) {
    dbm.rateClear('login_ip', req.ip || 'unknown');
    return loginAdmin(req, res, next);
  }
  loginFailed(req);
  res.render('admin/login', { page: 'admin', error: res.locals.t('admin_login_error') });
});

app.post('/admin/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin/change-code', requireLogin, (req, res) => {
  res.render('admin/change_code', { page: 'admin', error: null, changed: false });
});

app.post('/admin/change-code', requireLogin, (req, res) => {
  const current = String(req.body.current_code || '');
  const code = String(req.body.code || '');
  const confirm = String(req.body.confirm || '');
  const hash = dbm.getSetting('admin_code_hash');
  const renderError = (error) => res.render('admin/change_code', { page: 'admin', error, changed: false });

  if (!bcrypt.compareSync(current, hash)) return renderError('Code actuel incorrect.');
  if (!ADMIN_CODE_RE.test(code)) return renderError('Le nouveau code doit contenir exactement 4 chiffres.');
  if (code !== confirm) return renderError('Les deux nouveaux codes ne correspondent pas.');

  dbm.setSetting('admin_code_hash', bcrypt.hashSync(code, 10));
  res.render('admin/change_code', { page: 'admin', error: null, changed: true });
});

app.post('/admin/toggle-site', requireLogin, (req, res) => {
  const enabled = dbm.getSetting('site_enabled') !== '0';
  dbm.setSetting('site_enabled', enabled ? '0' : '1');
  watchdog.fire('site_toggle', 'Site ' + (enabled ? 'désactivé' : 'réactivé'),
    enabled ? 'Le site vitrine a été DÉSACTIVÉ (les visiteurs voient la page de maintenance).'
            : 'Le site vitrine a été RÉACTIVÉ.').catch(() => {});
  res.redirect('/admin');
});

// ---------- Admin : « Ajouter » universel (lien et/ou image -> publication automatique) ----------
app.get('/admin/add', requireLogin, (req, res) => {
  res.render('admin/add', { page: 'admin', error: null, form: {} });
});

app.post('/admin/add', requireLogin, upload, csrfVerify, async (req, res, next) => {
  try {
    const b = req.body;
    const form = {
      url: String(b.url || '').trim(),
      extra_links: String(b.extra_links || ''),
      title: String(b.title || '').trim().slice(0, 200),
      notes: String(b.notes || '').trim().slice(0, 2000),
      type: String(b.type || 'auto'),
    };
    if (form.url && !/^https?:\/\//i.test(form.url)) form.url = 'https://' + form.url;
    if (!form.url && !req.file && !req.videoFile && !form.title) {
      return res.status(400).render('admin/add', { page: 'admin', form,
        error: 'Ajoute au moins un lien, une image, une vidéo ou un titre.' });
    }

    const meta = form.url ? await publish.fetchMeta(form.url) : { title: '', description: '', image: '' };
    const media = req.videoFile ? '/uploads/' + req.videoFile.filename : '';
    const type = publish.TYPES.includes(form.type) ? form.type
      : (media && !form.url ? 'video' : publish.guessType(form.url, !!req.file));
    const title = form.title || meta.title
      || publish.titleFromFilename((req.file && req.file.originalname) || (req.videoFile && req.videoFile.originalname))
      || await publish.suggestTitle({ type, notes: form.notes }) || 'Nouvelle publication';
    const noTitle = title === 'Nouvelle publication';
    let image = req.file ? '/uploads/' + req.file.filename : '';
    if (!image && meta.image) {                                   // copie locale du visuel du lien
      const saved = await publish.downloadImage(meta.image, uploadDir);
      image = saved ? '/uploads/' + saved : meta.image;
    }

    const links = [];
    if (form.url) links.push({ label: publish.linkLabel(form.url), url: form.url });
    for (const l of parseLinksTextarea(form.extra_links)) links.push(l);
    for (const line of form.extra_links.split('\n')) {            // lignes « juste une URL » acceptées aussi
      const u = line.trim();
      if (/^https?:\/\/\S+$/i.test(u) && !links.some((x) => x.url === u)) links.push({ label: publish.linkLabel(u), url: u });
    }

    const { desc, aiUsed } = await publish.describeAllLangs({ title, type, sourceText: meta.description, notes: form.notes });

    const info = dbm.db.prepare(`
      INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, media, links, version, active)
      VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @media, @links, @version, 1)
    `).run({
      title, type,
      desc_fr: desc.fr || '', desc_en: desc.en || '', desc_ht: desc.ht || '', desc_es: desc.es || '',
      image, media, links: JSON.stringify(links), version: type === 'app' ? '1.0' : '',
    });
    watchdog.fire('product_added', 'Publication ajoutée', `« ${title} » (${type}) a été publiée.`).catch(() => {});
    res.redirect(`/admin/products/${info.lastInsertRowid}/edit?added=1${aiUsed ? '' : '&noai=1'}${noTitle ? '&notitle=1' : ''}`);
  } catch (e) { next(e); }
});

// ---------- Admin : CRUD produits ----------
app.get('/admin/products/new', requireLogin, (req, res) => {
  res.render('admin/product_form', { page: 'admin', product: null, linksText: '' });
});

app.post('/admin/products', requireLogin, upload, csrfVerify, (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim();
  dbm.db.prepare(`
    INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, media, links, version, active)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @media, @links, @version, @active)
  `).run({
    title,
    type: publish.TYPES.includes(b.type) ? b.type : 'autre',
    desc_fr: String(b.desc_fr || ''), desc_en: String(b.desc_en || ''),
    desc_ht: String(b.desc_ht || ''), desc_es: String(b.desc_es || ''),
    image: req.file ? '/uploads/' + req.file.filename : '',
    media: req.videoFile ? '/uploads/' + req.videoFile.filename : '',
    links: JSON.stringify(parseLinksTextarea(b.links)),
    version: String(b.version || '').trim(),
    active: b.active ? 1 : 0,
  });
  watchdog.fire('product_added', 'Produit ajouté', `« ${title} » a été ajouté au catalogue.`).catch(() => {});
  res.redirect('/admin');
});

app.get('/admin/products/:id/edit', requireLogin, (req, res) => {
  const p = dbm.rowToProduct(dbm.qById.get(req.params.id));
  if (!p) return res.status(404).render('404', { page: '' });
  res.render('admin/product_form', {
    page: 'admin', product: p, linksText: linksToTextarea(p.links),
    justAdded: req.query.added === '1', noAi: req.query.noai === '1', noTitle: req.query.notitle === '1',
  });
});

app.post('/admin/products/:id', requireLogin, upload, csrfVerify, (req, res) => {
  const p = dbm.qById.get(req.params.id);
  if (!p) return res.status(404).render('404', { page: '' });
  const b = req.body;
  let image = p.image;
  if (req.file) {
    removeUpload(image);
    image = '/uploads/' + req.file.filename;
  }
  let media = p.media || '';
  if (req.videoFile) {
    removeUpload(media);
    media = '/uploads/' + req.videoFile.filename;
  } else if (b.remove_media) {
    removeUpload(media);
    media = '';
  }
  dbm.db.prepare(`
    UPDATE products SET title=@title, type=@type, desc_fr=@desc_fr, desc_en=@desc_en,
      desc_ht=@desc_ht, desc_es=@desc_es, image=@image, media=@media, links=@links, version=@version, active=@active
    WHERE id=@id
  `).run({
    id: p.id, title: String(b.title || '').trim(),
    type: publish.TYPES.includes(b.type) ? b.type : 'autre',
    desc_fr: String(b.desc_fr || ''), desc_en: String(b.desc_en || ''),
    desc_ht: String(b.desc_ht || ''), desc_es: String(b.desc_es || ''),
    image, media, links: JSON.stringify(parseLinksTextarea(b.links)),
    version: String(b.version || '').trim(),
    active: b.active ? 1 : 0,
  });
  res.redirect('/admin');
});

app.post('/admin/products/:id/delete', requireLogin, (req, res) => {
  const p = dbm.qById.get(req.params.id);
  if (p) {
    removeUpload(p.image);
    removeUpload(p.media);
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
  if (String(req.body.return_to || '') === '/admin') {
    return res.redirect('/admin?ai=saved');
  }
  res.render('admin/ai', { page: 'admin', ...aiPageData(), saved: true });
});

function aiEffectiveConfig(provider, body = {}) {
  const p = provider === 'kimi' ? 'kimi' : 'deepseek';
  const env = p === 'kimi'
    ? { key: 'KIMI_API_KEY', base: 'KIMI_BASE_URL', model: 'KIMI_MODEL' }
    : { key: 'DEEPSEEK_API_KEY', base: 'DEEPSEEK_BASE_URL', model: 'DEEPSEEK_MODEL' };
  const dbKey = p === 'kimi'
    ? { key: 'ai_kimi_key', base: 'ai_kimi_base_url', model: 'ai_kimi_model' }
    : { key: 'ai_deepseek_key', base: 'ai_deepseek_base_url', model: 'ai_deepseek_model' };
  const fallback = p === 'kimi'
    ? { key: '', base: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6' }
    : { key: '', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };

  const submittedKey = String(body[`${p}_key`] || '').trim();
  const apiKey = submittedKey && submittedKey !== MASK
    ? submittedKey
    : (process.env[env.key] || dbm.getSetting(dbKey.key) || fallback.key);
  const baseUrl = String(body[`${p}_base_url`] || '').trim()
    || process.env[env.base]
    || dbm.getSetting(dbKey.base)
    || fallback.base;
  const model = String(body[`${p}_model`] || '').trim()
    || process.env[env.model]
    || dbm.getSetting(dbKey.model)
    || fallback.model;

  return { provider: p, apiKey, baseUrl, model };
}

app.post('/admin/ai/test', requireLogin, async (req, res) => {
  const provider = ['deepseek', 'kimi'].includes(String(req.body.provider || '')) ? req.body.provider : 'deepseek';
  const cfg = aiEffectiveConfig(provider, req.body);
  try {
    const result = await ai.testProviderConfig(cfg);
    res.json({ ok: result.ok, provider, result });
  } catch (e) {
    res.json({ ok: false, provider, result: { ok: false, error: e.message, models: [], chatOk: false } });
  }
});
// ---------- Admin : newsletter ----------
app.get('/admin/newsletter', requireLogin, (req, res) => {
  res.render('admin/newsletter', {
    page: 'admin',
    subscribers: dbm.listSubscribers(),
    count: dbm.countSubscribers(),
  });
});

app.get('/admin/newsletter.csv', requireLogin, (req, res) => {
  const rows = dbm.listSubscribers();
  const csv = 'email,created_at\n' + rows.map((r) => `${r.email},${r.created_at}`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="newsletter-lesly-tech-llc.csv"');
  res.send('\ufeff' + csv);
});
// ---------- Admin : messages du formulaire de contact ----------
app.get('/admin/messages', requireLogin, (req, res) => {
  res.render('admin/messages', {
    page: 'admin',
    messages: dbm.listContactMessages(),
    count: dbm.countContactMessages(),
  });
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
