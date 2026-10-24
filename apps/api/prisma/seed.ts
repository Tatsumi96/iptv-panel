import { PrismaClient, AdminRole, ProviderKind, OverflowPolicy, TicketStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { createCipheriv, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Mirrors CryptoService.sealJson: decryptable by the API at runtime.
 * The key must be the same 32-byte base64 ENCRYPTION_KEY used by the server.
 */
function sealJson(payload: Record<string, string>, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? 'admin@iptv.local').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash: await argon2.hash(password, ARGON2_OPTIONS),
      displayName: process.env.ADMIN_DISPLAY_NAME ?? 'Administrateur',
      role: AdminRole.ADMIN,
      isActive: true,
    },
  });
  console.log(`Administrateur pret: ${admin.email}`);

  const providerCount = await prisma.upstreamProvider.count();
  if (providerCount === 0) {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    const provider = await prisma.upstreamProvider.create({
      data: {
        name: 'Compte principal',
        kind: ProviderKind.XTREAM,
        baseUrl: 'http://example.com:8080',
        secretsEnc: encryptionKey
          ? sealJson({ username: 'demo', password: 'demo' }, encryptionKey)
          : null,
        maxConnections: 2,
        overflowPolicy: OverflowPolicy.REJECT,
        isEnabled: true,
        refreshIntervalSec: 3600,
      },
    });
    console.log(`Fournisseur de demonstration cree: ${provider.id}`);

    await prisma.ticket.create({
      data: {
        label: 'Salon',
        username: 'salon',
        password: 'salon123',
        providerId: provider.id,
        status: TicketStatus.ACTIVE,
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        maxConnections: 1,
        overflowPolicy: OverflowPolicy.REJECT,
      },
    });
    console.log('Ticket de demonstration cree: salon / salon123');
  }

  console.log('Seed termine.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
