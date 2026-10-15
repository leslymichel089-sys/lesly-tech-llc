// session-store.js — store express-session persistant dans SQLite (sans dépendance).
// Remplace le MemoryStore par défaut : les sessions survivent aux redémarrages
// et la mémoire du serveur ne grossit plus avec le nombre de visiteurs.
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db, { ttlMs = 12 * 3600 * 1000, purgeEveryMs = 3600 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.qGet = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.qSet = db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`);
    this.qTouch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.qDestroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.qPurge = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.purge();
    const timer = setInterval(() => this.purge(), purgeEveryMs);
    if (timer.unref) timer.unref();
  }

  expiresOf(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }

  purge() {
    try { this.qPurge.run(Date.now()); } catch (e) { console.error('[sessions] purge :', e.message); }
  }

  get(sid, cb) {
    try {
      const row = this.qGet.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try { this.qSet.run(sid, JSON.stringify(sess), this.expiresOf(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try { this.qTouch.run(this.expiresOf(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this.qDestroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
