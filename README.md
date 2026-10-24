# IPTV Home Gateway

IPTV Home Gateway est un monorepo **NestJS 11 + Next.js 15 + PostgreSQL/Prisma + Redis** qui partage un **unique compte upstream** (Xtream Codes ou playlist M3U convertie) vers plusieurs appareils via **tickets à durée limitée**, avec fan-out, limites de connexions, panel admin et protection anti-DDoS.

## Fonctionnalités

- **Source unique** : un seul compte fournisseur (Xtream ou M3U). Les playlists M3U sont normalisées en base et exposées exactement comme un serveur Xtream.
- **Tickets à durée limitée** : `H24`, `D7`, `D30` ou personnalisé, avec `maxConnections`, `overflowPolicy` (`REJECT` / `EVICT_OLDEST`).
- **Limites strictes** : respect du nombre de connexions simultanées du ticket **et** du compte fournisseur (jamais dépassé).
- **Fan-out multiplexer** : plusieurs appareils regardant le même flux partagent **une seule** connexion upstream (économie de connexions).
- **Multi-instance** : relais inter-instances via Redis Pub/Sub avec élection du propriétaire du flux.
- **API compatible IPTV** : `player_api.php`, `get.php` (m3u/m3u_plus), `xmltv.php`, `live/movie/series/...`
- **Panel admin sombre (GitHub-like)** : dashboard, gestion des tickets, fournisseurs, logs, blocage IP.
- **Sécurité** : AES-256-GCM pour les secrets, argon2id pour les mots de passe admin, JWT access + refresh rotatif, rate-limit, blocage IP, headers de sécurité.

## Démarrage rapide

1. **Cloner et configurer**
```bash
cp .env.example .env
# Générer une clé de chiffrement (32 octets base64)
openssl rand -base64 32
```
Renseigner `ENCRYPTION_KEY`, `POSTGRES_*`, `REDIS_*`, `JWT_SECRET`.

2. **Lancer avec Docker Compose**
```bash
npm run docker:up
```
Services : `postgres`, `redis`, `api`, `web`, `nginx`.

3. **Appliquer les migrations et créer un admin**
```bash
cd apps/api
npx prisma migrate deploy
npx prisma db seed  # si seed présent
```
Un utilisateur bootstrap peut être créé via les variables `ADMIN_BOOTSTRAP_*` ou directement en base.

4. **Accéder au panel**
- Web admin : `http://localhost:8080/` (via nginx) ou `http://localhost:3000/`
- API : `http://localhost:4000/health`

## Test avec IPTV Smarters / TiviMate

Dans l'application cliente, utiliser le mode **Xtream Codes API** avec :
- **URL** : `http://VOTRE_IP:8080` (ou votre domaine)
- **Nom d'utilisateur / Mot de passe** : identifiants du **ticket**
- **Port** : laissé vide / 80 selon configuration

L'API répond aux actions standard `player_api.php`.

## Architecture

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour le détail (Redis keys, fan-out, relais, limites).

## Développement

```bash
npm install  # root (workspaces)
npm run prisma:generate
npm run dev:api
npm run dev:web
```

> **Note npm** : si `node_modules` est hoisté, les scripts natifs nécessitent `allowScripts` dans `package.json` (déjà configuré). Sur certaines configurations, exécuter `npm install-scripts approve ...` est nécessaire.
# iptv-panel
