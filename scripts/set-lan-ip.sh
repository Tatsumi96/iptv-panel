#!/usr/bin/env bash
# Updates the LAN address of the gateway.
#
# The server address changes with the network (DHCP, WiFi switch). The panel
# follows the IP automatically (same origin), but the URLs published in the
# M3U playlists and in the tickets are built from PUBLIC_BASE_URL: they must
# be regenerated, otherwise the clients receive unreachable links.
#
# Usage: ./scripts/set-lan-ip.sh [ip]      (no argument = auto detection)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

detect_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true
}

IP="${1:-$(detect_ip)}"

if [[ -z "$IP" ]]; then
  echo "Impossible de detecter l'adresse IP. Usage: $0 <ip>" >&2
  exit 1
fi

PORT="$(grep -E '^NGINX_HTTP_PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
PORT="${PORT:-8080}"
BASE_URL="http://${IP}:${PORT}"

echo "Nouvelle adresse publique : $BASE_URL"

if grep -qE '^PUBLIC_BASE_URL=' "$ENV_FILE"; then
  sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${BASE_URL}|" "$ENV_FILE"
else
  printf '\nPUBLIC_BASE_URL=%s\n' "$BASE_URL" >> "$ENV_FILE"
fi

# The CORS patterns cover the private networks, nothing to do here.

cd "$ROOT"

echo "Recreation du conteneur API (PUBLIC_BASE_URL est lu au demarrage)..."
docker compose up -d --no-deps --force-recreate api

echo "Attente du demarrage de l'API..."
for _ in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ""
echo "Panel   : ${BASE_URL}/"
echo "M3U     : ${BASE_URL}/get.php?username=<ticket>&password=<mdp>&type=m3u_plus&output=ts"
echo ""
echo "Les tickets et les URL de flux utilisent des liens deja enregistres :"
echo "  - regenerer le ticket (nouveau mot de passe) pour obtenir des liens a jour ;"
echo "  - ou mettre a jour l'URL dans les playlists des apps clientes."
