// watchdog.js — surveillance du site et alertes multi-canaux.
//
// Le watchdog observe le site en continu et prévient l'utilisateur dès qu'une
// situation exige son attention : site activé/désactivé, produit ajouté/retiré,
// drapeau « mise à jour disponible » modifié, pic anormal de visites, bascule
// du fallback IA sur un autre provider, erreurs serveur, échec d'un canal.
//
// Chaque type d'alerte est ACTIVABLE/DÉSACTIVABLE depuis l'admin, avec seuils
// réglables (ex. pic de visites = X visites/heure).
// Les envois passent par notify.js (parallèle + retry par canal).
// Chaque alerte est journalisée dans la table notif_log, visible dans l'admin.
const dbm = require('./db');
const notify = require('./notify');

const ALERT_TYPES = [
  'site_toggle',      // site activé / désactivé
  'product_added',    // produit ajouté
  'product_removed',  // produit retiré
  'update_flag',      // drapeau « mise à jour disponible » modifié
  'visits_spike',     // pic anormal de visites
  'ai_failover',      // bascule du routeur IA sur un autre provider
  'server_error',     // erreur serveur
  'channel_failure',  // échec d'un canal de notification lui-même
];

// Anti-spam : délai minimum entre deux alertes du même type.
const COOLDOWN_MS = {
  site_toggle: 0,
  product_added: 0,
  product_removed: 0,
  update_flag: 0,
  visits_spike: 3600 * 1000,   // 1 alerte max par heure (le seuil est horaire)
  ai_failover: 10 * 60 * 1000,
  server_error: 15 * 60 * 1000,
  channel_failure: 30 * 60 * 1000,
};
const lastFired = {};

function isAlertEnabled(type) {
  return dbm.getSetting('alert_' + type) !== '0';
}

// Déclenche une alerte : vérifie l'activation + cooldown, envoie via notify,
// journalise le résultat. Ne lève jamais d'exception (fire-and-forget sûr).
async function fire(type, title, message) {
  try {
    if (!ALERT_TYPES.includes(type)) return { ok: false, reason: 'unknown_type' };
    if (!isAlertEnabled(type)) {
      dbm.logNotif(type, title, message, [{ channel: '-', ok: false, detail: 'alerte désactivée dans l’admin' }]);
      return { ok: false, reason: 'disabled' };
    }
    const now = Date.now();
    const cd = COOLDOWN_MS[type] || 0;
    if (cd && lastFired[type] && now - lastFired[type] < cd) {
      return { ok: false, reason: 'cooldown' };
    }
    lastFired[type] = now;

    const res = await notify.sendAll(title, message);
    dbm.logNotif(type, title, message, res.results);

    if (res.reason === 'no_channel') return { ok: false, reason: 'no_channel', results: [] };

    // Échec d'un canal : alerte visible dans l'admin + autres canaux.
    // (Pas de récursion : une alerte channel_failure ne se re-déclenche pas elle-même.)
    if (res.failed && res.failed.length > 0 && type !== 'channel_failure') {
      const detail = res.failed.map((f) => `${f.channel} : ${f.detail}`).join(' | ');
      fire('channel_failure',
        'Échec d’un canal de notification',
        `Canal(aux) en échec après retry : ${detail}. Les autres canaux ont été tentés en parallèle.`
      ).catch(() => {});
    }
    return { ok: res.ok, results: res.results, failed: res.failed };
  } catch (e) {
    try { dbm.logNotif(type, title, message, [{ channel: '-', ok: false, detail: 'watchdog : ' + e.message }]); } catch (_) {}
    return { ok: false, reason: 'watchdog_error', error: e.message };
  }
}

// Vérifie le pic de visites : à appeler à chaque page vue (compteur horaire).
// N'alerte qu'une fois par heure calendaire quand le seuil est atteint.
function checkVisitsSpike() {
  try {
    const threshold = parseInt(dbm.getSetting('visits_spike_threshold') || '100', 10);
    if (!(threshold > 0)) return Promise.resolve({ ok: false, reason: 'no_threshold' });
    const count = dbm.countVisitHour();
    if (count < threshold) return Promise.resolve({ ok: false, reason: 'no_spike' });
    const hour = dbm.currentHour();
    if (dbm.getSetting('spike_alert_for') === hour) {
      return Promise.resolve({ ok: false, reason: 'already_alerted' });
    }
    dbm.setSetting('spike_alert_for', hour);
    return fire(
      'visits_spike',
      'Pic de visites détecté',
      `${count} pages vues sur l’heure en cours (seuil réglé à ${threshold}/heure).`
    );
  } catch (e) {
    return Promise.resolve({ ok: false, reason: 'watchdog_error' });
  }
}

// Bouton « envoyer une notification de test » : contourne les toggles/cooldowns,
// mais journalise toujours. Réussit PROPREMENT même sans canal configuré.
async function testAlert() {
  const res = await notify.sendAll(
    'Test — Lesly Tech LLC',
    'Ceci est une notification de test du watchdog. Si vous la recevez, le canal fonctionne.'
  );
  try {
    dbm.logNotif('test', 'Notification de test', 'Envoi manuel depuis l’admin.', res.results);
  } catch (e) {}
  return res; // { ok:false, reason:'no_channel' } si aucun canal configuré
}

module.exports = { ALERT_TYPES, COOLDOWN_MS, fire, checkVisitsSpike, testAlert, isAlertEnabled };
