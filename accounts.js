// accounts.js — connexion Google facultative, suivi des visiteurs connectés et relances e-mail.
//
// - Accès libre : le site reste entièrement utilisable sans compte (« Continuer sans compte »).
// - Connexion Google : jeton vérifié côté serveur auprès de Google (aud = notre Client ID).
// - Suivi : les pages vues, clics et conversations d'un visiteur connecté lui sont rattachés.
// - Relances : UNIQUEMENT si le visiteur a coché la case de consentement ; chaque e-mail
//   contient un lien de désinscription (obligation CAN-SPAM / RGPD). Désactivées par défaut.
const crypto = require('crypto');
const dbm = require('./db');
const ai = require('./ai');
const notify = require('./notify');
const { descFor } = require('./i18n');

const RELANCE_MAX_PER_VISITOR = 3;
const RELANCE_MAX_PER_RUN = 20;

function clientId() { return process.env.GOOGLE_CLIENT_ID || dbm.getSetting('google_client_id') || ''; }
function settings() {
  return {
    clientId: clientId(),
    relanceEnabled: dbm.getSetting('relance_enabled') === '1',
    relanceAfterDays: parseInt(dbm.getSetting('relance_after_days') || '2', 10),
    relanceEveryDays: parseInt(dbm.getSetting('relance_every_days') || '14', 10),
    emailReady: notify.emailReady(),
  };
}

async function verifyGoogleToken(idToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('jeton Google refusé');
  const p = await r.json();
  if (p.aud !== clientId()) throw new Error('jeton destiné à une autre application');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) throw new Error('émetteur invalide');
  if (String(p.email_verified) !== 'true') throw new Error('e-mail Google non vérifié');
  if (Number(p.exp) * 1000 < Date.now()) throw new Error('jeton expiré');
  return p;
}

function visitorById(id) { return id ? dbm.db.prepare('SELECT * FROM visitors WHERE id = ?').get(id) : null; }

// ---------- Historique d'un visiteur (pour l'admin et les relances) ----------
function activity(visitorId) {
  const views = dbm.db.prepare(`SELECT path, COUNT(*) n, MAX(at) last FROM visits WHERE visitor_id = ? GROUP BY path ORDER BY last DESC LIMIT 30`).all(visitorId);
  const productIds = views.map((v) => (v.path.match(/^\/produit\/(\d+)$/) || [])[1]).filter(Boolean).map(Number);
  const products = productIds.map((id) => dbm.rowToProduct(dbm.qById.get(id))).filter((p) => p && p.active);
  const clicks = dbm.db.prepare(`SELECT c.label, c.at, p.title FROM clicks c LEFT JOIN products p ON p.id = c.product_id WHERE c.visitor_id = ? ORDER BY c.id DESC LIMIT 20`).all(visitorId);
  const questions = dbm.db.prepare(`SELECT content, at FROM chat_messages WHERE visitor_id = ? AND role = 'user' ORDER BY id DESC LIMIT 10`).all(visitorId);
  return { views, products, clicks, questions };
}

function hasPurchased(email) {
  if (!email) return false;
  return !!dbm.db.prepare("SELECT 1 FROM sales WHERE lower(buyer) = lower(?) AND kind = 'sale' LIMIT 1").get(email);
}

// ---------- Rédaction d'une relance personnalisée (IA) ----------
const UNSUB = {
  fr: 'Ne plus recevoir ces e-mails', en: 'Unsubscribe from these e-mails', ht: 'Pa resevwa imèl sa yo ankò', es: 'Dejar de recibir estos correos',
};

async function composeRelance(v, siteUrl) {
  const lang = ['fr', 'en', 'ht', 'es'].includes(v.lang) ? v.lang : 'fr';
  const act = activity(v.id);
  const viewed = act.products.slice(0, 4);
  const catalogue = dbm.qActive.all().map(dbm.rowToProduct).slice(0, 25)
    .map((p) => `- ${p.title} (${siteUrl}/produit/${p.id}) : ${String(descFor(p, lang) || '').slice(0, 160)}`).join('\n');
  const facts = {
    prenom: String(v.name || '').split(' ')[0],
    livres_consultes: viewed.map((p) => `${p.title} — ${siteUrl}/produit/${p.id}`),
    questions_posees_assistant: act.questions.map((q) => q.content.slice(0, 150)),
    clics_vers_boutiques: act.clicks.map((c) => `${c.title} → ${c.label}`),
  };
  const r = await ai.chat({
    system: `Tu écris des e-mails de relance courts, chaleureux et honnêtes pour Les Éditions LeVent / Lesly Tech LLC (auteur : Lesly Michel). Langue : ${{ fr: 'français', en: 'English', ht: 'kreyòl ayisyen', es: 'español' }[lang]}.`,
    messages: [{ role: 'user', content:
      `Rédige un e-mail de relance pour ce visiteur (il a accepté de recevoir nos e-mails).\nInformations : ${JSON.stringify(facts)}\n\nCatalogue :\n${catalogue}\n\n` +
      'Règles : 80 à 140 mots ; mentionne au plus 2 créations pertinentes avec leur lien complet ; aucun faux prix, aucune fausse promo, aucune pression ; ' +
      "tutoiement chaleureux ; termine par la signature « Lesly Michel — Les Éditions LeVent ». N'ajoute PAS de lien de désinscription (il est ajouté automatiquement).\n" +
      'Réponds STRICTEMENT au format :\nSUJET: <objet de l\'e-mail>\n---\n<corps de l\'e-mail en texte brut>' }],
    maxTokens: 500, temperature: 0.6,
  });
  const m = r.text.match(/SUJET\s*:\s*(.+)\n-{3,}\n([\s\S]+)/i);
  const subject = (m ? m[1] : 'Des nouvelles des Éditions LeVent').trim().slice(0, 120);
  const body = (m ? m[2] : r.text).trim();
  const unsubUrl = `${siteUrl}/desabonnement/${v.unsub_token}`;
  const text = `${body}\n\n—\n${UNSUB[lang]} : ${unsubUrl}\nLesly Tech LLC — High Point, NC, USA`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#2b2118;line-height:1.6">` +
    esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#c2571b">$1</a>').replace(/\n/g, '<br>') +
    `<hr style="border:0;border-top:1px solid #e8ddc9;margin:24px 0 12px"><p style="font-size:12px;color:#999">` +
    `<a href="${unsubUrl}" style="color:#999">${UNSUB[lang]}</a> · Lesly Tech LLC — High Point, NC, USA</p></div>`;
  return { subject, text, html, provider: r.provider };
}

// Visiteurs à relancer : consentement, activité récente, pas d'achat, pas relancés récemment.
function candidates() {
  const s = settings();
  return dbm.db.prepare(`SELECT * FROM visitors WHERE consent = 1 AND email != ''
      AND last_seen <= datetime('now', ?) AND last_seen > datetime('now', '-30 day')
      AND relances < ? AND (last_relance IS NULL OR last_relance <= datetime('now', ?))
      ORDER BY last_seen DESC LIMIT ?`)
    .all(`-${s.relanceAfterDays} day`, RELANCE_MAX_PER_VISITOR, `-${s.relanceEveryDays} day`, RELANCE_MAX_PER_RUN)
    .filter((v) => !hasPurchased(v.email));
}

async function sendRelance(v, siteUrl) {
  const mail = await composeRelance(v, siteUrl);
  await notify.sendEmailTo(v.email, mail.subject, mail.text, mail.html);
  dbm.db.prepare("UPDATE visitors SET relances = relances + 1, last_relance = datetime('now') WHERE id = ?").run(v.id);
  return mail;
}

async function runRelances(siteUrl) {
  const s = settings();
  if (!s.relanceEnabled || !s.emailReady) return { sent: 0, skipped: true };
  let sent = 0;
  for (const v of candidates()) {
    try { await sendRelance(v, siteUrl); sent++; } catch (e) { dbm.logError(`relance #${v.id} : ${e.message}`); }
  }
  dbm.setSetting('relance_last_run', new Date().toISOString());
  return { sent };
}

function register(app, { requireLogin, siteUrl }) {
  // Infos visiteur pour toutes les vues.
  app.use((req, res, next) => {
    const v = req.session.visitorId ? visitorById(req.session.visitorId) : null;
    res.locals.visitor = v ? { name: v.name, picture: v.picture, email: v.email, consent: !!v.consent } : null;
    res.locals.googleClientId = clientId();
    if (v && req.method === 'GET' && !req.path.startsWith('/admin')) {
      dbm.db.prepare("UPDATE visitors SET last_seen = datetime('now') WHERE id = ?").run(v.id);
    }
    next();
  });

  app.post('/auth/google', async (req, res) => {
    if (!clientId()) return res.status(503).json({ ok: false, error: 'Connexion Google non configurée.' });
    try {
      const p = await verifyGoogleToken(String(req.body.credential || ''));
      const consent = req.body.consent === true || req.body.consent === '1' ? 1 : 0;
      const lang = ['fr', 'en', 'ht', 'es'].includes(req.lang) ? req.lang : 'fr';
      let v = dbm.db.prepare('SELECT * FROM visitors WHERE google_sub = ?').get(p.sub);
      if (!v) {
        dbm.db.prepare(`INSERT INTO visitors (google_sub, email, name, picture, lang, consent, unsub_token)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.sub, p.email, p.name || '', p.picture || '', lang, consent, crypto.randomBytes(16).toString('hex'));
        v = dbm.db.prepare('SELECT * FROM visitors WHERE google_sub = ?').get(p.sub);
      } else {
        dbm.db.prepare("UPDATE visitors SET email = ?, name = ?, picture = ?, lang = ?, last_seen = datetime('now')" + (consent ? ', consent = 1' : '') + ' WHERE id = ?')
          .run(p.email, p.name || '', p.picture || '', lang, v.id);
      }
      req.session.visitorId = v.id;
      req.session.visitorName = (p.given_name || p.name || '').slice(0, 60);
      res.json({ ok: true, name: p.given_name || p.name || '' });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  });

  app.post('/auth/logout', (req, res) => {
    delete req.session.visitorId; delete req.session.visitorName;
    res.json({ ok: true });
  });

  app.post('/account/consent', (req, res) => {
    if (!req.session.visitorId) return res.status(401).json({ ok: false });
    const c = req.body.consent === true || req.body.consent === '1' ? 1 : 0;
    dbm.db.prepare('UPDATE visitors SET consent = ? WHERE id = ?').run(c, req.session.visitorId);
    res.json({ ok: true, consent: !!c });
  });

  app.get('/desabonnement/:token', (req, res) => {
    const token = String(req.params.token || '');
    const v = /^[a-f0-9]{32}$/.test(token) ? dbm.db.prepare('SELECT * FROM visitors WHERE unsub_token = ?').get(token) : null;
    if (v) dbm.db.prepare('UPDATE visitors SET consent = 0 WHERE id = ?').run(v.id);
    res.render('unsubscribed', { page: '', done: !!v });
  });

  // ---------- Admin ----------
  app.get('/admin/visiteurs', requireLogin, (req, res) => {
    const visitors = dbm.db.prepare(`SELECT v.*,
        (SELECT COUNT(*) FROM visits WHERE visitor_id = v.id) views,
        (SELECT COUNT(*) FROM clicks WHERE visitor_id = v.id) clicks,
        (SELECT COUNT(*) FROM chat_messages WHERE visitor_id = v.id AND role = 'user') questions
      FROM visitors v ORDER BY v.last_seen DESC LIMIT 300`).all()
      .map((v) => ({ ...v, purchased: hasPurchased(v.email) }));
    const tracker = require('./tracker');
    const filter = ['chat', 'returning', 'account', 'today'].includes(req.query.f) ? req.query.f : '';
    const q = String(req.query.q || '').trim().slice(0, 80);
    res.render('admin/visiteurs', { page: 'admin', visitors, settings: settings(), pendingCount: candidates().length,
      lastRun: dbm.getSetting('relance_last_run'), saved: req.query.saved === '1', msg: req.query.msg || '',
      guestStats: tracker.stats(), guests: tracker.list({ q, filter }), filter, q });
  });

  // Fiche complète d'un visiteur (anonyme ou connecté) : sessions, parcours, conversations, clics.
  app.get('/admin/profil/:vid', requireLogin, (req, res) => {
    const vid = String(req.params.vid || '').toLowerCase();
    const p = /^[a-f0-9]{24}$/.test(vid) ? require('./tracker').profile(vid) : null;
    if (!p) return res.status(404).render('404', { page: '' });
    res.render('admin/profil', { page: 'admin', p });
  });

  app.post('/admin/visiteurs/settings', requireLogin, (req, res) => {
    const id = String(req.body.google_client_id || '').trim();
    if (id === '' || /^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) dbm.setSetting('google_client_id', id);
    dbm.setSetting('relance_enabled', req.body.relance_enabled ? '1' : '0');
    const a = parseInt(req.body.relance_after_days, 10), e = parseInt(req.body.relance_every_days, 10);
    if (a >= 1 && a <= 30) dbm.setSetting('relance_after_days', String(a));
    if (e >= 3 && e <= 90) dbm.setSetting('relance_every_days', String(e));
    res.redirect('/admin/visiteurs?saved=1');
  });

  app.get('/admin/visiteurs/:id', requireLogin, async (req, res, next) => {
    try {
      const v = visitorById(req.params.id);
      if (!v) return res.status(404).render('404', { page: '' });
      let preview = null, previewError = '';
      if (req.query.preview === '1') {
        try { preview = await composeRelance(v, siteUrl); } catch (e) { previewError = e.message; }
      }
      res.render('admin/visiteur', { page: 'admin', v, act: activity(v.id), purchased: hasPurchased(v.email), preview, previewError, msg: req.query.msg || '' });
    } catch (e) { next(e); }
  });

  app.post('/admin/visiteurs/:id/relance', requireLogin, async (req, res) => {
    const v = visitorById(req.params.id);
    if (!v) return res.redirect('/admin/visiteurs');
    if (!v.consent) return res.redirect(`/admin/visiteurs/${v.id}?msg=` + encodeURIComponent("Ce visiteur n'a pas donné son accord pour recevoir des e-mails."));
    try {
      await sendRelance(v, siteUrl);
      res.redirect(`/admin/visiteurs/${v.id}?msg=` + encodeURIComponent('Relance envoyée ✔'));
    } catch (e) {
      res.redirect(`/admin/visiteurs/${v.id}?msg=` + encodeURIComponent('Échec : ' + e.message));
    }
  });

  app.post('/admin/visiteurs/run', requireLogin, async (req, res) => {
    const r = await runRelances(siteUrl);
    res.redirect('/admin/visiteurs?msg=' + encodeURIComponent(r.skipped ? 'Relances désactivées ou Resend non configuré.' : `${r.sent} relance(s) envoyée(s).`));
  });

  // Relances automatiques : vérification toutes les heures (au plus 20 e-mails par passage).
  setInterval(() => { runRelances(siteUrl).catch(() => {}); }, 3600 * 1000).unref();
}

// Statistiques pour le rapport quotidien.
function dailyStats() {
  return {
    newAccounts: dbm.db.prepare("SELECT COUNT(*) n FROM visitors WHERE created_at > datetime('now', '-1 day')").get().n,
    accounts: dbm.db.prepare('SELECT COUNT(*) n FROM visitors').get().n,
    consenting: dbm.db.prepare('SELECT COUNT(*) n FROM visitors WHERE consent = 1').get().n,
    relances: dbm.db.prepare("SELECT COUNT(*) n FROM visitors WHERE last_relance > datetime('now', '-1 day')").get().n,
  };
}

module.exports = { register, dailyStats, settings };
