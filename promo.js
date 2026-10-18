// promo.js — promotions du moment + relances e-mail automatiques avec rabais.
//
// - Le propriétaire définit ses promotions dans /admin/promotions (réduction, codes par plateforme,
//   livres concernés, public visé, dates). L'IA n'invente JAMAIS de rabais : elle n'utilise que ces données.
// - Contacts : uniquement des personnes ayant donné leur accord (fenêtre « offre », Google, newsletter),
//   + les clients si le propriétaire l'active. Chaque e-mail contient un lien de désinscription.
// - Garde-fous : 1 e-mail par contact au plus tous les N jours (7 par défaut), plafond quotidien,
//   jamais une promo sur un livre déjà acheté, envois automatiques désactivés par défaut.
const crypto = require('crypto');
const dbm = require('./db');
const ai = require('./ai');
const notify = require('./notify');
const { descFor } = require('./i18n');

const LANGS = ['fr', 'en', 'ht', 'es'];
const db = () => dbm.db;
const J = (s, d) => { try { return JSON.parse(s || ''); } catch (e) { return d; } };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function settings() {
  const g = (k, d) => dbm.getSetting(k) || d;
  return {
    auto: g('promo_auto', '0') === '1',
    minDays: Math.max(3, parseInt(g('promo_min_days', '7'), 10) || 7),
    dailyCap: Math.max(1, parseInt(g('promo_daily_cap', '50'), 10) || 50),
    includeClients: g('promo_include_clients', '0') === '1',
    popup: g('promo_popup', '1') === '1',
    popupDelay: Math.max(5, parseInt(g('promo_popup_delay', '20'), 10) || 20),
    emailReady: notify.emailReady(),
  };
}

// ---------- Promotions ----------
function rowToPromo(r) {
  if (!r) return null;
  return { ...r, codes: J(r.codes, {}), product_ids: J(r.product_ids, []), active: !!r.active, show_on_site: !!r.show_on_site };
}
const allPromos = () => db().prepare('SELECT * FROM promotions ORDER BY id DESC').all().map(rowToPromo);
const getPromo = (id) => rowToPromo(db().prepare('SELECT * FROM promotions WHERE id = ?').get(id));

function isLive(p, today = new Date().toISOString().slice(0, 10)) {
  return p.active && (!p.starts_at || p.starts_at <= today) && (!p.ends_at || p.ends_at >= today);
}
function livePromos() { return allPromos().filter((p) => isLive(p)); }

// Produits concernés par une promo (vide = tous les ebooks actifs).
function promoProducts(p) {
  const all = dbm.qActive.all().map(dbm.rowToProduct);
  return p.product_ids.length ? all.filter((x) => p.product_ids.includes(x.id)) : all.filter((x) => x.type === 'ebook');
}
// Meilleure promo en cours pour un produit donné (plus forte réduction en %).
function promoForProduct(productId) {
  const live = livePromos().filter((p) => p.show_on_site && promoProducts(p).some((x) => x.id === productId));
  return live.sort((a, b) => b.discount_value - a.discount_value)[0] || null;
}

function discountLabel(p) {
  return p.discount_type === 'amount' ? `−${Number(p.discount_value).toFixed(2).replace(/\.00$/, '')} $` : `−${Number(p.discount_value)} %`;
}
const PLATFORM_NAMES = { payhip: 'Payhip', gumroad: 'Gumroad', shopify: 'Shopify', amazon: 'Amazon Kindle' };
// Codes lisibles : « PAYHIP20 (Payhip), LEVENT20 (Gumroad) ».
function codesText(p) {
  return Object.entries(p.codes || {}).filter(([, c]) => c).map(([k, c]) => `${c} (${PLATFORM_NAMES[k] || k})`).join(', ');
}
function endText(p, lang) {
  if (!p.ends_at) return '';
  const d = new Date(p.ends_at + 'T12:00:00Z');
  const loc = { fr: 'fr-FR', en: 'en-US', ht: 'fr-FR', es: 'es-ES' }[lang] || 'fr-FR';
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------- Contacts ----------
function upsertContact({ email, name = '', lang = 'fr', source = '', vid = null, visitorId = null, consent = 1 }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const ex = db().prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  if (ex) {
    // Une nouvelle inscription explicite réactive le consentement ; une synchro automatique ne le force jamais.
    db().prepare(`UPDATE contacts SET name = CASE WHEN ? != '' THEN ? ELSE name END, lang = ?, vid = COALESCE(?, vid),
      visitor_id = COALESCE(?, visitor_id) ${consent === 2 ? ", consent = 1, consent_at = datetime('now')" : ''} WHERE id = ?`)
      .run(name, name, LANGS.includes(lang) ? lang : ex.lang, vid, visitorId, ex.id);
    return db().prepare('SELECT * FROM contacts WHERE id = ?').get(ex.id);
  }
  db().prepare(`INSERT INTO contacts (email, name, lang, source, consent, unsub_token, vid, visitor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(email, name, LANGS.includes(lang) ? lang : 'fr', source, consent ? 1 : 0, crypto.randomBytes(16).toString('hex'), vid, visitorId);
  return db().prepare('SELECT * FROM contacts WHERE email = ?').get(email);
}

// Rassemble les personnes ayant donné leur accord (Google, newsletter) et, si activé, les clients.
function syncContacts() {
  for (const v of db().prepare("SELECT * FROM visitors WHERE consent = 1 AND email != ''").all()) {
    upsertContact({ email: v.email, name: v.name, lang: v.lang, source: 'google', visitorId: v.id });
  }
  for (const s of db().prepare('SELECT email FROM subscribers').all()) upsertContact({ email: s.email, source: 'newsletter' });
  if (settings().includeClients) {
    for (const s of db().prepare("SELECT DISTINCT lower(buyer) email FROM sales WHERE kind = 'sale' AND buyer != ''").all()) {
      upsertContact({ email: s.email, source: 'client' });
    }
  }
  // Un visiteur Google qui s'est désinscrit l'est aussi ici.
  db().prepare("UPDATE contacts SET consent = 0 WHERE email IN (SELECT lower(email) FROM visitors WHERE consent = 0 AND email != '') AND source = 'google'").run();
}

function purchasedTitles(email) {
  return db().prepare("SELECT product FROM sales WHERE lower(buyer) = lower(?) AND kind = 'sale'").all(email).map((r) => r.product.toLowerCase());
}
const hasPurchased = (email) => purchasedTitles(email).length > 0;

function audienceOf(c) {
  if (hasPurchased(c.email)) return 'buyers';
  const sessions = c.vid ? (db().prepare('SELECT sessions FROM guests WHERE vid = ?').get(c.vid) || {}).sessions : 0;
  if (sessions > 1) return 'returning';
  if (Date.now() - new Date(c.created_at.replace(' ', 'T') + 'Z').getTime() < 14 * 864e5) return 'new';
  return 'returning';
}

// Livres consultés par ce contact (via son identifiant visiteur ou son compte Google), du plus récent au plus ancien.
function viewedProductIds(c) {
  const rows = db().prepare(`SELECT path, MAX(id) last FROM visits WHERE (vid = ? OR (visitor_id IS NOT NULL AND visitor_id = ?))
    AND path LIKE '/produit/%' GROUP BY path ORDER BY last DESC LIMIT 20`).all(c.vid || '-', c.visitor_id || -1);
  return rows.map((r) => parseInt(r.path.split('/')[2], 10)).filter(Boolean);
}

// Choisit la promo et le livre à proposer à un contact. Retourne null si rien de pertinent.
function pickOffer(c) {
  const aud = audienceOf(c);
  const promos = livePromos().filter((p) => p.audience === 'all' || p.audience === aud);
  if (!promos.length) return null;
  const bought = purchasedTitles(c.email);
  const notBought = (x) => !bought.some((t) => t.includes(x.title.toLowerCase().slice(0, 25)));
  const viewed = viewedProductIds(c);
  for (const id of viewed) {
    const p = promos.find((pr) => promoProducts(pr).some((x) => x.id === id));
    const product = p && promoProducts(p).find((x) => x.id === id);
    if (product && notBought(product)) return { promo: p, product, reason: 'consulté' };
  }
  for (const p of promos.sort((a, b) => b.discount_value - a.discount_value)) {
    const product = promoProducts(p).find(notBought);
    if (product) return { promo: p, product, reason: 'catalogue' };
  }
  return null;
}

// Lien d'achat direct : la plateforme dont la promo a un code, sinon la fiche du site.
function buyLink(product, promo, siteUrl) {
  const link = (product.links || []).find((l) => Object.keys(promo.codes || {}).some((k) => promo.codes[k] && new RegExp(k === 'amazon' ? 'amazon' : k, 'i').test(l.label + ' ' + l.url)));
  return link ? link.url : `${siteUrl}/produit/${product.id}`;
}

// ---------- Rédaction de l'e-mail ----------
const T = {
  fr: { unsub: 'Ne plus recevoir ces e-mails', code: 'Code promo', until: "jusqu'au", buy: 'Voir le livre', sign: 'Lesly Michel — Les Éditions LeVent', nore: 'Ebook numérique livré immédiatement — non remboursable.' },
  en: { unsub: 'Unsubscribe from these e-mails', code: 'Promo code', until: 'until', buy: 'See the book', sign: 'Lesly Michel — Les Éditions LeVent', nore: 'Digital ebook delivered instantly — non-refundable.' },
  ht: { unsub: 'Pa resevwa imèl sa yo ankò', code: 'Kòd pwomosyon', until: 'jiska', buy: 'Gade liv la', sign: 'Lesly Michel — Les Éditions LeVent', nore: 'Ebook nimerik ou resevwa touswit — pa ranbousab.' },
  es: { unsub: 'Dejar de recibir estos correos', code: 'Código promocional', until: 'hasta el', buy: 'Ver el libro', sign: 'Lesly Michel — Les Éditions LeVent', nore: 'Ebook digital entregado al instante — no reembolsable.' },
};
const LANG_NAME = { fr: 'français', en: 'English', ht: 'kreyòl ayisyen', es: 'español' };

async function composeEmail(c, offer, siteUrl, { welcome = false } = {}) {
  const lang = LANGS.includes(c.lang) ? c.lang : 'fr';
  const t = T[lang];
  const { promo, product } = offer;
  const url = buyLink(product, promo, siteUrl);
  const pageUrl = `${siteUrl}/produit/${product.id}`;
  const facts = {
    prenom: String(c.name || '').split(' ')[0] || null,
    livre: product.title, description: String(descFor(product, lang) || '').slice(0, 300),
    reduction: discountLabel(promo), codes: codesText(promo) || null, fin: endText(promo, lang) || null,
    raison: welcome ? 'vient de s’inscrire pour recevoir nos offres' : offer.reason === 'consulté' ? 'a consulté ce livre sur le site sans l’acheter' : 'a accepté de recevoir nos offres',
  };
  let subject = '', body = '', provider = 'modèle';
  try {
    const r = await ai.chat({
      system: `Tu rédiges des e-mails commerciaux courts, chaleureux et HONNÊTES pour Les Éditions LeVent (auteur Lesly Michel). Langue : ${LANG_NAME[lang]}.`,
      messages: [{ role: 'user', content:
        `Écris un e-mail pour proposer ce livre avec la promotion en cours. Faits (n'invente RIEN d'autre, aucun autre prix, rabais, bonus ou date) :\n${JSON.stringify(facts)}\n\n` +
        '70 à 120 mots, tutoiement, une seule offre, ton amical sans pression ni fausse urgence. Mentionne la réduction, le ou les codes exacts et la date de fin si elle existe. ' +
        "N'écris AUCUN lien, AUCUNE signature et AUCUN lien de désinscription (ils sont ajoutés automatiquement).\n" +
        "Réponds STRICTEMENT au format :\nSUJET: <objet, 60 caractères max>\n---\n<corps en texte brut>" }],
      maxTokens: 450, temperature: 0.6,
    });
    const m = r.text.match(/SUJET\s*:\s*(.+)\n-{3,}\n([\s\S]+)/i);
    if (m) { subject = m[1].trim().slice(0, 90); body = m[2].trim(); provider = r.provider; }
  } catch (e) { /* modèle de secours ci-dessous */ }
  if (!body) {
    const hi = { fr: 'Bonjour', en: 'Hi', ht: 'Bonjou', es: 'Hola' }[lang];
    subject = `${discountLabel(promo)} — ${product.title}`.slice(0, 90);
    body = `${hi}${facts.prenom ? ' ' + facts.prenom : ''},\n\n${product.title} : ${discountLabel(promo)}` +
      (facts.codes ? ` (${t.code} : ${facts.codes})` : '') + (facts.fin ? ` ${t.until} ${facts.fin}` : '') + '.\n\n' + facts.description;
  }
  const unsubUrl = `${siteUrl}/desabonnement/c/${c.unsub_token}`;
  const text = `${body}\n\n${t.buy} : ${url}\n${pageUrl !== url ? pageUrl + '\n' : ''}\n${t.sign}\n${t.nore}\n\n—\n${t.unsub} : ${unsubUrl}\nLesly Tech LLC — High Point, NC, USA`;
  const img = product.image ? (/^https?:/.test(product.image) ? product.image : siteUrl + product.image) : '';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#2b2118;line-height:1.6">
    ${img ? `<a href="${esc(url)}"><img src="${esc(img)}" alt="${esc(product.title)}" style="width:180px;border-radius:10px;display:block;margin:0 auto 16px"></a>` : ''}
    <p>${esc(body).replace(/\n/g, '<br>')}</p>
    <div style="background:#f3ecdd;border-radius:12px;padding:14px 16px;margin:16px 0;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#c2571b">${esc(discountLabel(promo))}</div>
      ${facts.codes ? `<div style="margin-top:6px">${esc(t.code)} : <strong>${esc(facts.codes)}</strong></div>` : ''}
      ${facts.fin ? `<div style="font-size:13px;color:#7a6a58">${esc(t.until)} ${esc(facts.fin)}</div>` : ''}
    </div>
    <p style="text-align:center"><a href="${esc(url)}" style="background:#c2571b;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;display:inline-block">${esc(t.buy)}</a></p>
    <p style="margin-top:20px">${esc(t.sign)}</p>
    <p style="font-size:12px;color:#999">${esc(t.nore)}</p>
    <hr style="border:0;border-top:1px solid #e8ddc9;margin:20px 0 10px">
    <p style="font-size:12px;color:#999"><a href="${esc(unsubUrl)}" style="color:#999">${esc(t.unsub)}</a> · Lesly Tech LLC — High Point, NC, USA</p></div>`;
  return { subject, text, html, provider, url };
}

// ---------- Envois ----------
async function sendOffer(c, offer, siteUrl, opts = {}) {
  const mail = await composeEmail(c, offer, siteUrl, opts);
  await notify.sendEmailTo(c.email, mail.subject, mail.text, mail.html);
  db().prepare("UPDATE contacts SET emails_sent = emails_sent + 1, last_email_at = datetime('now') WHERE id = ?").run(c.id);
  db().prepare('INSERT INTO promo_sends (contact_id, promo_id, product_id, subject, provider) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, offer.promo.id, offer.product.id, mail.subject, mail.provider);
  if (c.visitor_id) db().prepare("UPDATE visitors SET last_relance = datetime('now') WHERE id = ?").run(c.visitor_id);
  return mail;
}

function candidates() {
  const s = settings();
  return db().prepare(`SELECT * FROM contacts WHERE consent = 1
      AND (last_email_at IS NULL OR last_email_at <= datetime('now', ?))
      AND created_at <= datetime('now', '-1 hour')
    ORDER BY COALESCE(last_email_at, '1970-01-01') ASC LIMIT 500`).all(`-${s.minDays} day`);
}

let running = false;
async function runAuto(siteUrl, { force = false } = {}) {
  const s = settings();
  if ((!s.auto && !force) || !s.emailReady || running) return { sent: 0, skipped: true, reason: !s.emailReady ? 'Resend non configuré' : !s.auto ? 'envois automatiques désactivés' : 'déjà en cours' };
  if (!livePromos().length) return { sent: 0, skipped: true, reason: 'aucune promotion en cours' };
  running = true;
  let sent = 0, errors = 0;
  try {
    syncContacts();
    const already = db().prepare("SELECT COUNT(*) n FROM promo_sends WHERE at > datetime('now', '-1 day')").get().n;
    let budget = Math.max(0, s.dailyCap - already);
    for (const c of candidates()) {
      if (budget <= 0) break;
      const offer = pickOffer(c);
      if (!offer) continue;
      try { await sendOffer(c, offer, siteUrl); sent++; budget--; } catch (e) { errors++; dbm.logError(`promo contact #${c.id} : ${e.message}`); }
    }
  } finally { running = false; }
  dbm.setSetting('promo_last_run', new Date().toISOString());
  return { sent, errors };
}

// ---------- Routes ----------
function register(app, { requireLogin, siteUrl }) {
  // Promotions visibles sur le site (bandeau, badges) et connues de l'assistant.
  app.use((req, res, next) => {
    try {
      if (!req.path.startsWith('/admin')) {
        const live = livePromos().filter((p) => p.show_on_site);
        res.locals.sitePromo = live.sort((a, b) => b.discount_value - a.discount_value)[0] || null;
        res.locals.promoFor = (productId) => promoForProduct(productId);
        res.locals.promoLabel = discountLabel;
        res.locals.promoCodes = codesText;
        res.locals.promoEnd = endText;
        const s = settings();
        res.locals.leadPopup = s.popup && !!res.locals.sitePromo;
        res.locals.leadPopupDelay = s.popupDelay;
      }
    } catch (e) {}
    next();
  });

  // Inscription « recevoir l'offre » (fenêtre ou bulle de l'assistant) — accord explicite obligatoire.
  app.post('/api/lead', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (req.body.consent !== true && req.body.consent !== '1') return res.status(400).json({ ok: false, error: 'consent' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'email' });
    const ip = req.ip || 'x';
    if (dbm.rateCount('lead_ip', ip, 3600 * 1000) >= 5) return res.status(429).json({ ok: false, error: 'rate' });
    dbm.rateHit('lead_ip', ip);
    const c = upsertContact({ email, lang: req.lang || 'fr', source: String(req.body.source || 'popup').slice(0, 20), vid: req.vid || null,
      visitorId: req.session.visitorId || null, consent: 2 });
    if (!c) return res.status(400).json({ ok: false, error: 'email' });
    const promo = res.locals.sitePromo;
    // E-mail de bienvenue avec l'offre, immédiatement (si Resend est configuré).
    let emailed = false;
    if (promo && notify.emailReady()) {
      const product = (req.vid && viewedProductIds(c).map((id) => promoProducts(promo).find((x) => x.id === id)).find(Boolean)) || promoProducts(promo)[0];
      if (product) {
        try { await sendOffer(c, { promo, product, reason: 'catalogue' }, siteUrl, { welcome: true }); emailed = true; } catch (e) { dbm.logError('bienvenue promo : ' + e.message); }
      }
    }
    res.json({ ok: true, emailed, promo: promo ? { label: discountLabel(promo), codes: codesText(promo), end: endText(promo, req.lang || 'fr') } : null });
  });

  app.get('/desabonnement/c/:token', (req, res) => {
    const token = String(req.params.token || '');
    const c = /^[a-f0-9]{32}$/.test(token) ? db().prepare('SELECT * FROM contacts WHERE unsub_token = ?').get(token) : null;
    if (c) {
      db().prepare('UPDATE contacts SET consent = 0 WHERE id = ?').run(c.id);
      if (c.visitor_id) db().prepare('UPDATE visitors SET consent = 0 WHERE id = ?').run(c.visitor_id);
      db().prepare('DELETE FROM subscribers WHERE lower(email) = lower(?)').run(c.email);
    }
    res.render('unsubscribed', { page: '', done: !!c });
  });

  // ---------- Admin ----------
  const parseForm = (b) => {
    const codes = {};
    for (const k of ['payhip', 'gumroad', 'shopify', 'amazon']) { const v = String(b['code_' + k] || '').trim().slice(0, 60); if (v) codes[k] = v; }
    const ids = [].concat(b.product_ids || []).map((x) => parseInt(x, 10)).filter(Boolean);
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
    return {
      title: String(b.title || '').trim().slice(0, 120) || 'Promotion',
      discount_type: b.discount_type === 'amount' ? 'amount' : 'percent',
      discount_value: Math.max(0, Math.min(100000, parseFloat(String(b.discount_value || '0').replace(',', '.')) || 0)),
      codes: JSON.stringify(codes), product_ids: JSON.stringify(ids),
      audience: ['all', 'new', 'returning', 'buyers'].includes(b.audience) ? b.audience : 'all',
      starts_at: date(b.starts_at) || new Date().toISOString().slice(0, 10), ends_at: date(b.ends_at),
      active: b.active ? 1 : 0, show_on_site: b.show_on_site ? 1 : 0,
    };
  };

  app.get('/admin/promotions', requireLogin, (req, res) => {
    syncContacts();
    const contacts = db().prepare('SELECT * FROM contacts ORDER BY id DESC LIMIT 500').all();
    const sends = db().prepare(`SELECT s.*, c.email, p.title promo_title, pr.title product_title FROM promo_sends s
      LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN promotions p ON p.id = s.promo_id LEFT JOIN products pr ON pr.id = s.product_id
      ORDER BY s.id DESC LIMIT 50`).all();
    const salesWithCode = db().prepare("SELECT coupon, COUNT(*) n, SUM(amount) total FROM sales WHERE kind = 'sale' AND coupon != '' GROUP BY coupon ORDER BY n DESC").all();
    res.render('admin/promotions', {
      page: 'admin', promos: allPromos().map((p) => ({ ...p, live: isLive(p), label: discountLabel(p), codesText: codesText(p) })),
      products: dbm.qAll.all().map(dbm.rowToProduct), settings: settings(), contacts, sends, salesWithCode,
      stats: {
        contacts: contacts.length, consenting: contacts.filter((c) => c.consent).length,
        pending: livePromos().length ? candidates().filter((c) => pickOffer(c)).length : 0,
        sentWeek: db().prepare("SELECT COUNT(*) n FROM promo_sends WHERE at > datetime('now', '-7 day')").get().n,
      },
      edit: req.query.edit ? getPromo(req.query.edit) : null,
      lastRun: dbm.getSetting('promo_last_run'), msg: req.query.msg || '',
    });
  });

  app.post('/admin/promotions/save', requireLogin, (req, res) => {
    const d = parseForm(req.body);
    const id = parseInt(req.body.id, 10);
    if (id) {
      db().prepare(`UPDATE promotions SET title=@title, discount_type=@discount_type, discount_value=@discount_value, codes=@codes,
        product_ids=@product_ids, audience=@audience, starts_at=@starts_at, ends_at=@ends_at, active=@active, show_on_site=@show_on_site WHERE id=@id`).run({ ...d, id });
    } else {
      db().prepare(`INSERT INTO promotions (title, discount_type, discount_value, codes, product_ids, audience, starts_at, ends_at, active, show_on_site)
        VALUES (@title, @discount_type, @discount_value, @codes, @product_ids, @audience, @starts_at, @ends_at, @active, @show_on_site)`).run(d);
    }
    res.redirect('/admin/promotions?msg=' + encodeURIComponent('Promotion enregistrée ✔'));
  });

  app.post('/admin/promotions/:id/toggle', requireLogin, (req, res) => {
    db().prepare('UPDATE promotions SET active = 1 - active WHERE id = ?').run(req.params.id);
    res.redirect('/admin/promotions');
  });
  app.post('/admin/promotions/:id/delete', requireLogin, (req, res) => {
    db().prepare('DELETE FROM promotions WHERE id = ?').run(req.params.id);
    res.redirect('/admin/promotions?msg=' + encodeURIComponent('Promotion supprimée.'));
  });

  app.post('/admin/promotions/settings', requireLogin, (req, res) => {
    dbm.setSetting('promo_auto', req.body.promo_auto ? '1' : '0');
    dbm.setSetting('promo_include_clients', req.body.promo_include_clients ? '1' : '0');
    dbm.setSetting('promo_popup', req.body.promo_popup ? '1' : '0');
    const n = (v, lo, hi) => { const x = parseInt(v, 10); return x >= lo && x <= hi ? String(x) : null; };
    const md = n(req.body.promo_min_days, 3, 60); if (md) dbm.setSetting('promo_min_days', md);
    const cap = n(req.body.promo_daily_cap, 1, 1000); if (cap) dbm.setSetting('promo_daily_cap', cap);
    const dl = n(req.body.promo_popup_delay, 5, 300); if (dl) dbm.setSetting('promo_popup_delay', dl);
    if (req.body.promo_auto) dbm.setSetting('relance_enabled', '0'); // les relances promo remplacent les relances simples
    res.redirect('/admin/promotions?msg=' + encodeURIComponent('Réglages enregistrés ✔'));
  });

  // Aperçu de l'e-mail que recevrait un contact (rien n'est envoyé).
  app.get('/admin/promotions/apercu', requireLogin, async (req, res, next) => {
    try {
      syncContacts();
      const c = req.query.contact ? db().prepare('SELECT * FROM contacts WHERE id = ?').get(req.query.contact)
        : { id: 0, email: 'exemple@exemple.com', name: 'Marie Joseph', lang: req.query.lang || 'fr', vid: null, visitor_id: null, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), unsub_token: '0'.repeat(32) };
      const offer = c && pickOffer(c);
      if (!offer) return res.redirect('/admin/promotions?msg=' + encodeURIComponent("Aperçu impossible : aucune promotion en cours ne correspond (active, dates, public, livres)."));
      const mail = await composeEmail(c, offer, siteUrl);
      res.render('admin/promo-apercu', { page: 'admin', c, offer, mail });
    } catch (e) { next(e); }
  });

  app.post('/admin/promotions/run', requireLogin, async (req, res) => {
    const r = await runAuto(siteUrl, { force: true });
    res.redirect('/admin/promotions?msg=' + encodeURIComponent(r.skipped ? 'Aucun envoi : ' + r.reason + '.' : `${r.sent} e-mail(s) envoyé(s)${r.errors ? `, ${r.errors} échec(s)` : ''}.`));
  });

  app.get('/admin/promotions/contacts.csv', requireLogin, (req, res) => {
    const rows = db().prepare('SELECT email, name, lang, source, consent, created_at, emails_sent, last_email_at FROM contacts ORDER BY id').all();
    const csv = 'email,nom,langue,source,accord,inscrit_le,emails_envoyes,dernier_email\n' +
      rows.map((r) => [r.email, r.name, r.lang, r.source, r.consent, r.created_at, r.emails_sent, r.last_email_at || ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-lesly-tech-llc.csv"');
    res.send('﻿' + csv);
  });

  // Envois automatiques : vérification toutes les heures (garde-fous : délai par contact + plafond quotidien).
  setInterval(() => { runAuto(siteUrl).catch(() => {}); }, 3600 * 1000).unref();
}

// Pour l'assistant IA et le rapport quotidien.
function promosForPrompt(lang = 'fr') {
  return livePromos().filter((p) => p.show_on_site).map((p) => {
    const books = p.product_ids.length ? promoProducts(p).map((x) => x.title).join(', ') : 'tous les ebooks';
    return `- ${p.title} : ${discountLabel(p)} sur ${books}${codesText(p) ? ` — code(s) : ${codesText(p)}` : ''}${p.ends_at ? ` — jusqu'au ${endText(p, lang)}` : ''}`;
  }).join('\n');
}
function dailyStats() {
  const g = (sql) => db().prepare(sql).get().n;
  return {
    sent: g("SELECT COUNT(*) n FROM promo_sends WHERE at > datetime('now', '-1 day')"),
    newContacts: g("SELECT COUNT(*) n FROM contacts WHERE created_at > datetime('now', '-1 day') AND consent = 1"),
    contacts: g('SELECT COUNT(*) n FROM contacts WHERE consent = 1'),
    couponSales: g("SELECT COUNT(*) n FROM sales WHERE kind = 'sale' AND coupon != '' AND at > datetime('now', '-1 day')"),
    live: livePromos().map((p) => `${p.title} (${discountLabel(p)})`),
  };
}

module.exports = { register, settings, livePromos, promosForPrompt, dailyStats, runAuto, upsertContact, discountLabel, codesText };
