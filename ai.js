// ai.js — routeur IA avec bascule automatique sur TOUS les fournisseurs configurés.
//
// Ordre (charte Lesly Tech LLC) : DeepSeek d'abord, puis Kimi, Anthropic, OpenAI,
// Gemini, Groq, OpenRouter, Mistral, puis les providers génériques et OmniRoute.
// Un fournisseur n'est tenté que si sa clé existe (variable d'environnement prioritaire,
// sinon valeur saisie dans /admin/ai). Un fournisseur qui échoue plusieurs fois de suite
// est mis « en pause » quelques minutes pour ne pas ralentir les visiteurs.
const dbm = require('./db');

const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);

// Registre des fournisseurs (ordre = priorité).
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    env: 'DEEPSEEK', help: 'platform.deepseek.com → API keys' },
  { id: 'kimi', name: 'Kimi (Moonshot)', kind: 'openai', base: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6',
    env: 'KIMI', help: 'platform.moonshot.ai → API Keys' },
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', vision: true, base: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5',
    env: 'ANTHROPIC', help: 'console.anthropic.com → API Keys' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', vision: true, base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    env: 'OPENAI', help: 'platform.openai.com → API keys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', vision: true, base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash',
    env: 'GEMINI', help: 'aistudio.google.com → Get API key' },
  { id: 'groq', name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile',
    env: 'GROQ', help: 'console.groq.com → API Keys' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', vision: true, base: 'https://openrouter.ai/api/v1', model: 'openrouter/auto',
    env: 'OPENROUTER', help: 'openrouter.ai → Keys' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest',
    env: 'MISTRAL', help: 'console.mistral.ai → API Keys' },
];

// Champs administrables : [nom du champ de formulaire, variable d'env, clé en base, secret ?]
const FIELDS = [];
for (const p of PROVIDERS) {
  FIELDS.push([`${p.id}_key`, `${p.env}_API_KEY`, `ai_${p.id}_key`, true]);
  FIELDS.push([`${p.id}_base_url`, `${p.env}_BASE_URL`, `ai_${p.id}_base_url`]);
  FIELDS.push([`${p.id}_model`, `${p.env}_MODEL`, `ai_${p.id}_model`]);
}

function getConfig(dbKey, envKey, fallback = '') {
  if (process.env[envKey]) return process.env[envKey];
  return dbm.getSetting(dbKey) || fallback;
}

function providerConfig(p) {
  return {
    ...p,
    apiKey: getConfig(`ai_${p.id}_key`, `${p.env}_API_KEY`),
    baseUrl: (getConfig(`ai_${p.id}_base_url`, `${p.env}_BASE_URL`, p.base) || p.base).replace(/\/$/, ''),
    model: getConfig(`ai_${p.id}_model`, `${p.env}_MODEL`, p.model) || p.model,
  };
}

// ---------- Santé des fournisseurs (mémoire) ----------
const health = {}; // id -> { ok, fails, lastError, lastOk, lastFail, pausedUntil, calls }
function h(id) { return (health[id] = health[id] || { ok: null, fails: 0, calls: 0 }); }
function markOk(id) { const s = h(id); s.ok = true; s.fails = 0; s.lastOk = Date.now(); s.pausedUntil = 0; s.calls++; }
function markFail(id, err) {
  const s = h(id); s.ok = false; s.fails++; s.lastFail = Date.now(); s.lastError = String(err).slice(0, 200); s.calls++;
  if (s.fails >= 3) s.pausedUntil = Date.now() + 10 * 60 * 1000; // pause 10 min après 3 échecs
}

let eventHandler = null;
function onEvent(fn) { eventHandler = fn; }
function emit(ev) { if (eventHandler) { try { eventHandler(ev); } catch (e) {} } }

// ---------- Appels HTTP ----------
async function requestJson(url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const detail = (json && (json.error && (json.error.message || json.error.type) || json.message)) || text;
    throw new Error(`HTTP ${res.status}${detail ? ' ' + String(detail).slice(0, 160) : ''}`);
  }
  return json;
}

// Un message peut porter des images : { role, content, images: [{ mime, b64 }] }.
function toAnthropic(m) {
  if (!m.images || !m.images.length) return { role: m.role, content: m.content };
  return { role: m.role, content: [
    ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.b64 } })),
    { type: 'text', text: m.content || ' ' },
  ] };
}
function toOpenAI(m) {
  if (!m.images || !m.images.length) return { role: m.role, content: m.content };
  return { role: m.role, content: [
    { type: 'text', text: m.content || ' ' },
    ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } })),
  ] };
}

// messages : [{ role: 'user'|'assistant', content, images? }], system : texte.
async function callProvider(cfg, { system, messages, maxTokens = 700, temperature = 0.6 }) {
  if (cfg.kind === 'anthropic') {
    messages = messages.map(toAnthropic);
    const data = await requestJson(`${cfg.baseUrl}/messages`, {
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: { model: cfg.model, max_tokens: maxTokens, temperature, system: system || undefined, messages },
    });
    const text = (data && Array.isArray(data.content) ? data.content : [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text.trim()) throw new Error('réponse vide');
    return text.trim();
  }
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.id === 'openrouter') { headers['HTTP-Referer'] = process.env.SITE_URL || 'https://lesly-tech-llc.onrender.com'; headers['X-Title'] = 'Lesly Tech LLC'; }
  const data = await requestJson(`${cfg.baseUrl}/chat/completions`, {
    headers,
    body: {
      model: cfg.model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(toOpenAI)],
      max_tokens: maxTokens,
      temperature,
    },
  });
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && (msg.content || msg.reasoning_content);
  if (!text || !String(text).trim()) throw new Error('réponse vide ou invalide');
  return String(text).trim();
}

// Providers génériques ({prompt, lang} -> {text}) et OmniRoute, gardés pour compatibilité.
function extraProviders() {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`AI_PROVIDER_${i}_URL`];
    if (!url) continue;
    const key = process.env[`AI_PROVIDER_${i}_KEY`] || '';
    const model = process.env[`AI_PROVIDER_${i}_MODEL`] || '';
    list.push({
      id: `provider${i}`, name: `Provider ${i}`,
      run: async ({ system, messages }) => {
        const prompt = [system, ...messages.map((m) => `${m.role}: ${m.content}`)].filter(Boolean).join('\n\n');
        const data = await requestJson(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, body: { prompt, ...(model ? { model } : {}) } });
        if (!data || typeof data.text !== 'string' || !data.text.trim()) throw new Error('champ "text" manquant');
        return data.text.trim();
      },
    });
  }
  const omni = (process.env.OMNIROUTE_URL || '').replace(/\/$/, '');
  if (omni) {
    const cfg = { id: 'omniroute', kind: 'openai', baseUrl: omni, apiKey: process.env.OMNIROUTE_API_KEY || '', model: process.env.OMNIROUTE_MODEL || 'auto' };
    list.push({ id: 'omniroute', name: 'OmniRoute', run: (opts) => callProvider(cfg, opts) });
  }
  return list;
}

// Liste ordonnée des fournisseurs utilisables maintenant.
function activeChain(needVision = false) {
  const chain = PROVIDERS.map(providerConfig).filter((c) => c.apiKey && (!needVision || c.vision))
    .map((c) => ({ id: c.id, name: c.name, model: c.model, run: (opts) => callProvider(c, opts) }));
  return needVision ? chain : [...chain, ...extraProviders()];
}

function hasVision() { return activeChain(true).length > 0; }

// chat({ system, messages, maxTokens }) -> { text, provider }
// Essaie chaque fournisseur dans l'ordre ; saute ceux en pause (sauf s'il n'en reste aucun).
async function chat(opts) {
  const needVision = (opts.messages || []).some((m) => m.images && m.images.length);
  const chain = activeChain(needVision);
  if (!chain.length) {
    const err = new Error('IA non configurée — ajoute au moins une clé dans /admin/ai.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const now = Date.now();
  const ready = chain.filter((p) => !(h(p.id).pausedUntil > now));
  const order = ready.length ? ready : chain;
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    try {
      const text = await p.run(opts);
      markOk(p.id);
      if (i > 0) emit({ kind: 'failover', from: order[0].name, to: p.name, error: errors.join(' ; ') });
      return { text, provider: p.name };
    } catch (e) {
      markFail(p.id, e.message);
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  emit({ kind: 'all_failed', errors });
  const err = new Error(`IA indisponible après ${order.length} tentative(s). ${errors.join(' ; ')}`);
  err.code = 'AI_ALL_FAILED';
  throw err;
}

const SYSTEM_BY_LANG = {
  fr: 'Réponds en français.', en: 'Reply in English.', ht: 'Reponn an kreyòl ayisyen.', es: 'Responde en español.',
};

// Compatibilité : description de produit dans une langue.
async function generateDescription(prompt, lang = 'fr') {
  const r = await chat({ system: SYSTEM_BY_LANG[lang] || SYSTEM_BY_LANG.fr, messages: [{ role: 'user', content: prompt }], maxTokens: 400 });
  return r.text;
}

// ---------- Test d'un fournisseur depuis l'admin ----------
function effectiveConfig(providerId, body = {}) {
  const p = PROVIDERS.find((x) => x.id === providerId) || PROVIDERS[0];
  const base = providerConfig(p);
  const MASK = '••••••••';
  const k = String(body[`${p.id}_key`] || '').trim();
  return {
    ...base,
    apiKey: k && k !== MASK ? k : base.apiKey,
    baseUrl: (String(body[`${p.id}_base_url`] || '').trim() || base.baseUrl).replace(/\/$/, ''),
    model: String(body[`${p.id}_model`] || '').trim() || base.model,
  };
}

async function listModels(cfg) {
  const headers = cfg.kind === 'anthropic'
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${cfg.apiKey}` };
  const data = await requestJson(`${cfg.baseUrl}/models`, { method: 'GET', headers });
  const rows = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : (data && Array.isArray(data.models) ? data.models : []));
  return rows.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
}

async function testProvider(providerId, body) {
  const cfg = effectiveConfig(providerId, body);
  if (!cfg.apiKey) return { ok: false, error: 'Clé API manquante', models: [], chatOk: false };
  const started = Date.now();
  let models = [];
  let modelsError = null;
  try { models = await listModels(cfg); } catch (e) { modelsError = e.message; }
  let chatOk = false, chatError = null, sample = '';
  try {
    sample = (await callProvider(cfg, { messages: [{ role: 'user', content: 'Test de connexion. Réponds uniquement : OK.' }], maxTokens: 20 })).slice(0, 120);
    chatOk = true;
    markOk(cfg.id);
  } catch (e) { chatError = e.message; markFail(cfg.id, e.message); }
  const modelKnown = !models.length || models.includes(cfg.model);
  return {
    ok: chatOk, error: chatOk ? null : (chatError || modelsError), models, chatOk, chatError, sample,
    model: cfg.model, modelKnown, latencyMs: Date.now() - started,
  };
}

// État pour l'admin et le rapport quotidien.
function status() {
  const now = Date.now();
  return PROVIDERS.map(providerConfig).map((c, i) => {
    const s = health[c.id] || {};
    return {
      id: c.id, name: c.name, priority: i + 1, configured: !!c.apiKey, model: c.model, help: c.help,
      state: !c.apiKey ? 'absent' : s.pausedUntil > now ? 'pause' : s.ok === false ? 'erreur' : s.ok ? 'ok' : 'inconnu',
      lastError: s.lastError || '', calls: s.calls || 0,
    };
  });
}

module.exports = { PROVIDERS, FIELDS, chat, hasVision, generateDescription, onEvent, testProvider, status };
