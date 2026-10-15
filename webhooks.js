// webhooks.js — réception des ventes Payhip, Gumroad et Shopify.
//
// Chaque plateforme appelle une URL secrète du site à chaque achat :
//   /webhooks/payhip?k=SECRET   /webhooks/gumroad?k=SECRET   /webhooks/shopify?k=SECRET
// La vente est enregistrée (table sales) puis notifiée sur tous les canaux
// (e-mail, Telegram, WhatsApp, SMS). Shopify peut aussi être authentifié par HMAC.
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
  };
}

function fromShopify(b) {
  const items = Array.isArray(b.line_items) ? b.line_items : [];
  return {
    platform: 'shopify', external_id: String(b.id || b.name || ''), kind: b.test ? 'test' : 'sale',
    product: items.map((i) => (i.quantity > 1 ? `${i.quantity}× ` : '') + i.title).join(', '),
    amount: Number(b.total_price || 0), currency: String(b.currency || 'USD').toUpperCase(),
    buyer: String(b.email || (b.customer && b.customer.email) || ''),
  };
}

function register(app) {
  const handle = (platform, parse, extraAuth) => async (req, res) => {
    if (!tokenOk(req) && !(extraAuth && extraAuth(req))) return res.status(401).json({ ok: false });
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
  app.post('/webhooks/payhip', handle('payhip', fromPayhip));
  app.post('/webhooks/gumroad', handle('gumroad', fromGumroad));
  app.post('/webhooks/shopify', handle('shopify', fromShopify, shopifyHmacOk));
}

function webhookUrls(siteUrl) {
  const k = webhookSecret();
  return {
    payhip: `${siteUrl}/webhooks/payhip?k=${k}`,
    gumroad: `${siteUrl}/webhooks/gumroad?k=${k}`,
    shopify: `${siteUrl}/webhooks/shopify?k=${k}`,
  };
}

module.exports = { register, webhookUrls, record };
