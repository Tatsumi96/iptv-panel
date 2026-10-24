import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';

/**
 * AES-256-GCM sealing of upstream credentials.
 *
 * Wire format (URL-safe base64, dot separated):
 *   v1.<iv>.<authTag>.<ciphertext>
 *
 * GCM gives confidentiality + integrity: a tampered payload fails to
 * authenticate and is rejected instead of returning garbage.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(private readonly appConfig: AppConfigService) {
    this.key = appConfig.encryptionKey;
  }

  seal(plaintext: string): string {
    if (plaintext === '') return '';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  open(ciphertext: string): string {
    if (!ciphertext) return '';
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Format de secret chiffre invalide');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  sealJson(payload: Record<string, unknown>): string {
    return this.seal(JSON.stringify(payload));
  }

  openJson<T extends Record<string, unknown>>(ciphertext: string): T {
    const raw = this.open(ciphertext);
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
  }

  /** Constant-time comparison for tokens/hashes. */
  safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Still burn a comparison to keep the timing profile flat.
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
