// ai.js — routeur IA avec bascule automatique.
//
// Fournisseur principal : OmniRoute (https://github.com/diegosouzapw/OmniRoute),
// un routeur IA qui expose une API compatible OpenAI en local et fait LUI-MÊME
// la bascule automatique entre 352 providers (fallback 4 niveaux).
// Sur le PC de l'utilisateur, OmniRoute se lance via :
//   C:\Users\Lesly\AppData\Roaming\npm\omniroute.ps1
// et écoute sur http://localhost:20128/v1
//
// Configuration (.env) :
//   OMNIROUTE_URL=http://localhost:20128/v1   (défaut — là où tourne OmniRoute)
//   OMNIROUTE_MODEL=auto                      (défaut — OmniRoute choisit le meilleur)
//   OMNIROUTE_API_KEY=                         (optionnel, la plupart des tiers gratuits n'en demandent pas)
//   AI_TIMEOUT_MS=60000
//
// Secours : si OmniRoute est injoignable, on tente la liste générique
//   AI_PROVIDER_1_URL= ... (format POST JSON {prompt, lang} -> {text})
//   AI_PROVIDER_2_URL= ... etc.
// puis erreur claire.
//
// Le watchdog s'abonne via ai.onEvent(...) et est prévenu à chaque bascule
// (failover) ou échec total, sans que ai.js dépende du watchdog.
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);
const OMNIROUTE_URL = (process.env.OMNIROUTE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
const OMNIROUTE_MODEL = process.env.OMNIROUTE_MODEL || 'auto';
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY || '';

let eventHandler = null;
function onEvent(fn) { eventHandler = fn; }
function emit(ev) {
  if (eventHandler) { try { eventHandler(ev); } catch (e) {} }
}

const SYSTEM_BY_LANG = {
  fr: 'Réponds en français.',
  en: 'Reply in English.',
  ht: 'Reponn an kreyòl ayisyen.',
  es: 'Responde en español.',
};

async function postJson(url, body, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Appel OmniRoute (format OpenAI : /v1/chat/completions)
async function callOmniroute(prompt, lang) {
  const data = await postJson(
    `${OMNIROUTE_URL}/chat/completions`,
    {
      model: OMNIROUTE_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_BY_LANG[lang] || SYSTEM_BY_LANG.fr },
        { role: 'user', content: prompt },
      ],
    },
    OMNIROUTE_API_KEY
  );
  const text = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!text || !String(text).trim()) throw new Error('réponse OmniRoute vide ou invalide');
  return String(text).trim();
}

// Providers génériques de secours (format {prompt, lang} -> {text})
function providersFromEnv() {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`AI_PROVIDER_${i}_URL`];
    if (url) {
      list.push({
        n: i,
        url,
        key: process.env[`AI_PROVIDER_${i}_KEY`] || '',
        model: process.env[`AI_PROVIDER_${i}_MODEL`] || '',
      });
    }
  }
  return list;
}

async function callGeneric(p, prompt, lang) {
  const data = await postJson(p.url, {
    prompt, lang, ...(p.model ? { model: p.model } : {}),
  }, p.key);
  if (!data || typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('réponse invalide (champ "text" manquant)');
  }
  return data.text.trim();
}

// generateDescription(prompt, lang) -> Promise<string>
async function generateDescription(prompt, lang = 'fr') {
  const errors = [];

  // 1) OmniRoute (avec son propre fallback multi-providers intégré)
  try {
    return await callOmniroute(prompt, lang);
  } catch (e) {
    errors.push(`omniroute: ${e.message}`);
    emit({ kind: 'failover', from: 'omniroute', to: 'providers génériques', error: e.message });
  }

  // 2) Providers génériques de secours
  const providers = providersFromEnv();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      return await callGeneric(p, prompt, lang);
    } catch (e) {
      errors.push(`provider ${p.n}: ${e.message}`);
      const next = providers[i + 1];
      emit(next
        ? { kind: 'failover', from: `provider ${p.n}`, to: `provider ${next.n}`, error: e.message }
        : { kind: 'all_failed', errors: errors.slice() });
    }
  }

  const err = new Error(
    'IA indisponible — démarrez OmniRoute sur le PC ' +
    '(C:\\Users\\Lesly\\AppData\\Roaming\\npm\\omniroute.ps1) ou configurez ' +
    'OMNIROUTE_URL / AI_PROVIDER_* dans le .env. Détails : ' + errors.join(' ; ')
  );
  err.code = providers.length === 0 ? 'AI_NOT_CONFIGURED' : 'AI_ALL_FAILED';
  throw err;
}

module.exports = { generateDescription, onEvent };
