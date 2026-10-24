# Base de données

Le schéma Prisma est dans [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

## Entités principales

| Table | Description |
|-------|-------------|
| `UpstreamProvider` | Compte fournisseur (Xtream ou M3U). Secrets chiffrés par AES-256-GCM. `maxConnections`, `overflowPolicy`. |
| `SyncRun` | Historique des synchronisations catalogue/EPG (statut, compteurs, erreurs). |
| `Category` | Catégories normalisées (live/vod/series). |
| `Channel` | Chaînes live (provenant du fournisseur). |
| `Movie` | Films VOD. |
| `Series` | Séries. |
| `SeriesEpisode` | Épisodes des séries. |
| `EpgEntry` | Programme EPG (XMLTV). |
| `Ticket` | Accès client avec durée, `maxConnections`, `overflowPolicy`, filtre catégories, IP autorisées. |
| `TicketCategory` | Jointure ticket ↔ catégorie autorisée (filtrage). |
| `AdminUser` | Utilisateurs du panel admin (rôles `ADMIN`/`MODERATOR`/`VIEWER`, `mfaEnabled`). |
| `RefreshToken` | Tokens refresh opaques rotatifs (stockés en **hash SHA-256**). |
| `IpBlock` | Blocage IP/CIDR avec raison et expiration. |
| `AuditLog` | Traçabilité des actions admin. |
| `StreamLog` | Historique des sessions de streaming (IP, user-agent, bytes, durée). |
| `AppSetting` | Paramètres globaux dynamiques. |

## Enumérations

- `ProviderKind` : `XTREAM` \| `M3U`
- `SyncStatus` : `PENDING` \| `RUNNING` \| `SUCCEEDED` \| `FAILED`
- `StreamKind` : `LIVE` \| `VOD` \| `SERIES`
- `TicketStatus` : `PENDING` \| `ACTIVE` \| `EXPIRED` \| `SUSPENDED` \| `REVOKED`
- `TicketDurationPreset` : `H24` \| `D7` \| `D30` \| `CUSTOM`
- `OverflowPolicy` : `REJECT` \| `EVICT_OLDEST`
- `AdminRole` : `ADMIN` \| `MODERATOR` \| `VIEWER`
