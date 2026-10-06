// csrf.js — middleware CSRF maison, simple.
// Un token aléatoire vit en session ; chaque formulaire POST inclut un champ caché
// "_csrf" ; le middleware compare les deux avant d'autoriser la requête.
const crypto = require('crypto');

function verify(req, res, next) {
  const sent = req.body && req.body._csrf;
  if (!sent || sent !== req.session.csrf) {
    return res.status(403).send('CSRF: jeton invalide ou manquant.');
  }
  next();
}

function middleware(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (req.path === '/api/heartbeat') return next(); // jeton Bearer vérifié dans la route
  if (req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    // Formulaires multipart (upload d'image) : req.body n'existe qu'après multer,
    // la vérification est donc faite dans la route via csrf.verify().
    if (ct.startsWith('multipart/')) return next();
    return verify(req, res, next);
  }
  next();
}

module.exports = { middleware, verify };
