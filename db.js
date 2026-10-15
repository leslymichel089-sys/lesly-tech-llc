// db.js — SQLite (better-sqlite3) : schéma + seed initial.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'site.db');
// Dossier des données persistantes (disque Render monté sur /data) : base + uploads.
const DATA_DIR = path.dirname(path.resolve(dbPath));
fs.mkdirSync(DATA_DIR, { recursive: true });
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
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL               -- timestamp ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires);
CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,                  -- ex. login_ip, login_all, contact_ip
  key TEXT NOT NULL,
  at INTEGER NOT NULL                    -- timestamp ms
);
CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (bucket, key, at);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '', email TEXT DEFAULT '', message TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration : colonne « media » (vidéo hébergée sur le site, ex. /videos/x.mp4 ou /uploads/x.mp4).
if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'media')) {
  db.exec("ALTER TABLE products ADD COLUMN media TEXT DEFAULT ''");
}

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

// --- Synchronisation Amazon KDP (exécutée une seule fois par base) ---
// Ajoute le lien Amazon Kindle aux ebooks déjà au catalogue et crée les titres
// publiés uniquement sur KDP. Le drapeau évite de recréer un livre retiré depuis l'admin.
if (getSetting('kdp_sync_v1') !== '1') {
  const amazon = (asin) => ({ label: 'Amazon Kindle', url: `https://www.amazon.com/dp/${asin}` });
  const KDP_EXISTING = {
    'Komanse Lavi Ou Ozetazini': 'B0HMBNHMQX',
    "Comment réussir l'examen pour devenir citoyen américain : Étape par étape": 'B0HBD6GC9H',
    'Devenez interprète médical certifié en 7 semaines': 'B0HMQZ1KWB',
  };
  const updLinks = db.prepare('UPDATE products SET links = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, title, links FROM products').all()) {
    const asin = KDP_EXISTING[r.title];
    if (!asin) continue;
    let links = [];
    try { links = JSON.parse(r.links || '[]'); } catch (e) {}
    if (!links.some((l) => /amazon\./i.test(l.url))) {
      links.unshift(amazon(asin));                       // Amazon en premier : plateforme la plus connue
      updLinks.run(JSON.stringify(links), r.id);
    }
  }
  const KDP_NEW = [{
    title: 'Prime Again', type: 'ebook',
    desc_fr: "Le plan en 10 leçons pour retrouver vitalité, énergie et confiance après 50 ans : hormones, nutrition, musculation, sommeil, vérités sur le Viagra et plan de retour en forme sur 90 jours. Ebook Kindle en anglais, 12,99 $US.",
    desc_en: 'The 10-lesson blueprint to reclaim your vitality, energy and confidence after 50: hormones, nutrition, strength training, sleep, the truth about Viagra and a 90-day comeback plan. Kindle ebook, US$12.99.',
    desc_ht: 'Plan 10 leson pou w jwenn fòs, enèji ak konfyans ou ankò apre 50 an : òmòn, nitrisyon, espò, dòmi, verite sou Viagra ak yon plan 90 jou. Ebook Kindle an anglè, 12,99 $US.',
    desc_es: 'El plan de 10 lecciones para recuperar la vitalidad, la energía y la confianza después de los 50: hormonas, nutrición, fuerza, sueño, la verdad sobre el Viagra y un plan de 90 días. Ebook Kindle en inglés, 12,99 US$.',
    image: '/img/covers/prime-again.jpg',
    links: JSON.stringify([amazon('B0HMPXT94D')]),
    version: '1.0',
  }];
  const exists = db.prepare('SELECT 1 FROM products WHERE title = ?');
  const ins = db.prepare(`INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, links, version)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @links, @version)`);
  for (const p of KDP_NEW) if (!exists.get(p.title)) ins.run(p);
  setSetting('kdp_sync_v1', '1');
}

// --- Nouveaux titres Les Éditions LeVent (exécuté une seule fois par base) ---
// Couverture + description uniquement : les fichiers PDF/EPUB ne sont jamais hébergés.
// Les liens de vente s'ajoutent ensuite depuis l'admin (Modifier → Liens).
if (getSetting('books_sync_v2') !== '1') {
  const CARD_DESC = {
    fr: "21 leçons pour aider ta famille et tes proches sans te ruiner ni couper les ponts : mesurer ce que tu donnes, dire non sans culpabilité, prêter sans perdre, déjouer les fausses urgences et transformer l'aide en autonomie. Plan 90 jours et outils à imprimer.",
    en: '21 lessons to help family and friends without going broke or burning bridges: measure what you give, say no without guilt, lend without losing, spot fake emergencies and turn help into independence. 90-day plan and printable tools.',
    ht: "21 leson pou w ede fanmi w ak zanmi w san w pa ruine tèt ou ni koupe ak yo : konte sa w bay, di non san kilpabilite, prete san w pa pèdi, rekonèt fo ijans epi fè èd la tounen otonomi. Plan 90 jou ak zouti pou enprime.",
    es: '21 lecciones para ayudar a tu familia y amigos sin arruinarte ni romper lazos: medir lo que das, decir no sin culpa, prestar sin perder, detectar falsas urgencias y convertir la ayuda en autonomía. Plan de 90 días y herramientas imprimibles.',
  };
  const edition = (lang) => ({
    fr: { fr: 'Édition française. ', en: 'French edition. ', ht: 'Edisyon an fransè. ', es: 'Edición en francés. ' },
    ht: { fr: 'Édition en créole haïtien. ', en: 'Haitian Creole edition. ', ht: 'Edisyon an kreyòl. ', es: 'Edición en criollo haitiano. ' },
    en: { fr: 'Édition anglaise. ', en: 'English edition. ', ht: 'Edisyon an anglè. ', es: 'Edición en inglés. ' },
  })[lang];
  const book = (title, lang, image) => {
    const ed = edition(lang);
    return {
      title, type: 'ebook', image, links: '[]', version: '1.0',
      desc_fr: ed.fr + CARD_DESC.fr, desc_en: ed.en + CARD_DESC.en,
      desc_ht: ed.ht + CARD_DESC.ht, desc_es: ed.es + CARD_DESC.es,
    };
  };
  const BOOKS_V2 = [
    book('Suis-je la carte bancaire de mon entourage ?', 'fr', '/img/covers/carte-bancaire-fr.jpg'),
    book('Èske Mwen Se Kat Bankè Antouraj Mwen ?', 'ht', '/img/covers/kat-banke-ht.jpg'),
    book('Am I Everyone’s Bank Card?', 'en', '/img/covers/bank-card-en.jpg'),
  ];
  const exists2 = db.prepare('SELECT 1 FROM products WHERE title = ?');
  const ins2 = db.prepare(`INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, links, version)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @links, @version)`);
  for (const p of BOOKS_V2) if (!exists2.get(p.title)) ins2.run(p);
  setSetting('books_sync_v2', '1');
}

// --- Catalogue LeVent : nouveaux livres + vidéos hébergées (exécuté une seule fois par base) ---
if (getSetting('catalog_sync_v3') !== '1') {
  const P = (o) => ({ links: '[]', version: '', media: '', image: '', ...o });
  const ITEMS = [
    P({ title: 'Lè Yon Moun Mouri Lòtbò', type: 'ebook', version: '1.0',
      image: '/img/covers/lotbo-ht.jpg', media: '/videos/lancement-lotbo.mp4',
      desc_fr: "Guide en créole haïtien pour rapatrier le corps d'un proche en Haïti, de A à Z : premières 48 heures, choix des pompes funèbres, papiers américains, consulat d'Haïti, transport aérien (situation 2026), coûts et aides, crémation, et comment se préparer à l'avance. 10 leçons. Ebook 16,99 $US · Pack Fanmi 27,99 $US.",
      desc_en: "Haitian Creole guide to repatriating a loved one's body to Haiti, from A to Z: the first 48 hours, choosing a funeral home, U.S. paperwork, the Haitian consulate, air transport (2026 situation), costs and financial help, cremation and planning ahead. 10 lessons. Ebook US$16.99 · Family Pack US$27.99.",
      desc_ht: 'Gid an kreyòl pou rapatriye kadav yon moun ou renmen ann Ayiti, de A a Z : premye 48 èdtan yo, chwazi bon fineray la, papye ameriken yo, konsila Ayiti, transpò pa avyon (sitiyasyon 2026), konbyen sa koute ak kote pou jwenn lajan, kremasyon, epi prepare davans. 10 leson. Ebook 16,99 $US · Pack Fanmi 27,99 $US.',
      desc_es: 'Guía en criollo haitiano para repatriar el cuerpo de un ser querido a Haití, de la A a la Z: primeras 48 horas, funeraria, documentos de EE. UU., consulado de Haití, transporte aéreo (situación 2026), costos y ayudas, cremación y planificación anticipada. 10 lecciones. Ebook 16,99 US$ · Pack Familia 27,99 US$.' }),
    P({ title: "L'Anglais Quotidien aux USA", type: 'ebook', version: '1.0', image: '/img/covers/anglais-quotidien.jpg',
      desc_fr: "« Savoir c'est Pouvoir » : guide trilingue illustré (anglais, créole, français) de l'anglais de tous les jours et manuel de survie aux États-Unis — aéroport, logement, banque, supermarché, école, administration, phrasal verbs, expressions et faux-amis. 14,99 $US.",
      desc_en: 'Knowledge is Power: an illustrated trilingual guide (English, Creole, French) to everyday English and a survival manual for life in the U.S. — airport, housing, banking, grocery store, school, government offices, phrasal verbs, idioms and false friends. US$14.99.',
      desc_ht: 'Konesans se pouvwa : gid ilistre an twa lang (anglè, kreyòl, franse) pou anglè chak jou ak manyèl pou viv Ozetazini — ayewopò, lojman, bank, makèt, lekòl, biwo leta, phrasal verbs, ekspresyon ak fo zanmi. 14,99 $US.',
      desc_es: 'Saber es poder: guía trilingüe ilustrada (inglés, criollo, francés) del inglés cotidiano y manual de supervivencia en EE. UU. — aeropuerto, vivienda, banco, supermercado, escuela, trámites, phrasal verbs, expresiones y falsos amigos. 14,99 US$.' }),
    P({ title: 'Bouki et Malice', type: 'ebook', version: '1.0', image: '/img/covers/bouki-malice.jpg',
      desc_fr: "Bèl kont pou timoun : 10 contes illustrés de Bouki et Ti Malice, en créole haïtien et en anglais — le gâteau disparu, la rivière, le marché, le tambour magique, la fête du village… Des histoires drôles et tendres qui transmettent partage, courage et goût de la lecture.",
      desc_en: 'Beautiful Tales for Children: 10 illustrated Bouki and Ti Malice stories in Haitian Creole and English — the missing cake, the river, the market, the magic drum, the village festival… Funny, tender tales about sharing, courage and the joy of reading.',
      desc_ht: 'Bèl kont pou timoun : 10 kont ilistre Bouki ak Ti Malis, an kreyòl ak an anglè — gato ki disparèt la, larivyè a, mache a, tanbou majik la, fèt nan vilaj la… Istwa ki fè ri epi ki aprann pataje, kouraj ak renmen li.',
      desc_es: 'Bellos cuentos para niños: 10 cuentos ilustrados de Bouki y Ti Malice en criollo haitiano e inglés — el pastel desaparecido, el río, el mercado, el tambor mágico, la fiesta del pueblo… Historias divertidas y tiernas sobre compartir, el valor y el gusto por la lectura.' }),
    P({ title: 'Ta nouvelle vie aux États-Unis', type: 'ebook', version: '1.0', image: '/img/covers/nouvelle-vie-fr.jpg',
      desc_fr: "Guide pratique, étape par étape, pour bien démarrer aux États-Unis : premiers jours, numéro de sécurité sociale, logement, banque et crédit, travail, santé, école, transport, impôts, statut d'immigration et plan d'action 90 jours. Version française de « Komanse Lavi Ou Ozetazini ».",
      desc_en: 'A practical step-by-step guide to starting out in the U.S.: first days, Social Security number, housing, banking and credit, work, health, school, transportation, taxes, immigration status and a 90-day action plan. French edition of "Komanse Lavi Ou Ozetazini".',
      desc_ht: 'Gid pratik etap pa etap pou kòmanse sou bon pye Ozetazini : premye jou yo, nimewo sekirite sosyal, lojman, bank ak kredi, travay, sante, lekòl, transpò, taks, estati imigrasyon ak plan aksyon 90 jou. Vèsyon franse « Komanse Lavi Ou Ozetazini ».',
      desc_es: 'Guía práctica paso a paso para empezar bien en EE. UU.: primeros días, número de seguro social, vivienda, banco y crédito, trabajo, salud, escuela, transporte, impuestos, estatus migratorio y plan de acción de 90 días. Edición francesa de «Komanse Lavi Ou Ozetazini».' }),
    P({ title: 'Découvrez la collection Les Éditions LeVent', type: 'video',
      image: '/videos/collection-levent.jpg', media: '/videos/collection-levent.mp4',
      desc_fr: "Bande-annonce de la collection : guides pratiques, réussite aux États-Unis et contes pour enfants. Disponibles sur Shopify, Gumroad, Payhip et Amazon Kindle.",
      desc_en: 'Collection trailer: practical guides, success in the U.S. and children\'s tales. Available on Shopify, Gumroad, Payhip and Amazon Kindle.',
      desc_ht: 'Bann-anons koleksyon an : gid pratik, reyisit Ozetazini ak kont pou timoun. Disponib sou Shopify, Gumroad, Payhip ak Amazon Kindle.',
      desc_es: 'Tráiler de la colección: guías prácticas, éxito en EE. UU. y cuentos infantiles. Disponibles en Shopify, Gumroad, Payhip y Amazon Kindle.' }),
    P({ title: 'Voix off professionnelle', type: 'video',
      image: '/videos/voix-off-fr.jpg', media: '/videos/voix-off-fr.mp4',
      desc_fr: 'Service de voix off en français, créole ou anglais pour pubs TikTok, vidéos YouTube, présentations et livres audio. Voix naturelle, qualité studio, livraison rapide. 25 $US jusqu\'à 2 min · 45 $US jusqu\'à 5 min.',
      desc_en: 'Voice-over service in French, Creole or English for TikTok ads, YouTube videos, presentations and audiobooks. Natural voice, studio quality, fast delivery. US$25 up to 2 min · US$45 up to 5 min.',
      desc_ht: 'Sèvis vwa off an franse, kreyòl oswa anglè pou piblisite TikTok, videyo YouTube, prezantasyon ak liv odyo. Vwa natirèl, kalite estidyo, livrezon rapid. 25 $US jiska 2 minit · 45 $US jiska 5 minit.',
      desc_es: 'Servicio de locución en francés, criollo o inglés para anuncios de TikTok, videos de YouTube, presentaciones y audiolibros. Voz natural, calidad de estudio, entrega rápida. 25 US$ hasta 2 min · 45 US$ hasta 5 min.' }),
    P({ title: 'Vwa off pwofesyonèl (kreyòl)', type: 'video',
      image: '/videos/vwa-off-ht.jpg', media: '/videos/vwa-off-ht.mp4',
      desc_fr: 'Version créole de l\'offre voix off : voix off professionnelle en créole et en français pour vos vidéos. 25 $US jusqu\'à 2 min · 45 $US jusqu\'à 5 min.',
      desc_en: 'Creole version of the voice-over offer: professional voice-over in Creole and French for your videos. US$25 up to 2 min · US$45 up to 5 min.',
      desc_ht: 'Bezwen yon vwa pou videyo w ? Vwa off pwofesyonèl an kreyòl ak an franse pou piblisite TikTok ak videyo YouTube. Vwa natirèl, kalite estidyo. 25 $US jiska 2 minit · 45 $US jiska 5 minit.',
      desc_es: 'Versión en criollo de la oferta de locución: voz en off profesional en criollo y francés para tus videos. 25 US$ hasta 2 min · 45 US$ hasta 5 min.' }),
    P({ title: 'Scripts TikTok prêts à tourner', type: 'video',
      image: '/videos/scripts-tiktok.jpg', media: '/videos/scripts-tiktok.mp4',
      desc_fr: 'Vos vidéos TikTok ne décollent pas ? Scripts prêts à tourner avec accroche, légende et hashtags optimisés. 15 $US le script · 4 scripts pour 50 $US.',
      desc_en: 'TikTok videos not taking off? Ready-to-film scripts with a hook, caption and optimized hashtags. US$15 per script · 4 scripts for US$50.',
      desc_ht: 'Videyo TikTok ou yo pa dekole ? Script pare pou w tounen, ak bon kwochèt, lejann ak hashtag optimize. 15 $US pou yon script · 4 script pou 50 $US.',
      desc_es: '¿Tus videos de TikTok no despegan? Guiones listos para grabar con gancho, descripción y hashtags optimizados. 15 US$ por guion · 4 guiones por 50 US$.' }),
    P({ title: 'Des textes qui vendent', type: 'video',
      image: '/videos/textes-qui-vendent.jpg', media: '/videos/textes-qui-vendent.mp4',
      desc_fr: 'Vos textes ne vendent pas assez ? Rédaction de descriptions de produits, articles et pages qui donnent envie d\'acheter, en français, créole ou anglais. Description 20 $US · Article 35 $US · Page 75 $US. Devis gratuit.',
      desc_en: 'Copy not selling enough? Product descriptions, articles and web pages that make people want to buy, in French, Creole or English. Description US$20 · Article US$35 · Page US$75. Free quote.',
      desc_ht: 'Tèks ou yo pa vann ase ? Redaksyon deskripsyon pwodwi, atik ak paj ki bay moun anvi achte, an franse, kreyòl oswa anglè. Deskripsyon 20 $US · Atik 35 $US · Paj 75 $US. Devi gratis.',
      desc_es: '¿Tus textos no venden lo suficiente? Redacción de descripciones de productos, artículos y páginas que dan ganas de comprar, en francés, criollo o inglés. Descripción 20 US$ · Artículo 35 US$ · Página 75 US$. Presupuesto gratis.' }),
  ];
  const exists3 = db.prepare('SELECT 1 FROM products WHERE title = ?');
  const ins3 = db.prepare(`INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, media, links, version)
    VALUES (@title, @type, @desc_fr, @desc_en, @desc_ht, @desc_es, @image, @media, @links, @version)`);
  for (const p of ITEMS) if (!exists3.get(p.title)) ins3.run(p);
  // Pub vidéo de Prime Again, affichée sur sa fiche.
  db.prepare("UPDATE products SET media = '/videos/pub-prime-again.mp4' WHERE title = 'Prime Again' AND (media IS NULL OR media = '')").run();
  setSetting('catalog_sync_v3', '1');
}

// --- Liens de vente officiels (Amazon KDP, Payhip, Gumroad, Shopify) — exécuté une seule fois ---
// Les liens listés ici passent en premier ; les autres liens déjà saisis dans l'admin sont conservés.
if (getSetting('links_sync_v4') !== '1') {
  const AMZ = (asin) => ({ label: 'Amazon Kindle', url: `https://www.amazon.com/dp/${asin}` });
  const PH = (id) => ({ label: 'Payhip', url: `https://payhip.com/b/${id}` });
  const GR = (slug) => ({ label: 'Gumroad', url: `https://leslymichel.gumroad.com/l/${slug}` });
  const SH = (handle, label = 'Shopify') => ({ label, url: `https://leslymgenesis.com/products/${handle}` });
  const LINKS = {
    'Komanse Lavi Ou Ozetazini': [AMZ('B0HMBNHMQX'), PH('18B4I'), GR('komanse-lavi-ou-ozetazini'), SH('komanse-lavi-ou-ozetazini-gid-pratik-pou-moun-ki-fek-rive')],
    'Koman-Pou-w-Vin-Sitwayen-Ameriken': [PH('9Ohzm'), GR('womegb'), SH('koman-pou-w-pase-egzamen-pou-w-vin-sitwayen-ameriken-etap-pa-etap')],
    "Comment réussir l'examen pour devenir citoyen américain : Étape par étape": [AMZ('B0HBD6GC9H'), PH('V9nAs'), GR('spiqtr'), SH('comment-reussir-lexamen-pour-devenir-citoyen-americain-etape-par-etape')],
    'Devenez interprète médical certifié en 7 semaines': [AMZ('B0HMQZ1KWB'), PH('57UM6'), GR('devenez-interprete-medical-certifie-en-7-semaines'), SH('devenez-interprete-medical-certifie-en-7-semaines')],
    'Tounen Entèprèt Medikal Sètifye nan 7 Semèn': [PH('DOG2k'), GR('oewlksk'), SH('tounen-entepret-medikal-setifye-nan-7-semen')],
    'Prime Again': [AMZ('B0HMPXT94D'), PH('ZuFkJ'), SH('prime-again-the-10-lesson-blueprint-to-reclaim-your-virility-energy-confidence-after-50')],
    'Suis-je la carte bancaire de mon entourage ?': [PH('Ok4Cm'), SH('suis-je-la-carte-bancaire-de-mon-entourage')],
    'Lè Yon Moun Mouri Lòtbò': [PH('1F6gA'), SH('le-yon-moun-mouri-lotbo-ebook'),
      SH('le-yon-moun-mouri-lotbo-pack-fanmi', 'Pack Fanmi (Shopify)'), SH('le-yon-moun-mouri-lotbo-lisans-oganizasyon', 'Lisans Òganizasyon (Shopify)')],
    "L'Anglais Quotidien aux USA": [PH('mB27q'), GR('wjhnb'), SH('langlais-quotidien-aux-usa-savoir-cest-pouvoir')],
    'Bouki et Malice': [PH('EhOZy'), GR('msvyw'), SH('bouki-et-malice')],
    'Pack 7 Ebooks — Les Éditions LeVent': [GR('thlqrk'), SH('pack-7-ebooks-les-editions-levent')],
  };
  // Nouveau produit : le pack 7 ebooks (Gumroad + Shopify).
  if (!db.prepare('SELECT 1 FROM products WHERE title = ?').get('Pack 7 Ebooks — Les Éditions LeVent')) {
    db.prepare(`INSERT INTO products (title, type, desc_fr, desc_en, desc_ht, desc_es, image, links, version)
      VALUES (@title, 'ebook', @desc_fr, @desc_en, @desc_ht, @desc_es, '/img/levent-logo.jpg', '[]', '1.0')`).run({
      title: 'Pack 7 Ebooks — Les Éditions LeVent',
      desc_fr: 'Le pack de 7 ebooks des Éditions LeVent à prix réduit : guides pratiques pour réussir aux États-Unis, citoyenneté, interprétariat médical et plus. 49,99 $US.',
      desc_en: 'Les Éditions LeVent 7-ebook bundle at a discounted price: practical guides to succeed in the U.S., citizenship, medical interpreting and more. US$49.99.',
      desc_ht: 'Pake 7 ebook Les Éditions LeVent a pri redwi : gid pratik pou reyisi Ozetazini, sitwayènte, entèpretasyon medikal ak plis ankò. 49,99 $US.',
      desc_es: 'Paquete de 7 ebooks de Les Éditions LeVent a precio reducido: guías prácticas para triunfar en EE. UU., ciudadanía, interpretación médica y más. 49,99 US$.',
    });
  }
  const upd = db.prepare('UPDATE products SET links = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, title, links FROM products').all()) {
    const official = LINKS[r.title];
    if (!official) continue;
    let current = [];
    try { current = JSON.parse(r.links || '[]'); } catch (e) {}
    const labels = new Set(official.map((l) => l.label));
    const urls = new Set(official.map((l) => l.url));
    const kept = current.filter((l) => !urls.has(l.url) && !labels.has(l.label));
    upd.run(JSON.stringify([...official, ...kept]), r.id);
  }
  setSetting('links_sync_v4', '1');
}

// --- Liens des 3 livres publiés le 15/10/2026 sur Payhip et Gumroad (exécuté une seule fois) ---
if (getSetting('links_sync_v5') !== '1') {
  const LINKS5 = {
    'Èske Mwen Se Kat Bankè Antouraj Mwen ?': [
      { label: 'Payhip', url: 'https://payhip.com/b/rRpty' },
      { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/fzcumi' }],
    'Am I Everyone’s Bank Card?': [
      { label: 'Payhip', url: 'https://payhip.com/b/2J7sL' },
      { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/cusdgf' }],
    'Ta nouvelle vie aux États-Unis': [
      { label: 'Payhip', url: 'https://payhip.com/b/5vZnX' },
      { label: 'Gumroad', url: 'https://leslymichel.gumroad.com/l/chahc' }],
  };
  const upd5 = db.prepare('UPDATE products SET links = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, title, links FROM products').all()) {
    const add = LINKS5[r.title];
    if (!add) continue;
    let current = [];
    try { current = JSON.parse(r.links || '[]'); } catch (e) {}
    const merged = [...current];
    for (const l of add) if (!merged.some((x) => x.url === l.url)) merged.push(l);
    upd5.run(JSON.stringify(merged), r.id);
  }
  setSetting('links_sync_v5', '1');
}

// --- Helpers ---
function rowToProduct(r) {
  if (!r) return null;
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

// --- Limitation de débit persistante (survit aux redémarrages) ---
const rateCount = (bucket, key, windowMs) =>
  db.prepare('SELECT COUNT(*) n FROM rate_events WHERE bucket = ? AND key = ? AND at > ?')
    .get(bucket, key, Date.now() - windowMs).n;
const rateHit = (bucket, key) =>
  db.prepare('INSERT INTO rate_events (bucket, key, at) VALUES (?, ?, ?)').run(bucket, key, Date.now());
const rateClear = (bucket, key) =>
  db.prepare('DELETE FROM rate_events WHERE bucket = ? AND key = ?').run(bucket, key);
const ratePurge = (maxAgeMs = 24 * 3600 * 1000) =>
  db.prepare('DELETE FROM rate_events WHERE at < ?').run(Date.now() - maxAgeMs);

// --- Messages du formulaire de contact (conservés même sans canal de notification) ---
const addContactMessage = (m) =>
  db.prepare('INSERT INTO contact_messages (name, email, message, ip) VALUES (@name, @email, @message, @ip)').run(m);
const listContactMessages = () => db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 500').all();
const countContactMessages = () => db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n;

module.exports = { db, DATA_DIR, getSetting, setSetting, qAll, qActive, qById, qByType, rowToProduct, logVisit, logClick, stats, recentNotifLog, currentHour, countVisitHour, logNotif, addSubscriber, listSubscribers, countSubscribers, setAppStatus, listAppStatus, rateCount, rateHit, rateClear, ratePurge, addContactMessage, listContactMessages, countContactMessages };
