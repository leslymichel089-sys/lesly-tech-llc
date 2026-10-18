// tracker.js — identification de chaque visiteur dès sa première visite (même anonyme).
//
// - Cookie « ltl_vid » (1 an, propre au site, HttpOnly) : reconnaît l'appareil à chaque retour.
// - Sessions : une nouvelle session commence après 30 minutes d'inactivité.
// - Chaque page vue, clic vers une boutique et message à l'assistant porte cet identifiant.
// - Si le visiteur se connecte avec Google, tout son historique anonyme est rattaché à son compte.
// - Les robots (moteurs de recherche, outils de surveillance…) sont reconnus et ignorés.
// - Rétention : les profils inactifs depuis 13 mois sont supprimés automatiquement.
const crypto = require('crypto');
const dbm = require('./db');

const COOKIE = 'ltl_vid';
const ONE_YEAR = 365 * 24 * 3600;
const SESSION_GAP_MIN = 30;
const BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|preview|monitor|uptime|pingdom|lighthouse|headless|curl|wget|python|axios|node-fetch|go-http|java\/|okhttp|render\/|vercel|statuscake|semrush|ahrefs|mj12/i;
// Requêtes qui ne sont pas des pages (fichiers, API, admin…) : pas de page vue comptée.
const NOT_A_PAGE = /^\/(admin|go|api|webhooks|lang|auth|account|uploads|videos|img|css|js|desabonnement)(\/|$)|\.(xml|txt|json|webmanifest|ico|png|jpe?g|svg|webp|mp4)$/i;

function cookieVid(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)ltl_vid=([a-f0-9]{24})(?:;|$)/);
  return m ? m[1] : null;
}

function parseUA(ua) {
  ua = String(ua || '');
  const device = /iPad|Tablet/i.test(ua) ? 'tablette' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'ordinateur';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'autre';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'autre';
  return { device, browser, os };
}

const clientIp = (req) => String(req.get('CF-Connecting-IP') || req.ip || '').slice(0, 64);
const country = (req) => String(req.get('CF-IPCountry') || '').slice(0, 2).toUpperCase().replace(/^XX$/, '');
// Provenance externe uniquement (pas les liens internes du site).
function externalReferrer(req, siteUrl) {
  const r = String(req.get('Referer') || '');
  if (!r) return '';
  try {
    const host = new URL(r).host;
    if (siteUrl && host === new URL(siteUrl).host) return '';
    return r.slice(0, 300);
  } catch (e) { return ''; }
}

function register(app, { siteUrl }) {
  const secure = String(siteUrl || '').startsWith('https://');
  const q = {
    guest: dbm.db.prepare('SELECT * FROM guests WHERE vid = ?'),
    newGuest: dbm.db.prepare(`INSERT OR IGNORE INTO guests (vid, first_referrer, first_page, device, browser, os, country, lang, last_ip)
      VALUES (@vid, @ref, @page, @device, @browser, @os, @country, @lang, @ip)`),
    lastSession: dbm.db.prepare('SELECT * FROM guest_sessions WHERE vid = ? ORDER BY id DESC LIMIT 1'),
    newSession: dbm.db.prepare(`INSERT INTO guest_sessions (vid, landing, referrer, ip, user_agent, country) VALUES (?, ?, ?, ?, ?, ?)`),
    touchSession: dbm.db.prepare("UPDATE guest_sessions SET last_at = datetime('now'), pages = pages + 1 WHERE id = ?"),
    touchGuest: dbm.db.prepare("UPDATE guests SET last_seen = datetime('now'), pages = pages + 1, last_ip = ?, lang = ?, country = CASE WHEN ? != '' THEN ? ELSE country END WHERE vid = ?"),
    countSession: dbm.db.prepare('UPDATE guests SET sessions = sessions + 1 WHERE vid = ?'),
    link: dbm.db.prepare('UPDATE guests SET visitor_id = ? WHERE vid = ? AND (visitor_id IS NULL OR visitor_id != ?)'),
    linkPast: [
      dbm.db.prepare('UPDATE visits SET visitor_id = ? WHERE vid = ? AND visitor_id IS NULL'),
      dbm.db.prepare('UPDATE clicks SET visitor_id = ? WHERE vid = ? AND visitor_id IS NULL'),
      dbm.db.prepare('UPDATE chat_messages SET visitor_id = ? WHERE vid = ? AND visitor_id IS NULL'),
    ],
  };

  app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/') || req.path.startsWith('/admin')) return next();
    const ua = req.get('User-Agent') || '';
    if (!ua || BOT.test(ua)) { req.isBot = true; return next(); }

    let vid = cookieVid(req);
    const isPage = req.method === 'GET' && !NOT_A_PAGE.test(req.path) && (req.accepts(['html', 'json']) === 'html');
    // Seule une vraie page vue crée un profil et pose le cookie : les requêtes automatiques du
    // navigateur (icône d'onglet, fichiers…) ne doivent ni créer de profil fantôme, ni remplacer
    // l'identifiant d'un visiteur.
    if (!vid && !isPage) return next();
    if (!vid) {
      vid = crypto.randomBytes(12).toString('hex');
      res.append('Set-Cookie', `${COOKIE}=${vid}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    req.vid = vid;
    try {
      const u = parseUA(ua);
      q.newGuest.run({ vid, ref: externalReferrer(req, siteUrl), page: req.path.slice(0, 200), ...u, country: country(req), lang: req.lang || '', ip: clientIp(req) });
      if (isPage) {
        let s = q.lastSession.get(vid);
        const stale = !s || (Date.now() - new Date(s.last_at.replace(' ', 'T') + 'Z').getTime()) > SESSION_GAP_MIN * 60 * 1000;
        if (stale) {
          const id = q.newSession.run(vid, req.path.slice(0, 200), externalReferrer(req, siteUrl), clientIp(req), ua.slice(0, 300), country(req)).lastInsertRowid;
          q.countSession.run(vid);
          s = { id };
        }
        q.touchSession.run(s.id);
        q.touchGuest.run(clientIp(req), req.lang || '', country(req), country(req), vid);
        req.guestSessionId = s.id;
      } else {
        const s = q.lastSession.get(vid);
        req.guestSessionId = s ? s.id : null;
      }
      // Visiteur connecté avec Google : on rattache ce profil (et tout son passé anonyme) à son compte.
      if (req.session && req.session.visitorId) {
        const changed = q.link.run(req.session.visitorId, vid, req.session.visitorId).changes;
        if (changed) for (const st of q.linkPast) st.run(req.session.visitorId, vid);
      }
    } catch (e) { /* le suivi ne doit jamais bloquer une page */ }
    next();
  });

  // Rétention : suppression des profils inactifs depuis 13 mois (une fois par jour).
  const purge = () => {
    try {
      const old = dbm.db.prepare("SELECT vid FROM guests WHERE last_seen < datetime('now', '-13 months')").all().map((r) => r.vid);
      if (!old.length) return;
      const tx = dbm.db.transaction((vids) => {
        for (const v of vids) {
          dbm.db.prepare('DELETE FROM guest_sessions WHERE vid = ?').run(v);
          for (const t of ['visits', 'clicks', 'chat_messages']) dbm.db.prepare(`UPDATE ${t} SET vid = NULL, session_id = NULL WHERE vid = ?`).run(v);
          dbm.db.prepare('DELETE FROM guests WHERE vid = ?').run(v);
        }
      });
      tx(old);
    } catch (e) {}
  };
  setTimeout(purge, 60 * 1000).unref();
  setInterval(purge, 24 * 3600 * 1000).unref();
}

// Identifiant lisible pour l'admin : V-3F9A2C.
const shortId = (vid) => 'V-' + String(vid || '').slice(0, 6).toUpperCase();

// ---------- Données pour l'administration ----------
function stats() {
  const g = (sql) => dbm.db.prepare(sql).get().n;
  return {
    total: g('SELECT COUNT(*) n FROM guests'),
    today: g("SELECT COUNT(*) n FROM guests WHERE last_seen > datetime('now', '-1 day')"),
    newToday: g("SELECT COUNT(*) n FROM guests WHERE first_seen > datetime('now', '-1 day')"),
    week: g("SELECT COUNT(*) n FROM guests WHERE last_seen > datetime('now', '-7 day')"),
    month: g("SELECT COUNT(*) n FROM guests WHERE last_seen > datetime('now', '-30 day')"),
    returning: g('SELECT COUNT(*) n FROM guests WHERE sessions > 1'),
    sessionsToday: g("SELECT COUNT(*) n FROM guest_sessions WHERE started_at > datetime('now', '-1 day')"),
    withChat: g('SELECT COUNT(DISTINCT vid) n FROM chat_messages WHERE vid IS NOT NULL'),
  };
}

function list({ q = '', filter = '', limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (filter === 'chat') where.push('EXISTS (SELECT 1 FROM chat_messages c WHERE c.vid = g.vid)');
  if (filter === 'returning') where.push('g.sessions > 1');
  if (filter === 'account') where.push('g.visitor_id IS NOT NULL');
  if (filter === 'today') where.push("g.last_seen > datetime('now', '-1 day')");
  if (q) {
    where.push('(g.vid LIKE ? OR g.country LIKE ? OR g.first_referrer LIKE ? OR v.email LIKE ? OR v.name LIKE ?)');
    const like = '%' + q.replace(/^V-/i, '').toLowerCase() + '%';
    args.push(like, like, '%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  return dbm.db.prepare(`SELECT g.*, v.name account_name, v.email account_email,
      (SELECT COUNT(*) FROM chat_messages c WHERE c.vid = g.vid AND c.role = 'user') questions,
      (SELECT COUNT(*) FROM clicks k WHERE k.vid = g.vid) clicks
    FROM guests g LEFT JOIN visitors v ON v.id = g.visitor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY g.last_seen DESC LIMIT ?`).all(...args, limit).map((r) => ({ ...r, short: shortId(r.vid) }));
}

function profile(vid) {
  const g = dbm.db.prepare('SELECT g.*, v.name account_name, v.email account_email, v.id account_id FROM guests g LEFT JOIN visitors v ON v.id = g.visitor_id WHERE g.vid = ?').get(vid);
  if (!g) return null;
  const sessions = dbm.db.prepare('SELECT * FROM guest_sessions WHERE vid = ? ORDER BY id DESC LIMIT 100').all(vid);
  const pagesBySession = dbm.db.prepare('SELECT session_id, path, at FROM visits WHERE vid = ? ORDER BY id').all(vid);
  const clicks = dbm.db.prepare('SELECT k.session_id, k.label, k.at, p.title FROM clicks k LEFT JOIN products p ON p.id = k.product_id WHERE k.vid = ? ORDER BY k.id').all(vid);
  const chats = dbm.db.prepare('SELECT session_id, role, content, provider, at FROM chat_messages WHERE vid = ? ORDER BY id').all(vid);
  const titles = {};
  for (const r of dbm.db.prepare('SELECT id, title FROM products').all()) titles['/produit/' + r.id] = r.title;
  for (const s of sessions) {
    s.timeline = [
      ...pagesBySession.filter((p) => p.session_id === s.id).map((p) => ({ at: p.at, kind: 'page', text: p.path, title: titles[p.path] || '' })),
      ...clicks.filter((c) => c.session_id === s.id).map((c) => ({ at: c.at, kind: 'click', text: `${c.title || '?'} → ${c.label}` })),
      ...chats.filter((c) => c.session_id === s.id).map((c) => ({ at: c.at, kind: c.role === 'user' ? 'question' : 'reponse', text: c.content, provider: c.provider })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  // Messages d'avant l'identification (sans session) : regroupés à part.
  const orphanChats = chats.filter((c) => !c.session_id);
  return { ...g, short: shortId(g.vid), sessionsList: sessions, orphanChats, totalClicks: clicks.length, totalQuestions: chats.filter((c) => c.role === 'user').length };
}

module.exports = { register, shortId, parseUA, stats, list, profile };
