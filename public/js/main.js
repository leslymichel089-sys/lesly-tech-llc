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
