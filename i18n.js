// i18n.js — internationalisation simple via fichiers JSON.
// Langue : cookie "lang" (fr/en/ht/es), repli sur "fr".
const fs = require('fs');
const path = require('path');

const LANGS = ['fr', 'en', 'ht', 'es'];
const DEFAULT_LANG = 'fr';
const dicts = {};

for (const l of LANGS) {
  dicts[l] = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${l}.json`), 'utf8'));
}

// t(dict, key) : "a.b.c" -> valeur, repli FR, sinon la clé elle-même.
function lookup(lang, key) {
  const parts = key.split('.');
  let cur = dicts[lang];
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function middleware(req, res, next) {
  const cookies = parseCookies(req);
  const queryLang = req.query && LANGS.includes(req.query.lang) ? req.query.lang : null;
  const lang = queryLang || (LANGS.includes(cookies.lang) ? cookies.lang : DEFAULT_LANG);
  if (queryLang) {
    res.setHeader('Set-Cookie', `lang=${queryLang}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`);
  }
  req.lang = lang;
  const t = (key) => {
    const v = lookup(lang, key);
    if (v !== undefined) return v;
    const fb = lookup(DEFAULT_LANG, key);
    return fb !== undefined ? fb : key;
  };
  res.locals.t = t;
  res.locals.lang = lang;
  res.locals.langs = LANGS;
  next();
}

// Description d'un produit dans la langue demandée, repli automatique sur le FR.
function descFor(product, lang) {
  return product[`desc_${lang}`] || product.desc_fr || '';
}

module.exports = { middleware, descFor, LANGS, DEFAULT_LANG };
