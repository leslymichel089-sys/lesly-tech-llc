// notify.js — envoi de notifications multi-canaux, EN PARALLÈLE.
//
// Canaux : e-mail (SMTP), WhatsApp (CallMeBot ou Twilio), Telegram (bot),
// notification Windows (toast local, PowerShell).
//
// Configuration : variable d'environnement si définie, SINON valeur saisie
// dans la page admin (table settings), SINON canal ignoré proprement.
// Aucun credential en dur : tout vient de l'env ou de l'admin (saisi par l'utilisateur).
//
// Chaque envoi tente ses canaux en parallèle (Promise.allSettled) : la panne
// d'un canal ne bloque pas les autres. Chaque canal est réessayé (retry)
// avant d'être déclaré en échec.
const dbm = require('./db');

const CHANNELS = ['email', 'whatsapp', 'telegram', 'windows'];

// Valeur effective : ENV prioritaire, puis réglage admin, puis ''.
function val(envName, dbKey) {
  const e = process.env[envName];
  if (e !== undefined && String(e).trim() !== '') return String(e).trim();
  const s = dbm.getSetting(dbKey);
  return s === null || s === undefined ? '' : String(s);
}
function isEnv(envName) {
  const e = process.env[envName];
  return e !== undefined && String(e).trim() !== '';
}

// ---------- Configuration effective de chaque canal (null = non configuré) ----------
function emailConfig() {
  const host = val('SMTP_HOST', 'notif_smtp_host');
  const user = val('SMTP_USER', 'notif_smtp_user');
  const to = val('NOTIF_EMAIL_TO', 'notif_email_to');
  if (!host || !user || !to) return null;
  return {
    host,
    port: parseInt(val('SMTP_PORT', 'notif_smtp_port') || '587', 10),
    secure: /^(1|true|yes)$/i.test(val('SMTP_SECURE', 'notif_smtp_secure')),
    user,
    pass: val('SMTP_PASS', 'notif_smtp_pass'),
    from: val('SMTP_FROM', 'notif_smtp_from') || user,
    to,
  };
}

function whatsappConfig() {
  const mode = (val('WHATSAPP_MODE', 'notif_whatsapp_mode') || 'callmebot').toLowerCase();
  if (mode === 'twilio') {
    const sid = val('TWILIO_ACCOUNT_SID', 'notif_twilio_sid');
    const token = val('TWILIO_AUTH_TOKEN', 'notif_twilio_token');
    const from = val('TWILIO_WHATSAPP_FROM', 'notif_twilio_from');
    const to = val('WHATSAPP_TO', 'notif_whatsapp_to');
    if (!sid || !token || !from || !to) return null;
    return { mode, sid, token, from, to };
  }
  const key = val('CALLMEBOT_APIKEY', 'notif_callmebot_key');
  const phone = val('WHATSAPP_PHONE', 'notif_whatsapp_phone');
  if (!key || !phone) return null;
  return { mode: 'callmebot', key, phone };
}

function telegramConfig() {
  const token = val('TELEGRAM_BOT_TOKEN', 'notif_telegram_token');
  const chat = val('TELEGRAM_CHAT_ID', 'notif_telegram_chat');
  if (!token || !chat) return null;
  return { token, chat };
}

function windowsConfig() {
  if (!/^(1|true|yes)$/i.test(val('WINDOWS_NOTIFY', 'notif_windows'))) return null;
  return { windowsOnly: process.platform !== 'win32' };
}

// ---------- État des canaux pour le panel admin ----------
function channelStatus() {
  const email = emailConfig();
  const wa = whatsappConfig();
  const tg = telegramConfig();
  const win = windowsConfig();
  const src = (envNames) => (envNames.some(isEnv) ? 'env' : 'admin');
  return [
    { channel: 'email', configured: !!email, source: email ? src(['SMTP_HOST', 'SMTP_USER', 'NOTIF_EMAIL_TO']) : null },
    { channel: 'whatsapp', configured: !!wa, source: wa ? src(['WHATSAPP_MODE', 'CALLMEBOT_APIKEY', 'WHATSAPP_PHONE', 'TWILIO_ACCOUNT_SID']) : null, mode: wa ? wa.mode : null },
    { channel: 'telegram', configured: !!tg, source: tg ? src(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) : null },
    { channel: 'windows', configured: !!win, source: win ? src(['WINDOWS_NOTIFY']) : null, windowsOnly: win ? win.windowsOnly : false },
  ];
}

// ---------- Retry générique ----------
async function withRetry(fn, retries = 2, delayMs = 1500) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

// ---------- E-mail : client SMTP minimal (net/tls natifs, sans dépendance) ----------
// Supporte STARTTLS (port 587, cas courant) et TLS direct (port 465, SMTP_SECURE=1),
// avec AUTH LOGIN. Limites assumées : un seul destinataire, texte brut.
function smtpSend(cfg, subject, text) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const tls = require('tls');
    let socket = null;
    let buf = '';
    let step = 0;
    let ehloResp = '';
    const timer = setTimeout(() => done(new Error('timeout SMTP (20s)')), 20000);

    function done(err, ok) {
      clearTimeout(timer);
      if (socket) { try { socket.destroy(); } catch (e) {} socket = null; }
      if (err) reject(err); else resolve(ok);
    }
    function writeLine(s) { socket.write(s + '\r\n'); }
    function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
    function encSubject(s) {
      return /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s;
    }
    function attach(sock) {
      socket = sock;
      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.on('error', (e) => done(new Error('SMTP : ' + e.message)));
    }
    function onData(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = line.match(/^(\d{3})([ -])/);
        if (!m) continue;
        // Pendant EHLO on accumule TOUTES les lignes (STARTTLS est souvent sur une ligne intermédiaire « 250-... »).
        if (step === 1 && m[1] === '250') ehloResp += line + '\n';
        if (m[2] === '-') continue; // réponse multi-ligne : attendre la fin
        try { onReply(m[1], line); } catch (e) { done(e); return; }
      }
    }
    function onReply(code, line) {
      if (step === 0 && code === '220') { step = 1; ehloResp = ''; writeLine('EHLO leslytech'); }
      else if (step === 1 && code === '250') {
        // ehloResp a été accumulé ligne par ligne dans onData (lignes « 250-... » incluses).
        if (!cfg.secure && /STARTTLS/i.test(ehloResp)) { step = 2; writeLine('STARTTLS'); }
        else { step = 3; writeLine('AUTH LOGIN'); }
        ehloResp = '';
      }
      else if (step === 2 && code === '220') {
        const secureSock = tls.connect({ socket, servername: cfg.host });
        buf = '';
        attach(secureSock);
        step = 1; ehloResp = ''; writeLine('EHLO leslytech');
      }
      else if (step === 3 && code === '334') { step = 4; writeLine(b64(cfg.user)); }
      else if (step === 4 && code === '334') { step = 5; writeLine(b64(cfg.pass)); }
      else if (step === 5 && code === '235') { step = 6; writeLine(`MAIL FROM:<${cfg.from}>`); }
      else if (step === 6 && code === '250') { step = 7; writeLine(`RCPT TO:<${cfg.to}>`); }
      else if ((step === 7 && (code === '250' || code === '251'))) { step = 8; writeLine('DATA'); }
      else if (step === 8 && code === '354') {
        step = 9;
        const msg =
          `From: ${cfg.from}\r\nTo: ${cfg.to}\r\nSubject: ${encSubject(subject)}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n.`;
        writeLine(msg);
      }
      else if (step === 9 && code === '250') { step = 10; writeLine('QUIT'); done(null, 'e-mail envoyé'); }
      else if (step === 10) { /* fin */ }
      else { done(new Error(`SMTP : réponse inattendue « ${line} »`)); }
    }

    try {
      if (cfg.secure) attach(tls.connect(cfg.port, cfg.host, { servername: cfg.host }));
      else attach(net.connect(cfg.port, cfg.host));
    } catch (e) { done(e); }
  });
}

// ---------- Telegram ----------
async function telegramSend(cfg, title, message) {
  const text = `${title}\n${message}`.slice(0, 4000);
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chat, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram : ' + (data.description || 'échec'));
  return 'message Telegram envoyé';
}

// ---------- WhatsApp ----------
async function whatsappSend(cfg, title, message) {
  const text = `${title}\n${message}`;
  if (cfg.mode === 'twilio') {
    const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
    const params = new URLSearchParams({ From: cfg.from, To: cfg.to, Body: text.slice(0, 1500) });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
    return 'WhatsApp envoyé (Twilio)';
  }
  // CallMeBot : API GET gratuite (voir README pour l'activer).
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cfg.phone)}` +
    `&text=${encodeURIComponent(text.slice(0, 1000))}&apikey=${encodeURIComponent(cfg.key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`CallMeBot HTTP ${res.status} : ${body.slice(0, 120)}`);
  return 'WhatsApp envoyé (CallMeBot)';
}

// ---------- Notification Windows (toast local) ----------
// Ne fonctionne QUE si le serveur tourne sur le PC Windows de l'utilisateur.
// Ailleurs : échec propre avec message explicite (voir README).
function windowsSend(title, message) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Toast Windows : le serveur ne tourne pas sur Windows (voir README)'));
    }
    const { execFile } = require('child_process');
    const t64 = Buffer.from(String(title), 'utf8').toString('base64');
    const m64 = Buffer.from(String(message), 'utf8').toString('base64');
    const ps = [
      '$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]));',
      '$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[1]));',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;',
      '$tpl=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
      '$txt=$tpl.GetElementsByTagName("text");',
      '$txt[0].AppendChild($tpl.CreateTextNode($t)) > $null;',
      '$txt[1].AppendChild($tpl.CreateTextNode($m)) > $null;',
      '$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl);',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Lesly Tech LLC").Show($toast);',
    ].join(' ');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps, t64, m64],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error('Toast Windows : ' + ((stderr || err.message || '').trim().slice(0, 200))));
        else resolve('toast Windows affiché');
      });
  });
}

// ---------- Envoi en PARALLÈLE sur tous les canaux configurés ----------
// Retourne { ok, reason?, results: [{channel, ok, detail}], failed: [...] }.
// Si aucun canal configuré : { ok:false, reason:'no_channel', results:[] }.
async function sendAll(title, message, opts = {}) {
  const jobs = [];
  const email = emailConfig();
  if (email) jobs.push(['email', () => smtpSend(email, `[Lesly Tech LLC] ${title}`, message)]);
  const wa = whatsappConfig();
  if (wa) jobs.push(['whatsapp', () => whatsappSend(wa, title, message)]);
  const tg = telegramConfig();
  if (tg) jobs.push(['telegram', () => telegramSend(tg, title, message)]);
  const win = windowsConfig();
  if (win) jobs.push(['windows', () => windowsSend(title, message)]);

  if (jobs.length === 0) return { ok: false, reason: 'no_channel', results: [], failed: [] };

  const retries = opts.retries !== undefined ? opts.retries : 2;
  const results = await Promise.all(jobs.map(async ([channel, fn]) => {
    try {
      const detail = await withRetry(fn, retries);
      return { channel, ok: true, detail };
    } catch (e) {
      return { channel, ok: false, detail: e.message || String(e) };
    }
  }));
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results, failed };
}

// Source effective d'un réglage : 'env' | 'admin' | null.
function sourceOf(envName, dbKey) {
  if (isEnv(envName)) return 'env';
  const s = dbm.getSetting(dbKey);
  return s !== null && s !== undefined && String(s) !== '' ? 'admin' : null;
}

module.exports = { CHANNELS, sendAll, channelStatus, val, sourceOf };
