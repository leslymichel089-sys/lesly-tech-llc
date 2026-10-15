// monitor.js — surveillance automatique du site (anomalies système).
//
// Toutes les 10 minutes : disque persistant, mémoire, rafale d'erreurs serveur.
// Toutes les 24 heures : vérification des liens de vente et des fichiers du catalogue.
// Au démarrage : alerte « site redémarré » (déploiement ou plantage).
// Chaque anomalie déclenche watchdog.fire('anomaly', …) : e-mail, Telegram, WhatsApp, SMS.
const fs = require('fs');
const path = require('path');
const dbm = require('./db');
const watchdog = require('./watchdog');

const startedAt = Date.now();
const DISK_ALERT_PCT = 85;
const MEMORY_ALERT_MB = 450;
const ERRORS_PER_HOUR_ALERT = 10;
let last = { disk: null, memoryMb: 0, errorsLastHour: 0, checkedAt: null };

function diskUsage() {
  try {
    const st = fs.statfsSync(dbm.DATA_DIR);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    return { totalMb: Math.round(total / 1048576), freeMb: Math.round(free / 1048576), usedPct: Math.round((1 - free / total) * 100) };
  } catch (e) { return null; }
}

function check() {
  const disk = diskUsage();
  const memoryMb = Math.round(process.memoryUsage().rss / 1048576);
  const errorsLastHour = dbm.db.prepare("SELECT COUNT(*) n FROM error_log WHERE at > datetime('now', '-1 hour')").get().n;
  last = { disk, memoryMb, errorsLastHour, checkedAt: new Date().toISOString() };

  if (disk && disk.usedPct >= DISK_ALERT_PCT) {
    watchdog.fire('anomaly', 'Disque presque plein',
      `Le disque persistant (base + fichiers envoyés) est rempli à ${disk.usedPct} % (${disk.freeMb} Mo libres sur ${disk.totalMb} Mo). ` +
      'Supprime des vidéos lourdes depuis « Ajouter / Enlever » ou augmente la taille du disque sur Render.').catch(() => {});
  }
  if (memoryMb >= MEMORY_ALERT_MB) {
    watchdog.fire('anomaly', 'Mémoire élevée', `Le serveur utilise ${memoryMb} Mo de mémoire. Un redémarrage sur Render peut être nécessaire si cela persiste.`).catch(() => {});
  }
  if (errorsLastHour >= ERRORS_PER_HOUR_ALERT) {
    const recent = dbm.db.prepare('SELECT message FROM error_log ORDER BY id DESC LIMIT 3').all().map((r) => '• ' + r.message).join('\n');
    watchdog.fire('anomaly', 'Rafale d\'erreurs serveur', `${errorsLastHour} erreurs dans la dernière heure. Dernières :\n${recent}`).catch(() => {});
  }
}

// ---------- Vérification des liens et fichiers ----------
// Amazon et Payhip bloquent les robots (réponses 403/503) : ils ne sont pas vérifiables automatiquement.
const UNVERIFIABLE = /amazon\.|payhip\.com/i;

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (LeslyTech link check)' }, signal: AbortSignal.timeout(15000) });
    return res.status;
  } catch (e) { return 0; }
}

async function checkLinks() {
  const products = dbm.db.prepare('SELECT * FROM products WHERE active = 1').all().map(dbm.rowToProduct);
  const broken = [];
  let checked = 0;
  for (const p of products) {
    for (const f of [p.image, p.media]) {
      if (f && /^\/(uploads|videos|img)\//.test(f)) {
        const disk = f.startsWith('/uploads/') ? path.join(dbm.DATA_DIR, 'uploads', path.basename(f)) : path.join(__dirname, 'public', f);
        checked++;
        if (!fs.existsSync(disk)) broken.push(`${p.title} : fichier manquant ${f}`);
      }
    }
    for (const l of p.links || []) {
      if (!/^https?:\/\//.test(l.url) || UNVERIFIABLE.test(l.url)) continue;
      checked++;
      const st = await checkUrl(l.url);
      if (st === 404 || st === 410) broken.push(`${p.title} : lien ${l.label} introuvable (${st}) ${l.url}`);
    }
  }
  const result = { at: new Date().toISOString(), checked, broken };
  dbm.setSetting('linkcheck_result', JSON.stringify(result));
  if (broken.length) {
    watchdog.fire('anomaly', 'Liens ou fichiers cassés', `${broken.length} problème(s) détecté(s) :\n` + broken.slice(0, 15).map((b) => '• ' + b).join('\n')).catch(() => {});
  }
  return result;
}

function lastLinkCheck() {
  try { return JSON.parse(dbm.getSetting('linkcheck_result') || 'null'); } catch (e) { return null; }
}

function snapshot() {
  return { ...last, uptimeHours: Math.round((Date.now() - startedAt) / 36e5 * 10) / 10, startedAt: new Date(startedAt).toISOString(), linkCheck: lastLinkCheck() };
}

function start() {
  watchdog.fire('server_start', 'Site (re)démarré',
    `Le site vient de démarrer (${new Date().toISOString()}). Normal après une mise à jour ; inattendu sinon (plantage puis relance automatique).`).catch(() => {});
  setTimeout(check, 30 * 1000);
  setInterval(check, 10 * 60 * 1000).unref();
  // Liens : 5 min après le démarrage, puis toutes les 24 h.
  setTimeout(() => checkLinks().catch(() => {}), 5 * 60 * 1000).unref();
  setInterval(() => checkLinks().catch(() => {}), 24 * 3600 * 1000).unref();
}

module.exports = { start, snapshot, checkLinks, check };
