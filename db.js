// db.js — SQLite (better-sqlite3) : schéma + seed initial.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'site.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'autre',   -- app | ebook | autre
  desc_fr TEXT DEFAULT '', desc_en TEXT DEFAULT '',
  desc_ht TEXT DEFAULT '', desc_es TEXT DEFAULT '',
  image TEXT DEFAULT '',                 -- chemin web, ex. /img/covers/viktor.jpg
  links TEXT DEFAULT '[]',               -- JSON [{label, url}]
  version TEXT DEFAULT '1.0',
  update_available INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,                     -- YYYY-MM-DD
  path TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER, label TEXT DEFAULT '', url TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                    -- visit | click
  label TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notif_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, message TEXT DEFAULT '',
  channels TEXT DEFAULT '[]', ok INTEGER DEFAULT 0,
  at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_status (
  app TEXT PRIMARY KEY,
  status TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

const getSetting = (k, dflt = '') => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : dflt;
};
const setSetting = (k, v) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
};

// --- Seed : catalogue initial (une seule fois) ---
const COVERS = {
  'VIKTOR - AI Assistant': '/img/covers/viktor.jpg',
  'Komanse Lavi Ou Ozetazini': '/img/covers/komanse-lavi.jpg',
  'Koman-Pou-w-Vin-Sitwayen-Ameriken': '/img/covers/sitwayen-ameriken.jpg',
  "Comment réussir l'examen pour devenir citoyen américain : Étape par étape": '/img/covers/citoyen-americain-fr.jpg',
  'Devenez interprète médical certifié en 7 semaines': '/img/covers/interprete-medical-fr.jpg',
  'Tounen Entèprèt Medikal Sètifye nan 7 Semèn': '/img/covers/interprete-medical-ht.jpg',
};

const countProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (countProducts === 0) {
  const insert = db.prepare(`
    INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, links, version)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @links, @version)
  `);
  const L = (label, url) => JSON.stringify([{ label, url }]);
  const seed = db.transaction((rows) => { for (const r of rows) insert.run(r); });
  const withCover = (o) => ({ ...o, image: COVERS[o.title] || '' });
  seed([
    withCover({
      title: 'VIKTOR - AI Assistant', type: 'app',
      desc_fr: "Compagnon IA sur Android : discutez, créez et explorez avec VIKTOR. Plus de 500 téléchargements, note 5,0/5.",
      desc_en: 'AI companion on Android: chat, create and explore with VIKTOR. 500+ downloads, 5.0/5 rating.',
      desc_ht: 'Konpayon IA sou Android : diskite, kreye epi eksplore ak VIKTOR. Plis pase 500 telechajman, nòt 5,0/5.',
      desc_es: 'Compañero IA en Android: conversa, crea y explora con VIKTOR. Más de 500 descargas, calificación 5,0/5.',
      links: L('Google Play', 'https://play.google.com/store/apps/details?id=com.leslymichel.viktor'),
      version: '1.0.9',
    }),
    withCover({
      title: 'Komanse Lavi Ou Ozetazini', type: 'ebook',
      desc_fr: 'Gid pratik an kreyòl ayisyen pou demare lavi w Ozetazini : 12 chapitres, 200 pages, plan 90 jours. 14,99 $US.',
      desc_en: 'Practical guide in Haitian Creole to start your life in the USA: 12 chapters, 200 pages, 90-day plan. US$14.99.',
      desc_ht: 'Gid pratik an kreyòl ayisyen pou demare lavi w Ozetazini : 12 chapit, 200 paj, plan 90 jou. 14,99 $US.',
      desc_es: 'Guía práctica en criollo haitiano para empezar tu vida en EE. UU.: 12 capítulos, 200 páginas, plan de 90 días. 14,99 US$.',
      links: JSON.stringify([
        { label: 'Payhip', url: 'https://payhip.com/b/18B4I' },
        { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/komanse-lavi-ou-ozetazini' },
      ]),
      version: '1.0',
    }),
    withCover({
      title: 'Koman-Pou-w-Vin-Sitwayen-Ameriken', type: 'ebook',
      desc_fr: "Guide en créole haïtien pour réussir l'examen de naturalisation américaine. 14,99 $US.",
      desc_en: 'Haitian Creole guide to pass the U.S. naturalization exam. US$14.99.',
      desc_ht: 'Gid an kreyòl ayisyen pou reyisi egzamen natiralizasyon ameriken an. 14,99 $US.',
      desc_es: 'Guía en criollo haitiano para aprobar el examen de naturalización estadounidense. 14,99 US$.',
      links: L('Payhip', 'https://payhip.com/b/9Ohzm'),
      version: '1.0',
    }),
    withCover({
      title: "Comment réussir l'examen pour devenir citoyen américain : Étape par étape", type: 'ebook',
      desc_fr: "Guide de 274 pages : N-400, biométrie, entretien, test d'anglais, 128 questions 2025, plan 30 jours. 14,99 $US.",
      desc_en: '274-page guide: N-400, biometrics, interview, English test, 128 questions (2025), 30-day plan. US$14.99.',
      desc_ht: 'Gid 274 paj : N-400, byometri, antvyou, tès anglè, 128 kesyon 2025, plan 30 jou. 14,99 $US.',
      desc_es: 'Guía de 274 páginas: N-400, biometría, entrevista, prueba de inglés, 128 preguntas 2025, plan de 30 días. 14,99 US$.',
      links: JSON.stringify([
        { label: 'Payhip', url: 'https://payhip.com/b/V9nAs' },
        { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/spiqtr' },
        { label: 'Shopify', url: 'https://leslymgenesis.com/products/comment-reussir-lexamen-pour-devenir-citoyen-americain-etape-par-etape' },
      ]),
      version: '1.0',
    }),
    withCover({
      title: 'Devenez interprète médical certifié en 7 semaines', type: 'ebook',
      desc_fr: 'Formation illustrée : 312 pages, 49 illustrations, examens blancs CCHI/NBCMI, lancement de carrière. 14,99 $US.',
      desc_en: 'Illustrated training: 312 pages, 49 illustrations, CCHI/NBCMI practice exams, career launch. US$14.99.',
      desc_ht: 'Fòmasyon ilistre : 312 paj, 49 ilistrasyon, egzamen blan CCHI/NBCMI, lanse karyè w. 14,99 $US.',
      desc_es: 'Formación ilustrada: 312 páginas, 49 ilustraciones, exámenes de práctica CCHI/NBCMI, impulso profesional. 14,99 US$.',
      links: JSON.stringify([
        { label: 'Payhip', url: 'https://payhip.com/b/57UM6' },
        { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/devenez-interprete-medical-certifie-en-7-semaines' },
        { label: 'Shopify', url: 'https://leslymgenesis.com/products/devenez-interprete-medical-certifie-en-7-semaines' },
      ]),
      version: '1.0',
    }),
    withCover({
      title: 'Tounen Entèprèt Medikal Sètifye nan 7 Semèn', type: 'ebook',
      desc_fr: 'Vèsyon kreyòl : fòmasyon ilistre 288 paj pou tounen entèprèt medikal sètifye. 14,99 $US.',
      desc_en: 'Creole version: illustrated 288-page training to become a certified medical interpreter. US$14.99.',
      desc_ht: 'Vèsyon kreyòl : fòmasyon ilistre 288 paj pou tounen entèprèt medikal sètifye. 14,99 $US.',
      desc_es: 'Versión en criollo: formación ilustrada de 288 páginas para ser intérprete médico certificado. 14,99 US$.',
      links: JSON.stringify([
        { label: 'Payhip', url: 'https://payhip.com/b/DOG2k' },
        { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/oewlksk' },
        { label: 'Shopify', url: 'https://leslymgenesis.com/products/tounen-entepret-medikal-setifye-nan-7-semen' },
      ]),
      version: '1.0',
    }),
  ]);
}

// Backfill : garantit les couvertures même sur une base existante.
{
  const rows = db.prepare('SELECT id, title, image FROM products').all();
  const upd = db.prepare('UPDATE products SET image = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const cover = COVERS[r.title];
    if (cover && !r.image) { upd.run(cover, r.id); n++; }
  }
  if (n > 0) console.log(`[db] ${n} couverture(s) restaurée(s).`);
}

// --- Helpers ---
function rowToProduct(r) {
  let links = [];
  try { links = JSON.parse(r.links || '[]'); } catch (e) {}
  return { ...r, links, update_available: !!r.update_available, active: !!r.active };
}
const qAll = db.prepare('SELECT * FROM products ORDER BY id');
const qActive = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY id");
const qById = db.prepare('SELECT * FROM products WHERE id = ?');
const qByType = db.prepare('SELECT * FROM products WHERE type = ? AND active = 1 ORDER BY id');

function logVisit(path) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO visits (day, path) VALUES (?, ?)').run(day, path);
  db.prepare("INSERT INTO events (kind, label) VALUES ('visit', ?)").run(path);
  db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)').run();
}
function logClick(productId, label, url) {
  db.prepare('INSERT INTO clicks (product_id, label, url) VALUES (?, ?, ?)').run(productId, label, url);
  const p = qById.get(productId);
  db.prepare("INSERT INTO events (kind, label) VALUES ('click', ?)").run(`${p ? p.title : '#' + productId} → ${label}`);
  db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)').run();
}
function stats() {
  const visitsTotal = db.prepare('SELECT COUNT(*) n FROM visits').get().n;
  const clicksTotal = db.prepare('SELECT COUNT(*) n FROM clicks').get().n;
  const productsCount = db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1').get().n;
  const visitsDays = db.prepare('SELECT day, COUNT(*) count FROM visits GROUP BY day ORDER BY day DESC LIMIT 14').all();
  const clicksByLink = db.prepare(`
    SELECT c.product_id, c.label, COUNT(*) n, p.title
    FROM clicks c LEFT JOIN products p ON p.id = c.product_id
    GROUP BY c.product_id, c.label ORDER BY n DESC LIMIT 20`).all();
  const recentActivity = db.prepare("SELECT kind, label, at FROM events ORDER BY id DESC LIMIT 25").all();
  return { visitsTotal, clicksTotal, productsCount, visitsDays, clicksByLink, recentActivity };
}
const recentNotifLog = () => db.prepare('SELECT * FROM notif_log ORDER BY id DESC LIMIT 30').all()
  .map((r) => { let ch = []; try { ch = JSON.parse(r.channels || '[]'); } catch (e) {} return { ...r, channels: ch }; });

// --- Helpers requis par watchdog.js ---
function currentHour() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}
function countVisitHour() {
  const h = currentHour();
  const r = db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'visit' AND at >= datetime('now', '-1 hour')").get();
  return r.n;
}
function logNotif(type, title, message, channels) {
  db.prepare('INSERT INTO notif_log (kind, message, channels, ok) VALUES (?, ?, ?, ?)')
    .run(type, `${title} — ${message}`.slice(0, 500), JSON.stringify(channels || []), 1);
}

const addSubscriber = (email) => {
  try {
    db.prepare('INSERT INTO subscribers (email) VALUES (?)').run(email);
    return true;
  } catch (e) {
    return false; // déjà inscrit ou email invalide
  }
};
const listSubscribers = () => db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC, id DESC').all();
const countSubscribers = () => db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n;
const setAppStatus = (app, status, detail = '') => {
  db.prepare(`INSERT INTO app_status (app, status, detail, updated_at)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(app) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`).run(app, status, detail);
};
const listAppStatus = () => db.prepare('SELECT * FROM app_status ORDER BY app').all();
module.exports = { db, getSetting, setSetting, qAll, qActive, qById, qByType, rowToProduct, logVisit, logClick, stats, recentNotifLog, currentHour, countVisitHour, logNotif, addSubscriber, listSubscribers, countSubscribers, setAppStatus, listAppStatus };
