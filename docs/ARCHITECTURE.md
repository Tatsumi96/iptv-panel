# Architecture

## Vue d'ensemble

IPTV Home Gateway agit comme un **reverse proxy intelligent** entre les clients IPTV et le compte fournisseur unique. Il normalise un fournisseur Xtream ou M3U, applique des **tickets** et des **limites de connexions**, et mutualise les flux via un **multiplexeur fan-out**.

## Composants

| Composant | Rôle |
|-----------|------|
| **NestJS API** | Endpoints Xtream (`player_api.php`, `get.php`, `xmltv.php`), panel admin, streaming, scheduler |
| **Next.js Web** | Panel d'administration (shadcn/ui, GitHub-dark) |
| **PostgreSQL + Prisma** | Catalogue normalisé, tickets, utilisateurs admin, logs |
| **Redis** | Registre de connexions, compteurs atomiques, Pub/Sub inter-instances, rate-limit |
| **nginx** | Reverse proxy, `limit_req`/`limit_conn`, buffering off pour le streaming |

## Registre Redis (source de vérité)

| Clé | Type | Description |
|-----|------|-------------|
| `sess:t:{ticketId}` | Set | Sessions actives d'un ticket |
| `sess:p:{providerId}` | Set | Sessions globales par fournisseur |
| `sess:all` | Set | Ensemble des sessions |
| `sess:count:{ticketId}` | String (INCR/EXPIRE) | Compteur atomique du ticket |
| `feed:p:{providerId}` | Set | Flux upstream actifs par fournisseur |
| `feed:count:{providerId}` | String | Compteur atomique upstream |
| `feed:owner:{feedKey}` | String | Instance propriétaire du flux (PX 15s) |
| `relay:{feedKey}` | Pub/Sub | Relais de données inter-instances |
| `feed:control` | Pub/Sub | Commandes (`kill-feed`, `evict-client`) |

## Limites de connexions

- **Ticket** : `Ticket.maxConnections` (défaut 1). `OverflowPolicy.REJECT` refuse, `OverflowPolicy.EVICT_OLDEST` ferme la plus ancienne session.
- **Fournisseur** : `UpstreamProvider.maxConnections`. Jamais dépassé. Si `EVICT_OLDEST`, ferme le plus ancien flux upstream pour en libérer un slot.
- **Réservation atomique** : `ConnectionRegistryService` utilise des scripts **Lua** pour INCR/DECR atomiques et éviter les dépassements.

## Fan-out & multi-instance

1. **Premier client** sur un flux → devient propriétaire, ouvre la connexion upstream via `StreamHubService`.
2. **Clients suivants** sur le même flux → attachés au même feed (aucune nouvelle connexion upstream).
3. **Multi-instance** : si le propriétaire meurt, un autre instance peut revendiquer `feed:owner:{feedKey}` et relayer via `relay:{feedKey}`. Canal `feed:control` pour tuer un flux/éjecter un client.

## Conversion M3U → Xtream

`M3uAdapter` parse `#EXTM3U` avec attributs `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`. `ContentService` normalise dans `Channel`, `Movie`, `Series` (upserts par chunks). Les endpoints `player_api.php`, `get.php`, `xmltv.php` servent depuis la BDD, offrant une **surface Xtream exactement identique** quelle que soit la source.

## Sécurité

- **Chiffrement** : `CryptoService` AES-256-GCM, format `v1.<iv>.<authTag>.<ciphertext>` (base64url). Clé dans `ENCRYPTION_KEY`.
- **Auth admin** : argon2id, JWT access (courte durée), refresh token opaque rotatif haché **SHA-256**, verrouillage après échec.
- **Streaming auth** : `TicketAuthGuard` vérifie le ticket, filtre par catégorie, vérifie IP si `allowedIps`.
- **Anti-DDoS** : nginx `limit_req_zone`, `limit_conn_zone`, proxy buffering off.
- **Blocage IP** : `IpBlockService` avec règles CIDR, appliquées par middleware/guard.
- `express.d.ts` étend `Request` avec `ticket`, `admin`, `streamId`.
