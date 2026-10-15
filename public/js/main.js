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
    var STORE = 'ltl-chat-v1';

    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    // Texte échappé, puis liens [texte](/chemin interne ou https://…) et chemins /produit/12 rendus cliquables.
    function render(text) {
      var html = esc(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]{1,120})\]\((\/[\w\-\/?=&.#%]*|https:\/\/[^\s)]+)\)/g, function (m, label, url) {
          var ext = /^https:/.test(url);
          return '<a href="' + url + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
        })
        .replace(/(^|[\s(])(\/(?:produit\/\d+|catalogue|ebooks|contact))(?=[\s).,!?]|$)/g, '$1<a href="$2">$2</a>');
      return html.replace(/\n/g, '<br>');
    }
    function add(role, text, save) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
      div.innerHTML = role === 'user' ? esc(text) : render(text);
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      if (save) {
        try {
          var h = JSON.parse(sessionStorage.getItem(STORE) || '[]'); h.push([role, text]);
          sessionStorage.setItem(STORE, JSON.stringify(h.slice(-30)));
        } catch (e) {}
      }
      return div;
    }
    // Conversation conservée pendant la navigation (même onglet).
    try { JSON.parse(sessionStorage.getItem(STORE) || '[]').forEach(function (m) { add(m[0], m[1], false); }); } catch (e) {}

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      chat.classList.toggle('is-open', open);
      if (open) setTimeout(function () { input.focus(); log.scrollTop = log.scrollHeight; }, 50);
    }
    toggle.addEventListener('click', function () { setOpen(panel.hidden); });
    document.getElementById('chat-close').addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });

    var busy = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      busy = true; input.value = '';
      add('user', text, true);
      var typing = add('bot', note.getAttribute('data-typing'), false);
      typing.classList.add('typing');
      fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, lang: chat.getAttribute('data-lang'), _csrf: chat.getAttribute('data-csrf') }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        typing.remove(); add('bot', d.reply || '…', true);
      }).catch(function () {
        typing.remove(); add('bot', '⚠ Connexion impossible. Réessaie dans un instant.', false);
      }).then(function () { busy = false; input.focus(); });
    });
  }

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
