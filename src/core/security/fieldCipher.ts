/**
 * Field-level encryption at rest (AES-256-GCM) — used for `users.mfa_secret_encrypted`
 * (AUTHENTICATION_AUTHORIZATION.md §13, `FIELD_ENCRYPTION_KEY`).
 *
 * Format: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>` (fits VARCHAR(255) for TOTP secrets).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface FieldCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

export function parseFieldKey(value: string | undefined): { key: Buffer; ephemeral: boolean } {
  if (value === undefined) return { key: randomBytes(32), ephemeral: true };
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex chars).');
  }
  return { key, ephemeral: false };
}

export function createFieldCipher(key: Buffer): FieldCipher {
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv, tag, ciphertext]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join(':');
    },
    decrypt(payload) {
      const [version, iv, tag, ciphertext] = payload.split(':');
      if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined) {
        throw new Error('Unsupported encrypted field format.');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
