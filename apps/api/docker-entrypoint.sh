#!/bin/sh
set -e

echo "[entrypoint] Application des migrations Prisma..."
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

echo "[entrypoint] Migrations a jour, demarrage de l'API."
exec "$@"
