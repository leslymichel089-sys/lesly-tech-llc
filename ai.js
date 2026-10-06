// ai.js — routeur IA avec bascule automatique.
// Ordre de priorité : 1) DeepSeek, 2) Kimi, 3) providers génériques, 4) OmniRoute si configuré.
// Les clés peuvent venir des variables d'environnement (prioritaires)
// ou de la page admin /admin/ai (stockées en base locale).
const dbm = require('./db');

function getConfig(dbKey, envKey, fallback = '') {
  if (process.env[envKey]) return process.env[envKey];
  const value = dbm.getSetting(dbKey);
  return value || fallback;
}

const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);

const DEEPSEEK_BASE_URL = (getConfig('ai_deepseek_base_url', 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1') || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const DEEPSEEK_API_KEY = getConfig('ai_deepseek_key', 'DEEPSEEK_API_KEY');
const DEEPSEEK_MODEL = getConfig('ai_deepseek_model', 'DEEPSEEK_MODEL', 'deepseek-chat');

const KIMI_BASE_URL = (getConfig('ai_kimi_base_url', 'KIMI_BASE_URL', 'https://api.moonshot.ai/v1') || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const KIMI_API_KEY = getConfig('ai_kimi_key', 'KIMI_API_KEY');
const KIMI_MODEL = getConfig('ai_kimi_model', 'KIMI_MODEL', 'moonshot-v1-8k');

const OMNIROUTE_URL = (process.env.OMNIROUTE_URL || '').replace(/\/$/, '');
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
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (e) {}
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(baseUrl, apiKey, model, prompt, lang) {
  const data = await postJson(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_BY_LANG[lang] || SYSTEM_BY_LANG.fr },
        { role: 'user', content: prompt },
      ],
    },
    apiKey
  );
  const text = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!text || !String(text).trim()) throw new Error('réponse vide ou invalide');
  return String(text).trim();
}

function genericProvidersFromEnv() {
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

function buildProviders(prompt, lang) {
  const list = [];

  if (DEEPSEEK_API_KEY) {
    list.push({
      name: 'deepseek',
      run: () => callOpenAICompatible(DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, prompt, lang),
    });
  }

  if (KIMI_API_KEY) {
    list.push({
      name: 'kimi',
      run: () => callOpenAICompatible(KIMI_BASE_URL, KIMI_API_KEY, KIMI_MODEL, prompt, lang),
    });
  }

  genericProvidersFromEnv().forEach((p) => {
    list.push({ name: `provider ${p.n}`, run: () => callGeneric(p, prompt, lang) });
  });

  // OmniRoute n'est utilisé que si une URL est explicitement configurée,
  // ce qui évite de tenter localhost depuis Render.
  if (OMNIROUTE_URL) {
    list.push({
      name: 'omniroute',
      run: () => callOpenAICompatible(OMNIROUTE_URL, OMNIROUTE_API_KEY, OMNIROUTE_MODEL, prompt, lang),
    });
  }

  return list;
}

// generateDescription(prompt, lang) -> Promise<string>
async function generateDescription(prompt, lang = 'fr') {
  const providers = buildProviders(prompt, lang);
  const errors = [];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      return await p.run();
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      const next = providers[i + 1];
      emit(next
        ? { kind: 'failover', from: p.name, to: next.name, error: e.message }
        : { kind: 'all_failed', errors: errors.slice() });
    }
  }

  const err = new Error(
    providers.length === 0
      ? 'IA non configurée — renseignez DeepSeek ou Kimi dans /admin/ai, ou définissez DEEPSEEK_API_KEY / KIMI_API_KEY / AI_PROVIDER_* dans le .env.'
      : `IA indisponible après ${providers.length} tentative(s). Détails : ${errors.join(' ; ')}`
  );
  err.code = providers.length === 0 ? 'AI_NOT_CONFIGURED' : 'AI_ALL_FAILED';
  throw err;
}

module.exports = { generateDescription, onEvent };