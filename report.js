// report.js — rapport quotidien automatique sur le fonctionnement du site.
//
// Envoyé chaque jour à l'heure choisie (par défaut 8 h, heure de New York / High Point NC) :
// e-mail HTML complet + résumé court sur Telegram / WhatsApp / SMS.
// L'envoi est mémorisé en base : pas de doublon, même après un redémarrage.
const dbm = require('./db');
const ai = require('./ai');
const watchdog = require('./watchdog');
const monitor = require('./monitor');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const q = (sql, ...a) => dbm.db.prepare(sql).get(...a);
const all = (sql, ...a) => dbm.db.prepare(sql).all(...a);

function settings() {
  return {
    hour: Math.min(23, Math.max(0, parseInt(dbm.getSetting('report_hour') || '8', 10) || 0)),
    tz: dbm.getSetting('report_tz') || 'America/New_York',
    enabled: dbm.getSetting('report_enabled') !== '0',
  };
}

function localParts(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24 };
}

// Statistiques des dernières 24 heures (et des 24 heures précédentes pour comparer).
function collect() {
  const day = "datetime('now', '-1 day')";
  const prevDay = "datetime('now', '-2 day')";
  const sales = all(`SELECT * FROM sales WHERE at > ${day} ORDER BY id DESC`);
  const realSales = sales.filter((s) => s.kind === 'sale');
  return {
    visits: q(`SELECT COUNT(*) n FROM visits WHERE at > ${day}`).n,
    visitsPrev: q(`SELECT COUNT(*) n FROM visits WHERE at > ${prevDay} AND at <= ${day}`).n,
    topPages: all(`SELECT path, COUNT(*) n FROM visits WHERE at > ${day} GROUP BY path ORDER BY n DESC LIMIT 5`),
    clicks: q(`SELECT COUNT(*) n FROM clicks WHERE at > ${day}`).n,
    topClicks: all(`SELECT p.title, c.label, COUNT(*) n FROM clicks c LEFT JOIN products p ON p.id = c.product_id
                    WHERE c.at > ${day} GROUP BY c.product_id, c.label ORDER BY n DESC LIMIT 5`),
    sales, salesCount: realSales.length,
    salesTotal: realSales.reduce((t, s) => t + (Number(s.amount) || 0), 0),
    refunds: sales.filter((s) => s.kind === 'refund').length,
    contacts: all(`SELECT name, email, substr(message, 1, 140) message FROM contact_messages WHERE created_at > ${day} ORDER BY id DESC`),
    subscribers: q(`SELECT COUNT(*) n FROM subscribers WHERE created_at > ${day}`).n,
    chats: q(`SELECT COUNT(DISTINCT conv) n FROM chat_messages WHERE at > ${day}`).n,
    chatQuestions: all(`SELECT substr(content, 1, 120) content FROM chat_messages WHERE role = 'user' AND at > ${day} ORDER BY id DESC LIMIT 6`).map((r) => r.content),
    errors: q(`SELECT COUNT(*) n FROM error_log WHERE at > ${day}`).n,
    lastErrors: all(`SELECT message FROM error_log WHERE at > ${day} ORDER BY id DESC LIMIT 3`).map((r) => r.message),
    products: q('SELECT COUNT(*) n FROM products WHERE active = 1').n,
    hiddenProducts: q('SELECT COUNT(*) n FROM products WHERE active = 0').n,
    ai: ai.status().filter((s) => s.configured),
    system: monitor.snapshot(),
    siteEnabled: dbm.getSetting('site_enabled') !== '0',
    accounts: require('./accounts').dailyStats(),
  };
}

function health(d) {
  const problems = [];
  if (!d.siteEnabled) problems.push('le site est DÉSACTIVÉ (page de maintenance)');
  if (d.errors >= 5) problems.push(`${d.errors} erreurs serveur en 24 h`);
  if (d.system.disk && d.system.disk.usedPct >= 85) problems.push(`disque rempli à ${d.system.disk.usedPct} %`);
  if (d.system.linkCheck && d.system.linkCheck.broken.length) problems.push(`${d.system.linkCheck.broken.length} lien(s)/fichier(s) cassé(s)`);
  if (!d.ai.length) problems.push('aucune IA configurée (assistant des visiteurs inactif)');
  else if (!d.ai.some((a) => a.state === 'ok' || a.state === 'inconnu')) problems.push('tous les fournisseurs IA sont en erreur');
  return problems;
}

async function aiSummary(d, problems) {
  try {
    const facts = {
      visites_24h: d.visits, visites_veille: d.visitsPrev, clics_achat: d.clicks, ventes: d.salesCount,
      total_ventes_usd: Number(d.salesTotal.toFixed(2)), messages_contact: d.contacts.length, nouveaux_abonnes: d.subscribers,
      conversations_assistant: d.chats, questions_visiteurs: d.chatQuestions, erreurs: d.errors, problemes: problems,
      pages_populaires: d.topPages.map((p) => `${p.path} (${p.n})`), clics_populaires: d.topClicks.map((c) => `${c.title} → ${c.label} (${c.n})`),
    };
    const r = await ai.chat({
      system: "Tu es l'assistant de gestion du site de Lesly Tech LLC. Tu t'adresses au propriétaire, le PDG Lesly, en le tutoyant, en français.",
      messages: [{ role: 'user', content: 'Voici les chiffres des dernières 24 h du site :\n' + JSON.stringify(facts) +
        "\nÉcris un résumé de 3 à 5 phrases : ce qui s'est passé, ce qui va bien, ce qui demande son attention, et 1 ou 2 actions concrètes à faire. " +
        "N'invente aucun chiffre. Pas de titre, pas de liste, pas de markdown." }],
      maxTokens: 350, temperature: 0.4,
    });
    return r.text;
  } catch (e) { return ''; }
}

const row = (k, v) => `<tr><td style="padding:6px 10px;color:#7a6a58">${esc(k)}</td><td style="padding:6px 10px;font-weight:700">${v}</td></tr>`;
const list = (items) => items.length ? '<ul style="margin:4px 0 0 18px;padding:0">' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>' : '<span style="color:#999">—</span>';

async function build() {
  const d = collect();
  const problems = health(d);
  const summary = await aiSummary(d, problems);
  const dateFr = new Date().toLocaleDateString('fr-FR', { timeZone: settings().tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const status = problems.length ? `⚠️ ${problems.length} point(s) à surveiller` : '✅ Tout fonctionne normalement';
  const trend = d.visitsPrev ? Math.round((d.visits - d.visitsPrev) / d.visitsPrev * 100) : null;
  const sys = d.system;

  const text = [
    `Rapport quotidien — ${dateFr}`, status, '',
    summary ? summary + '\n' : '',
    `Visites (24 h) : ${d.visits}${trend != null ? ` (${trend >= 0 ? '+' : ''}${trend} % vs veille)` : ''}`,
    `Clics vers les boutiques : ${d.clicks}`,
    `Ventes : ${d.salesCount} — ${d.salesTotal.toFixed(2)} $${d.refunds ? ` (${d.refunds} remboursement(s))` : ''}`,
    `Messages de contact : ${d.contacts.length} · Nouveaux abonnés : ${d.subscribers}`,
    `Conversations avec l'assistant IA : ${d.chats}`,
    `Comptes Google : +${d.accounts.newAccounts} (total ${d.accounts.accounts}, ${d.accounts.consenting} acceptent les e-mails) · Relances envoyées : ${d.accounts.relances}`,
    `Erreurs serveur : ${d.errors}`,
    problems.length ? '\nÀ surveiller :\n' + problems.map((p) => '• ' + p).join('\n') : '',
    `\nCatalogue : ${d.products} publication(s) visibles${d.hiddenProducts ? `, ${d.hiddenProducts} masquée(s)` : ''}.`,
    `Système : en ligne depuis ${sys.uptimeHours} h${sys.disk ? `, disque ${sys.disk.usedPct} %` : ''}, mémoire ${sys.memoryMb} Mo.`,
  ].filter((l) => l !== '').join('\n');

  const short = `${status}\nVisites ${d.visits} · Clics ${d.clicks} · Ventes ${d.salesCount} (${d.salesTotal.toFixed(2)} $) · Contacts ${d.contacts.length} · Chats ${d.chats} · Erreurs ${d.errors}` +
    (problems.length ? '\n⚠️ ' + problems.join(' ; ') : '');

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#2b2118">
  <div style="background:linear-gradient(135deg,#c2571b,#e8932f);color:#fff8ef;padding:22px 24px;border-radius:14px 14px 0 0">
    <div style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;opacity:.85">Lesly Tech LLC — rapport quotidien</div>
    <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(dateFr)}</div>
    <div style="margin-top:8px;font-weight:700">${esc(status)}</div>
  </div>
  <div style="background:#fffdf8;border:1px solid #e8ddc9;border-top:0;padding:20px 24px;border-radius:0 0 14px 14px">
    ${summary ? `<p style="font-size:15px;line-height:1.6;background:#f3ecdd;padding:14px 16px;border-radius:10px;margin:0 0 18px">${esc(summary)}</p>` : ''}
    ${problems.length ? `<p style="color:#b3372a;font-weight:700;margin:0 0 6px">À surveiller :</p>${list(problems.map(esc))}` : ''}
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">
      ${row('Visites (24 h)', `${d.visits}${trend != null ? ` <span style="color:${trend >= 0 ? '#1e7a4c' : '#b3372a'}">(${trend >= 0 ? '+' : ''}${trend} %)</span>` : ''}`)}
      ${row('Clics vers les boutiques', d.clicks)}
      ${row('Ventes', `${d.salesCount} — ${d.salesTotal.toFixed(2)} $${d.refunds ? ` · ${d.refunds} remboursement(s)` : ''}`)}
      ${row('Messages de contact', d.contacts.length)}
      ${row('Nouveaux abonnés newsletter', d.subscribers)}
      ${row('Conversations assistant IA', d.chats)}
      ${row('Nouveaux comptes Google', `${d.accounts.newAccounts} (total ${d.accounts.accounts}, ${d.accounts.consenting} acceptent les e-mails)`)}
      ${row('Relances e-mail envoyées', d.accounts.relances)}
      ${row('Erreurs serveur', d.errors)}
      ${row('Publications visibles', `${d.products}${d.hiddenProducts ? ` (+${d.hiddenProducts} masquées)` : ''}`)}
    </table>
    <h3 style="margin:20px 0 4px;font-size:15px">Ventes</h3>${list(d.sales.map((s) => `${esc(s.product)} — ${Number(s.amount).toFixed(2)} ${esc(s.currency)} (${esc(s.platform)}${s.kind !== 'sale' ? ', ' + esc(s.kind) : ''})`))}
    <h3 style="margin:16px 0 4px;font-size:15px">Pages les plus vues</h3>${list(d.topPages.map((p) => `${esc(p.path)} — ${p.n}`))}
    <h3 style="margin:16px 0 4px;font-size:15px">Clics vers les boutiques</h3>${list(d.topClicks.map((c) => `${esc(c.title)} → ${esc(c.label)} — ${c.n}`))}
    <h3 style="margin:16px 0 4px;font-size:15px">Messages de contact</h3>${list(d.contacts.map((c) => `<strong>${esc(c.name)}</strong> (${esc(c.email)}) : ${esc(c.message)}`))}
    <h3 style="margin:16px 0 4px;font-size:15px">Questions posées à l'assistant</h3>${list(d.chatQuestions.map(esc))}
    ${d.lastErrors.length ? `<h3 style="margin:16px 0 4px;font-size:15px">Dernières erreurs</h3>${list(d.lastErrors.map(esc))}` : ''}
    <h3 style="margin:16px 0 4px;font-size:15px">IA</h3>${list(d.ai.map((a) => `${esc(a.name)} : ${esc(a.state)}${a.lastError ? ' — ' + esc(a.lastError) : ''}`))}
    <h3 style="margin:16px 0 4px;font-size:15px">Système</h3>
    <p style="margin:4px 0;font-size:14px">En ligne depuis ${sys.uptimeHours} h · Mémoire ${sys.memoryMb} Mo${sys.disk ? ` · Disque ${sys.disk.usedPct} % (${sys.disk.freeMb} Mo libres)` : ''}${sys.linkCheck ? ` · Liens vérifiés : ${sys.linkCheck.checked}, cassés : ${sys.linkCheck.broken.length}` : ''}</p>
    <p style="margin-top:22px;font-size:12px;color:#999">Rapport automatique — Lesly Tech LLC. Réglages : /admin/rapport</p>
  </div></div>`;

  return { title: `Rapport quotidien — ${status}`, text, short, html, data: d, problems, summary };
}

async function send() {
  const r = await build();
  const res = await watchdog.fire('daily_report', r.title, r.text, { html: r.html, short: r.short });
  return { ...r, result: res };
}

// Vérifie chaque minute s'il est l'heure d'envoyer le rapport du jour.
function start() {
  const tick = async () => {
    const s = settings();
    if (!s.enabled) return;
    const now = localParts(s.tz);
    if (now.hour < s.hour || dbm.getSetting('report_last_date') === now.date) return;
    dbm.setSetting('report_last_date', now.date); // posé AVANT l'envoi : jamais de double envoi
    try { await send(); } catch (e) { dbm.logError('rapport quotidien : ' + e.message); }
  };
  setInterval(() => { tick().catch(() => {}); }, 60 * 1000).unref();
}

module.exports = { start, build, send, settings };
