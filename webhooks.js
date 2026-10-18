// webhooks.js — réception des ventes Payhip, Gumroad et Shopify.
//
// Chaque plateforme appelle le site à chaque achat :
//   /webhooks/payhip   /webhooks/gumroad   /webhooks/shopify
// Chaque vente est VÉRIFIÉE auprès de sa plateforme (aucun secret dans l'URL) :
//   Payhip  : champ « signature » = sha256(clé API Payhip)
//   Gumroad : seller_id du compte + (si jeton fourni) confirmation via l'API Gumroad
//   Shopify : signature HMAC (en-tête X-Shopify-Hmac-Sha256)
// Les anciennes URL avec ?k=SECRET restent acceptées.
// La vente est enregistrée (table sales) puis notifiée sur tous les canaux.
const crypto = require('crypto');
const dbm = require('./db');
const watchdog = require('./watchdog');

function webhookSecret() {
  let s = dbm.getSetting('webhook_secret');
  if (!s) { s = crypto.randomBytes(18).toString('hex'); dbm.setSetting('webhook_secret', s); }
  return s;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function tokenOk(req) { return safeEqual(req.query.k, webhookSecret()); }

const DEFAULT_GUMROAD_SELLER = 'KnlsWUg7XR1Y_R02ilR0MA==';
const cfg = (env, key, dflt = '') => process.env[env] || dbm.getSetting(key) || dflt;

function payhipSignatureOk(req) {
  const key = cfg('PAYHIP_API_KEY', 'payhip_api_key');
  const sig = req.body && req.body.signature;
  if (!key || !sig) return false;
  return safeEqual(crypto.createHash('sha256').update(key).digest('hex'), sig);
}

// Gumroad n'envoie pas de signature : on contrôle le seller_id, et si un jeton d'accès
// Gumroad est configuré, on demande à l'API Gumroad de confirmer que la vente existe.
async function gumroadOk(req) {
  const b = req.body || {};
  if (!safeEqual(b.seller_id, cfg('GUMROAD_SELLER_ID', 'gumroad_seller_id', DEFAULT_GUMROAD_SELLER))) return false;
  const token = cfg('GUMROAD_ACCESS_TOKEN', 'gumroad_access_token');
  if (!token || String(b.test) === 'true') return true;
  try {
    const r = await fetch(`https://api.gumroad.com/v2/sales/${encodeURIComponent(b.sale_id || '')}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    return !!(j && j.success && j.sale && j.sale.id === b.sale_id);
  } catch (e) { return false; }
}

function shopifyHmacOk(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || dbm.getSetting('shopify_webhook_secret');
  const sig = req.get('X-Shopify-Hmac-Sha256');
  if (!secret || !sig || !req.rawBody) return false;
  const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  return safeEqual(digest, sig);
}

const money = (n, cur) => `${Number(n || 0).toFixed(2)} ${cur || 'USD'}`;

async function record(sale) {
  const isNew = dbm.addSale(sale);
  if (!isNew) return false;
  const label = sale.kind === 'refund' ? '↩️ Remboursement' : sale.kind === 'test' ? '🧪 Vente test' : '💰 Nouvelle vente';
  const platform = sale.platform.charAt(0).toUpperCase() + sale.platform.slice(1);
  const lines = [
    `Produit : ${sale.product || '—'}`,
    `Montant : ${money(sale.amount, sale.currency)}`,
    `Plateforme : ${platform}`,
    sale.buyer ? `Client : ${sale.buyer}` : '',
    sale.coupon ? `Code promo utilisé : ${sale.coupon}` : '',
  ].filter(Boolean);
  watchdog.fire('sale', `${label} — ${sale.product || platform}`, lines.join('\n'),
    { short: `${label} : ${sale.product || ''} — ${money(sale.amount, sale.currency)} (${platform})` }).catch(() => {});
  return true;
}

// ---------- Normalisation par plateforme ----------
function fromPayhip(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  const kind = /refund/i.test(b.type || '') ? 'refund' : 'sale';
  return {
    platform: 'payhip', external_id: String(b.id || b.transaction_id || ''), kind,
    product: items.map((i) => i.product_name).filter(Boolean).join(', ') || String(b.product_name || ''),
    amount: Number(b.price || b.amount || 0), currency: String(b.currency || 'USD').toUpperCase(),
    buyer: String(b.email || ''),
    coupon: String(b.coupon_code || b.coupon || (items[0] && (items[0].coupon_code || items[0].coupon)) || '').toUpperCase(),
  };
}

function fromGumroad(b) {
  const test = String(b.test) === 'true';
  const refunded = String(b.refunded) === 'true';
  return {
    platform: 'gumroad', external_id: String(b.sale_id || b.order_number || ''),
    kind: test ? 'test' : refunded ? 'refund' : 'sale',
    product: String(b.product_name || ''),
    amount: Number(b.price || 0) / 100, currency: String(b.currency || 'usd').toUpperCase(),
    buyer: String(b.email || ''),
    coupon: String(b.offer_code || '').toUpperCase(),
  };
}

function fromShopify(b) {
  const items = Array.isArray(b.line_items) ? b.line_items : [];
  return {
    platform: 'shopify', external_id: String(b.id || b.name || ''), kind: b.test ? 'test' : 'sale',
    product: items.map((i) => (i.quantity > 1 ? `${i.quantity}× ` : '') + i.title).join(', '),
    amount: Number(b.total_price || 0), currency: String(b.currency || 'USD').toUpperCase(),
    buyer: String(b.email || (b.customer && b.customer.email) || ''),
    coupon: (Array.isArray(b.discount_codes) ? b.discount_codes.map((d) => d.code) : []).join(', ').toUpperCase(),
  };
}

function register(app) {
  const handle = (platform, parse, extraAuth) => async (req, res) => {
    if (!tokenOk(req) && !(extraAuth && await extraAuth(req))) return res.status(401).json({ ok: false });
    try {
      const sale = parse(req.body || {});
      if (!sale.external_id) sale.external_id = crypto.createHash('sha1').update(JSON.stringify(req.body || {})).digest('hex');
      await record(sale);
      res.json({ ok: true });
    } catch (e) {
      dbm.logError(`webhook ${platform} : ${e.message}`);
      res.status(500).json({ ok: false });
    }
  };
  app.post('/webhooks/payhip', handle('payhip', fromPayhip, payhipSignatureOk));
  app.post('/webhooks/gumroad', handle('gumroad', fromGumroad, gumroadOk));
  app.post('/webhooks/shopify', handle('shopify', fromShopify, shopifyHmacOk));
}

function webhookUrls(siteUrl) {
  return {
    payhip: `${siteUrl}/webhooks/payhip`,
    gumroad: `${siteUrl}/webhooks/gumroad`,
    shopify: `${siteUrl}/webhooks/shopify`,
  };
}

// État de la vérification, pour la page admin.
function verification() {
  return {
    payhip: !!cfg('PAYHIP_API_KEY', 'payhip_api_key'),
    gumroadToken: !!cfg('GUMROAD_ACCESS_TOKEN', 'gumroad_access_token'),
    gumroadSeller: cfg('GUMROAD_SELLER_ID', 'gumroad_seller_id', DEFAULT_GUMROAD_SELLER),
    shopify: !!(process.env.SHOPIFY_WEBHOOK_SECRET || dbm.getSetting('shopify_webhook_secret')),
  };
}

module.exports = { register, webhookUrls, verification, record };
