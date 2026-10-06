# Lesly Tech LLC — Site officiel (v2)

Site vitrine officiel de **Lesly Tech LLC** : applications IA, ebooks via
**Les Éditions LeVent**, et autres créations.

## Lancement (Windows)

1. Installez [Node.js](https://nodejs.org/) si besoin.
2. Double-cliquez sur **`DEMARRER.bat`**.
3. Ouvrez **http://localhost:3000** — admin : **http://localhost:3000/admin**.

Au premier lancement de l'admin, **vous définissez votre code secret**
(aucun code par défaut, hashé en bcrypt).

En ligne de commande : `npm install && npm start`.

## Fonctionnalités

- **4 langues** (FR/EN/HT/ES) : sélecteur qui traduit tout le site instantanément.
- **5 thèmes** (clair chaleureux par défaut, ambre, émeraude, nuit, sombre), mémorisés.
- **Catalogue** : fiches produits avec vraies couvertures, filtres, liens d'achat comptés.
- **Les Éditions LeVent** : section dédiée aux ebooks.
- **Pages légales** : confidentialité + propriété intellectuelle numérique.
- **Admin** : activer/désactiver le site, témoin en ligne, **panel graphique live**
  (visites, clics, activité récente, refresh auto 15 s), ajout/retrait de produits
  en un clic, badge « mise à jour disponible », bouton partager le lien.
- **Watchdog + notifications** : e-mail (SMTP), WhatsApp, Telegram, toast Windows —
  envoi parallèle avec retry, alertes réglables (`/admin/notifications`).
- **IA via OmniRoute** : bouton « Générer la description » dans l'admin.
  Lancez `omniroute.ps1` sur le PC (http://localhost:20128/v1, modèle `auto`) :
  OmniRoute fait lui-même la bascule entre 352 providers. Voir `.env.example`.

## Avant la mise en ligne

1. Remplacez `SESSION_SECRET` dans `.env` par une longue chaîne aléatoire.
2. Configurez les canaux de notification (voir `/admin/notifications`).
3. **Vercel est exclu** (demande du propriétaire). Hébergeurs possibles :
   Cloudflare, Netlify (avec adaptateur Node), Render, ou VPS (Nginx + PM2).

© 2026 Lesly Tech LLC — Tous droits réservés.
