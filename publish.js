// publish.js — « Ajouter » universel : à partir d'un lien et/ou d'une image,
// devine le type de publication, récupère titre / visuel / description de la page,
// puis fait rédiger la description dans les 4 langues par l'IA (si configurée).
const ai = require('./ai');

const TYPES = ['app', 'ebook', 'video', 'image', 'autre'];
const LANGS = ['fr', 'en', 'ht', 'es'];
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML = 600 * 1024;

// ---------- Vidéos : YouTube / TikTok / Vimeo ----------
function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? m[1] : null;
}
function tiktokId(url) {
  const m = String(url).match(/tiktok\.com\/.*\/video\/(\d+)/i);
  return m ? m[1] : null;
}
function vimeoId(url) {
  const m = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  return m ? m[1] : null;
}
// URL du lecteur intégrable pour un lien vidéo, sinon null.
function videoEmbedUrl(url) {
  const yt = youtubeId(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt}`;
  const tt = tiktokId(url);
  if (tt) return `https://www.tiktok.com/embed/v2/${tt}`;
  const vm = vimeoId(url);
  if (vm) return `https://player.vimeo.com/video/${vm}`;
  return null;
}
function firstVideoEmbed(links) {
  for (const l of links || []) {
    const e = videoEmbedUrl(l.url);
    if (e) return e;
  }
  return null;
}

// ---------- Détection du type ----------
function guessType(url, hasImage) {
  const u = String(url || '').toLowerCase();
  if (!u) return hasImage ? 'image' : 'autre';
  if (videoEmbedUrl(u) || /(youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|facebook\.com\/.*\/videos)/.test(u)) return 'video';
  if (/(play\.google\.com|apps\.apple\.com|apkpure|f-droid)/.test(u)) return 'app';
  if (/(payhip\.com|gumroad\.com|amazon\.[a-z.]+\/.*(dp|gp\/product)|books\.google|leanpub|lulu\.com|kobo\.com|\.pdf$|\.epub$)/.test(u)) return 'ebook';
  if (/\.(png|jpe?g|webp|gif)(\?|$)/.test(u)) return 'image';
  return 'autre';
}

// Libellé du bouton de lien selon la plateforme.
function linkLabel(url) {
  const map = [
    [/youtube\.com|youtu\.be/, 'YouTube'], [/tiktok\.com/, 'TikTok'], [/vimeo\.com/, 'Vimeo'],
    [/play\.google\.com/, 'Google Play'], [/apps\.apple\.com/, 'App Store'],
    [/payhip\.com/, 'Payhip'], [/gumroad\.com/, 'Gumroad'], [/amazon\./, 'Amazon'],
    [/leslymgenesis\.com|myshopify\.com/, 'Shopify'], [/facebook\.com/, 'Facebook'], [/instagram\.com/, 'Instagram'],
  ];
  const u = String(url).toLowerCase();
  for (const [re, label] of map) if (re.test(u)) return label;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'Lien'; }
}

// ---------- Métadonnées de la page (oEmbed pour les vidéos, sinon balises Open Graph) ----------
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeslyTechBot/1.0)', 'Accept-Language': 'fr,en;q=0.8', ...(opts.headers || {}) },
    });
  } finally { clearTimeout(timer); }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/\s+/g, ' ').trim();
}
function metaContent(html, names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodeEntities(m[1]);
  }
  return '';
}

async function fetchMeta(url) {
  const out = { title: '', description: '', image: '' };
  if (!/^https?:\/\//i.test(String(url || ''))) return out;
  try {
    // Vidéos : oEmbed officiel (titre + miniature fiables).
    let oembed = null;
    if (youtubeId(url)) oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    else if (/tiktok\.com/i.test(url)) oembed = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    else if (vimeoId(url)) oembed = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    if (oembed) {
      const r = await fetchWithTimeout(oembed);
      if (r.ok) {
        const j = await r.json();
        out.title = decodeEntities(j.title || '');
        out.image = j.thumbnail_url || '';
        out.description = j.author_name ? `Vidéo de ${j.author_name}` : '';
      }
      if (!out.image && youtubeId(url)) out.image = `https://i.ytimg.com/vi/${youtubeId(url)}/hqdefault.jpg`;
      if (out.title) return out;
    }
    // Page web : balises Open Graph / Twitter / <title>.
    const r = await fetchWithTimeout(url, { redirect: 'follow' });
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) return out;
    const html = (await r.text()).slice(0, MAX_HTML);
    out.title = out.title || metaContent(html, ['og:title', 'twitter:title'])
      || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '');
    out.description = metaContent(html, ['og:description', 'twitter:description', 'description']) || out.description;
    let img = out.image || metaContent(html, ['og:image', 'og:image:url', 'twitter:image']);
    if (img) { try { img = new URL(img, r.url || url).href; } catch (e) { img = ''; } }
    out.image = /^https?:\/\//i.test(img) ? img : '';
    // Pages anti-robots (Amazon, Cloudflare…) : titre générique et logo du site, inutilisables.
    if (/^(amazon(\.[a-z.]+)?|just a moment\.*|attention required.*|access denied|robot check)$/i.test(out.title.trim())) {
      out.title = ''; out.description = ''; out.image = '';
    }
    if (/media-amazon\.com\/images\/G\//i.test(out.image)) out.image = '';
  } catch (e) {
    // Lien injoignable : on publie quand même avec ce qu'on a.
  }
  return out;
}

// ---------- Descriptions dans les 4 langues ----------
const TYPE_WORD = { app: 'application', ebook: 'ebook', video: 'vidéo', image: 'image / visuel', autre: 'publication' };

async function describeAllLangs({ title, type, sourceText, notes }) {
  const base = String(notes || sourceText || '').trim();
  const prompt = [
    `Rédige une description courte et engageante (2 phrases, 280 caractères maximum, sans guillemets ni emoji, sans préambule)`,
    `pour une ${TYPE_WORD[type] || 'publication'} publiée par Lesly Tech LLC intitulée « ${title} ».`,
    base ? `Informations disponibles : ${base.slice(0, 1200)}` : '',
    `Réponds uniquement par la description.`,
  ].filter(Boolean).join(' ');

  const results = await Promise.allSettled(LANGS.map((l) => ai.generateDescription(prompt, l)));
  const desc = {};
  let aiUsed = false;
  LANGS.forEach((l, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      desc[l] = r.value.replace(/^["«\s]+|["»\s]+$/g, '').slice(0, 600);
      aiUsed = true;
    } else {
      desc[l] = '';
    }
  });
  // Repli sans IA : description de la page ou notes, en FR (le site retombe sur le FR pour les autres langues).
  if (!desc.fr) desc.fr = base.slice(0, 600);
  return { desc, aiUsed };
}

// Télécharge un visuel distant dans le dossier d'uploads (les miniatures TikTok, par ex., expirent).
// Retourne le nom du fichier enregistré, ou '' en cas d'échec.
async function downloadImage(url, dir) {
  const fs = require('fs');
  const path = require('path');
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  try {
    const r = await fetchWithTimeout(url, { redirect: 'follow' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const ext = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[ct.split(';')[0].trim()];
    if (!r.ok || !ext) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return '';
    const name = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return name;
  } catch (e) { return ''; }
}

// Titre proposé par l'IA à partir des notes (quand la page du lien est illisible, ex. Payhip/Cloudflare).
async function suggestTitle({ type, notes }) {
  if (!String(notes || '').trim()) return '';
  try {
    const t = await ai.generateDescription(
      `Propose un titre court et vendeur (8 mots maximum, sans guillemets, sans préambule) pour une ${TYPE_WORD[type] || 'publication'} ` +
      `de Lesly Tech LLC. Informations : ${String(notes).slice(0, 800)}. Réponds uniquement par le titre.`, 'fr');
    return String(t || '').split('\n')[0].replace(/^["«*\s]+|["»*.\s]+$/g, '').slice(0, 120);
  } catch (e) { return ''; }
}

// Titre lisible tiré d'un nom de fichier (« mon-visuel_final.png » -> « Mon visuel final »).
function titleFromFilename(name) {
  const t = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

module.exports = { TYPES, guessType, linkLabel, fetchMeta, describeAllLangs, suggestTitle, downloadImage, titleFromFilename, videoEmbedUrl, firstVideoEmbed };
