// main.js — petit JS client : sélecteur de thème, bouton partager, assistant IA (admin).
(function () {
  'use strict';
  var root = document.documentElement;

  // --- Sélecteur de thème : mémorisé en localStorage, appliqué à tout le site ---
  var themeSelect = document.getElementById('theme-select');
  var current = root.getAttribute('data-theme') || 'clair';
  if (themeSelect) {
    themeSelect.value = current;
    themeSelect.addEventListener('change', function () {
      root.setAttribute('data-theme', themeSelect.value);
      try { localStorage.setItem('ltl-theme', themeSelect.value); } catch (e) {}
    });
  }

  // --- Menu mobile : ouvrable au clavier (Entrée / Espace) ---
  var burger = document.querySelector('.nav-burger');
  var navToggle = document.getElementById('nav-toggle');
  if (burger && navToggle) {
    burger.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navToggle.checked = !navToggle.checked; }
    });
  }

  // --- Bouton « Partager le lien » (admin) ---
  var shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var url = shareBtn.getAttribute('data-url');
      function done() { alert(shareBtn.getAttribute('data-copied') || 'OK'); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  }

  // --- Assistant IA du formulaire produit (admin) ---
  var aiBtn = document.getElementById('ai-generate');
  if (aiBtn) {
    aiBtn.addEventListener('click', function () {
      var prompt = document.getElementById('ai-prompt').value;
      var lang = document.getElementById('ai-lang').value;
      var status = document.getElementById('ai-status');
      status.textContent = aiBtn.getAttribute('data-working');
      fetch('/admin/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, lang: lang, _csrf: aiBtn.getAttribute('data-csrf') }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            var area = document.getElementById('desc-' + lang);
            if (area) area.value = data.text;
            status.textContent = '';
          } else {
            status.textContent = aiBtn.getAttribute('data-errprefix') + data.error;
          }
        })
        .catch(function (e) {
          status.textContent = aiBtn.getAttribute('data-errprefix') + e.message;
        });
    });
  }
  // --- Admin : bouton « Ajouter / Enlever » (explorateur Windows) + masquer / enlever ---
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  if (csrfMeta) {
    var csrf = csrfMeta.getAttribute('content');
    var filesInput = document.getElementById('files-input');
    var overlay = document.getElementById('upload-overlay');
    var KINDS = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|m4a|ogg|pdf|epub|docx?|xlsx|pptx|txt|zip)$/i;
    var FREE_DOWNLOAD = /\.(pdf|epub|docx?|xlsx|pptx|txt|zip)$/i;

    function uploadFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var refused = files.filter(function (f) { return !KINDS.test(f.name); });
      files = files.filter(function (f) { return KINDS.test(f.name); });
      if (refused.length) alert('Fichiers ignorés (type non accepté) :\n' + refused.map(function (f) { return f.name; }).join('\n'));
      var tooBig = files.filter(function (f) { return f.size > 80 * 1024 * 1024; });
      if (tooBig.length) { alert('Trop lourd (80 Mo max) :\n' + tooBig.map(function (f) { return f.name; }).join('\n')); return; }
      if (!files.length) return;
      var docs = files.filter(function (f) { return FREE_DOWNLOAD.test(f.name); });
      if (docs.length && !confirm('Attention : ces fichiers seront TÉLÉCHARGEABLES GRATUITEMENT par tous les visiteurs :\n\n' +
          docs.map(function (f) { return '• ' + f.name; }).join('\n') +
          '\n\nPour un ebook payant, préfère un lien de vente (Payhip, Gumroad…). Continuer ?')) return;

      var fd = new FormData();
      fd.append('_csrf', csrf);
      files.forEach(function (f) { fd.append('files', f); });
      var bar = document.getElementById('upload-bar');
      var detail = document.getElementById('upload-detail');
      document.getElementById('upload-title').textContent = 'Envoi de ' + files.length + ' fichier(s)…';
      detail.textContent = files.map(function (f) { return f.name; }).join(', ');
      bar.style.width = '0%';
      overlay.hidden = false;

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/fichiers/upload');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (data.ok) {
          document.getElementById('upload-title').textContent = '✔ ' + data.created.length + ' publication(s) en ligne';
          detail.textContent = data.created.map(function (c) { return c.title; }).join(', ') + ' — la description en 4 langues arrive dans quelques secondes.';
          setTimeout(function () { location.reload(); }, 1600);
        } else {
          overlay.hidden = true;
          alert('Échec : ' + (data.error || ('erreur ' + xhr.status)));
        }
      };
      xhr.onerror = function () { overlay.hidden = true; alert('Échec de l\'envoi (connexion).'); };
      xhr.send(fd);
    }

    // Tout bouton [data-files-pick] ouvre l'explorateur Windows.
    document.querySelectorAll('[data-files-pick]').forEach(function (b) {
      b.addEventListener('click', function () { filesInput.value = ''; filesInput.click(); });
    });
    if (filesInput) filesInput.addEventListener('change', function () { uploadFiles(filesInput.files); });

    // Glisser-déposer des fichiers n'importe où sur la page.
    document.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
        e.preventDefault(); document.body.classList.add('drop-ready');
      }
    });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('drop-ready'); });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      // Les zones de dépôt des formulaires gardent leur propre comportement.
      if (e.target.closest && e.target.closest('.dropzone')) return;
      e.preventDefault(); document.body.classList.remove('drop-ready');
      uploadFiles(e.dataTransfer.files);
    });

    function postJson(url) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: csrf }) })
        .then(function (r) { return r.json(); });
    }
    document.querySelectorAll('[data-toggle-visible]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        postJson('/admin/fichiers/' + b.getAttribute('data-toggle-visible') + '/visible').then(function (d) {
          if (d.ok) location.reload(); else alert('Échec : ' + (d.error || ''));
        });
      });
    });
    document.querySelectorAll('[data-remove]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        if (!confirm('Enlever définitivement « ' + b.getAttribute('data-title') + ' » du site ?\n\n(Pour la cacher sans la perdre, utilise plutôt « Masquer ».)')) return;
        postJson('/admin/fichiers/' + b.getAttribute('data-remove') + '/remove').then(function (d) {
          if (d.ok) location.reload(); else alert('Échec : ' + (d.error || ''));
        });
      });
    });
  }

  // --- Assistant IA des visiteurs (bulle de discussion) ---
  var chat = document.getElementById('chat-widget');
  if (chat) {
    var panel = document.getElementById('chat-panel');
    var toggle = document.getElementById('chat-toggle');
    var log = document.getElementById('chat-log');
    var form = document.getElementById('chat-form');
    var input = document.getElementById('chat-input');
    var note = chat.querySelector('.chat-note');
    var downBtn = document.getElementById('chat-down');
    var fileInput = document.getElementById('chat-file');
    var filesBox = document.getElementById('chat-files');
    var COPY = chat.getAttribute('data-copy'), COPIED = chat.getAttribute('data-copied');
    var STORE = 'ltl-chat-v1';
    var pending = []; // fichiers à envoyer avec le prochain message

    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    // Texte échappé, puis liens [texte](/chemin interne ou https://…) et chemins /produit/12 rendus cliquables.
    function render(text) {
      var html = esc(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]{1,120})\]\((\/[\w\-\/?=&.#%]*|https:\/\/[^\s)]+)\)/g, function (m, label, url) {
          var ext = /^https:/.test(url);
          return '<a href="' + url + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
        })
        .replace(/(^|[\s(])(\/(?:produit\/\d+|catalogue|ebooks|contact|conditions))(?=[\s).,!?]|$)/g, '$1<a href="$2">$2</a>');
      return html.replace(/\n/g, '<br>');
    }

    function copyText(text, btn) {
      function done() { if (btn) { var o = btn.textContent; btn.textContent = '✔'; btn.title = COPIED; setTimeout(function () { btn.textContent = o; btn.title = COPY; }, 1400); } }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    }

    function add(role, text, save) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
      var body = document.createElement('div');
      body.className = 'chat-text';
      body.innerHTML = role === 'user' ? esc(text).replace(/\n/g, '<br>') : render(text);
      div.appendChild(body);
      // Carré de copie rapide (copie totale du message) ; la sélection à la souris reste possible (copie partielle).
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'chat-copy'; c.textContent = '⧉'; c.title = COPY; c.setAttribute('aria-label', COPY);
      c.addEventListener('click', function () { copyText(body.innerText, c); });
      div.appendChild(c);
      div.setAttribute('data-raw', text);
      log.appendChild(div);
      scrollDown();
      if (save) {
        try {
          var h = JSON.parse(sessionStorage.getItem(STORE) || '[]'); h.push([role, text]);
          sessionStorage.setItem(STORE, JSON.stringify(h.slice(-30)));
        } catch (e) {}
      }
      return div;
    }

    // Flèche « aller en bas » : visible dès qu'on remonte dans la conversation.
    function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
    function scrollDown() { log.scrollTop = log.scrollHeight; downBtn.hidden = true; }
    log.addEventListener('scroll', function () { downBtn.hidden = atBottom(); });
    downBtn.addEventListener('click', function () { log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); });

    document.getElementById('chat-copy-all').addEventListener('click', function () {
      var all = Array.prototype.map.call(log.querySelectorAll('.chat-msg:not(.typing)'), function (m) {
        return (m.classList.contains('user') ? '👤 ' : '🤖 ') + m.querySelector('.chat-text').innerText;
      }).join('\n\n');
      copyText(all, this);
    });

    // Conversation conservée pendant la navigation (même onglet). Le message d'accueil reçoit aussi le carré de copie.
    (function initGreeting() {
      var g = log.querySelector('.chat-msg.bot');
      if (g && !g.querySelector('.chat-text')) { var t = g.textContent; g.textContent = ''; log.removeChild(g); add('bot', t, false); }
    })();
    try { JSON.parse(sessionStorage.getItem(STORE) || '[]').forEach(function (m) { add(m[0], m[1], false); }); } catch (e) {}

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      chat.classList.toggle('is-open', open);
      if (open) setTimeout(function () { input.focus(); scrollDown(); }, 50);
    }
    toggle.addEventListener('click', function () { setOpen(panel.hidden); });
    document.getElementById('chat-close').addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });

    // ---- Trombone : joindre / coller / déposer des fichiers ----
    var OK_FILE = /\.(png|jpe?g|webp|gif|pdf|docx?|txt|md|csv|json)$/i;
    function addFiles(list) {
      Array.prototype.forEach.call(list || [], function (f) {
        var name = f.name || ('image-collee-' + Date.now() + '.png');
        if (!OK_FILE.test(name) && !/^image\//.test(f.type)) return;
        if (f.size > 5 * 1024 * 1024 || pending.length >= 3) return;
        if (!f.name) f = new File([f], name, { type: f.type || 'image/png' });
        pending.push(f);
      });
      drawFiles();
    }
    function drawFiles() {
      filesBox.innerHTML = '';
      filesBox.hidden = !pending.length;
      pending.forEach(function (f, i) {
        var chip = document.createElement('span');
        chip.className = 'chat-chip';
        chip.textContent = '📎 ' + f.name;
        var x = document.createElement('button');
        x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Retirer');
        x.addEventListener('click', function () { pending.splice(i, 1); drawFiles(); });
        chip.appendChild(x);
        filesBox.appendChild(chip);
      });
    }
    document.getElementById('chat-clip').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', function () { addFiles(fileInput.files); input.focus(); });
    input.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length) { e.preventDefault(); addFiles(items); }
    });
    panel.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); panel.classList.add('drop'); });
    panel.addEventListener('dragleave', function () { panel.classList.remove('drop'); });
    panel.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); panel.classList.remove('drop');
      if (e.dataTransfer) addFiles(e.dataTransfer.files);
    });

    // Champ multi-lignes : Entrée envoie, Maj+Entrée va à la ligne ; hauteur automatique.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });

    var busy = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if ((!text && !pending.length) || busy) return;
      busy = true; input.value = ''; input.style.height = 'auto';
      var shown = text + (pending.length ? (text ? '\n' : '') + pending.map(function (f) { return '📎 ' + f.name; }).join('\n') : '');
      add('user', shown, true);
      var typing = add('bot', note.getAttribute('data-typing'), false);
      typing.classList.add('typing');
      var req;
      if (pending.length) {
        var fd = new FormData();
        fd.append('message', text); fd.append('lang', chat.getAttribute('data-lang')); fd.append('_csrf', chat.getAttribute('data-csrf'));
        pending.forEach(function (f) { fd.append('files', f); });
        req = fetch('/api/chat', { method: 'POST', body: fd });
      } else {
        req = fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, lang: chat.getAttribute('data-lang'), _csrf: chat.getAttribute('data-csrf') }),
        });
      }
      pending = []; drawFiles();
      req.then(function (r) { return r.json(); }).then(function (d) {
        typing.remove(); add('bot', d.reply || '…', true);
      }).catch(function () {
        typing.remove(); add('bot', '⚠ Connexion impossible. Réessaie dans un instant.', false);
      }).then(function () { busy = false; input.focus(); });
    });
  }

  // --- Connexion Google facultative (accès libre toujours possible) ---
  var authModal = document.getElementById('auth-modal');
  if (authModal) {
    var CHOICE = 'ltl-auth-choice';
    var googleReady = false;
    function openAuth() {
      authModal.hidden = false;
      renderGoogle();
    }
    function closeAuth(remember) {
      authModal.hidden = true;
      if (remember) { try { localStorage.setItem(CHOICE, 'anon'); } catch (e) {} }
    }
    function renderGoogle() {
      if (googleReady || !(window.google && google.accounts && google.accounts.id)) return;
      googleReady = true;
      google.accounts.id.initialize({
        client_id: authModal.getAttribute('data-client-id'),
        callback: function (resp) {
          fetch('/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: resp.credential, consent: document.getElementById('auth-consent').checked, _csrf: authModal.getAttribute('data-csrf') }),
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (d.ok) { try { localStorage.setItem(CHOICE, 'google'); } catch (e) {} location.reload(); }
            else alert(authModal.getAttribute('data-error') + (d.error ? '\n(' + d.error + ')' : ''));
          }).catch(function () { alert(authModal.getAttribute('data-error')); });
        },
      });
      google.accounts.id.renderButton(document.getElementById('google-btn'),
        { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280, locale: document.documentElement.lang || 'fr' });
    }
    // Le script Google se charge en différé : on réessaie quelques fois.
    var tries = 0;
    var wait = setInterval(function () { tries++; if (!authModal.hidden) renderGoogle(); if (googleReady || tries > 40) clearInterval(wait); }, 250);

    document.querySelectorAll('[data-auth-open]').forEach(function (b) { b.addEventListener('click', openAuth); });
    authModal.querySelectorAll('[data-auth-anon]').forEach(function (b) { b.addEventListener('click', function () { closeAuth(true); }); });
    authModal.addEventListener('click', function (e) { if (e.target === authModal) closeAuth(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !authModal.hidden) closeAuth(true); });

    // Première visite : on propose le choix une seule fois, sans jamais bloquer l'accès.
    var choice = null;
    try { choice = localStorage.getItem(CHOICE); } catch (e) {}
    if (!choice) setTimeout(openAuth, 2500);
  }
  document.querySelectorAll('[data-auth-logout]').forEach(function (b) {
    b.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: b.getAttribute('data-csrf') }) })
        .then(function () { try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {} location.reload(); });
    });
  });

  // --- Apparition au scroll ---
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }
})();
