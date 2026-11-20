import { generateKeyPairSync, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFieldCipher, parseFieldKey } from '../../../src/core/security/fieldCipher.js';
import {
  buildKeySet,
  signAccessToken,
  verifyAccessToken,
  JwtError,
} from '../../../src/core/security/jwt.js';
import { checkPasswordPolicy, createPasswordHasher } from '../../../src/core/security/password.js';
import {
  generateOpaqueToken,
  generateOtp,
  hashToken,
  safeEqualHex,
} from '../../../src/core/security/tokens.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from '../../../src/core/security/totp.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ISS = 'http://localhost:4000';

function keys() {
  return buildKeySet({
    privateKeyPem: undefined,
    publicKeyPem: undefined,
    keyId: 'k1',
    previous: undefined,
  }).keySet;
}

function sign(keySet = keys(), overrides: Partial<{ aud: string; now: Date; ttl: number }> = {}) {
  return signAccessToken(keySet, {
    sub: 'user-1',
    sid: 'sid-1',
    aud: overrides.aud ?? 'admin',
    iss: ISS,
    ttlSeconds: overrides.ttl ?? 900,
    now: overrides.now ?? NOW,
  });
}

describe('jwt (EdDSA, decision C1)', () => {
  it('signs and verifies a token with exact audience and issuer', () => {
    const keySet = keys();
    const token = sign(keySet);
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    const claims = verifyAccessToken(keySet, token, { audience: 'admin', issuer: ISS, now: NOW });
    expect(claims).toMatchObject({
      sub: 'user-1',
      sid: 'sid-1',
      aud: 'admin',
      typ: 'access',
      exp: claims.iat + 900,
    });
  });

  it('rejects the wrong audience (customer token on admin route)', () => {
    const keySet = keys();
    expect(() =>
      verifyAccessToken(keySet, sign(keySet, { aud: 'storefront' }), {
        audience: 'admin',
        issuer: ISS,
        now: NOW,
      }),
    ).toThrow(JwtError);
  });

  it('reports expiry separately (TOKEN_EXPIRED) and honours 30 s skew', () => {
    const keySet = keys();
    const token = sign(keySet);
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    expect(() =>
      verifyAccessToken(keySet, token, { audience: 'admin', issuer: ISS, now: at(925) }),
    ).not.toThrow();
    try {
      verifyAccessToken(keySet, token, { audience: 'admin', issuer: ISS, now: at(1000) });
      expect.unreachable();
    } catch (error) {
      expect((error as JwtError).reason).toBe('EXPIRED');
    }
  });

  it('rejects tokens issued in the future', () => {
    const keySet = keys();
    const token = sign(keySet, { now: new Date(NOW.getTime() + 120_000) });
    expect(() =>
      verifyAccessToken(keySet, token, { audience: 'admin', issuer: ISS, now: NOW }),
    ).toThrow(/future/);
  });

  it('rejects alg=none, HS256 alg confusion, unknown kid and tampered payloads', () => {
    const keySet = keys();
    const token = sign(keySet);
    const [, payload, signature] = token.split('.') as [string, string, string];
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${enc({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${payload}.`;
    expect(() =>
      verifyAccessToken(keySet, none, { audience: 'admin', issuer: ISS, now: NOW }),
    ).toThrow(JwtError);

    const hsHeader = enc({ alg: 'HS256', typ: 'JWT', kid: 'k1' });
    const hsSig = createHmac('sha256', 'public-key-as-secret')
      .update(`${hsHeader}.${payload}`)
      .digest('base64url');
    expect(() =>
      verifyAccessToken(keySet, `${hsHeader}.${payload}.${hsSig}`, {
        audience: 'admin',
        issuer: ISS,
        now: NOW,
      }),
    ).toThrow(JwtError);

    const otherKid = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'k9' })}.${payload}.${signature}`;
    expect(() =>
      verifyAccessToken(keySet, otherKid, { audience: 'admin', issuer: ISS, now: NOW }),
    ).toThrow(/Unknown key/);

    const tampered = enc({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
      sub: 'attacker',
    });
    expect(() =>
      verifyAccessToken(keySet, `${token.split('.')[0] ?? ''}.${tampered}.${signature}`, {
        audience: 'admin',
        issuer: ISS,
        now: NOW,
      }),
    ).toThrow(/signature/);
    expect(() =>
      verifyAccessToken(keySet, 'a.b', { audience: 'admin', issuer: ISS, now: NOW }),
    ).toThrow(JwtError);
  });

  it('a token signed by another key pair fails; previous key remains valid during rotation', () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pem = (k: typeof a.privateKey) =>
      k.export({ format: 'pem', type: k.type === 'private' ? 'pkcs8' : 'spki' }).toString();
    const oldSet = buildKeySet({
      privateKeyPem: pem(a.privateKey),
      publicKeyPem: pem(a.publicKey),
      keyId: 'old',
      previous: undefined,
    }).keySet;
    const newSet = buildKeySet({
      privateKeyPem: pem(b.privateKey),
      publicKeyPem: pem(b.publicKey),
      keyId: 'new',
      previous: { keyId: 'old', publicKeyPem: pem(a.publicKey) },
    });
    expect(newSet.ephemeral).toBe(false);
    const oldToken = sign(oldSet);
    expect(
      verifyAccessToken(newSet.keySet, oldToken, { audience: 'admin', issuer: ISS, now: NOW }).sub,
    ).toBe('user-1');
    expect(() =>
      verifyAccessToken(keys(), oldToken, { audience: 'admin', issuer: ISS, now: NOW }),
    ).toThrow(JwtError);
  });

  it('refuses non-Ed25519 keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      buildKeySet({
        privateKeyPem: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        publicKeyPem: rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        keyId: 'r',
        previous: undefined,
      }),
    ).toThrow(/Ed25519/);
  });
});

describe('opaque tokens', () => {
  it('generates 256-bit base64url tokens and 64-char hashes (peppered = HMAC)', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token, 'pepper')).not.toBe(hashToken(token));
    expect(safeEqualHex(hashToken(token), hashToken(token))).toBe(true);
    expect(safeEqualHex(hashToken(token), hashToken('x'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(generateOtp()).toMatch(/^\d{6}$/);
  });
});

describe('password (Argon2id, decision C3)', () => {
  it('hashes with argon2id PHC format and verifies (real native binding)', async () => {
    const hasher = createPasswordHasher({ memoryKib: 8192, iterations: 1, pepper: 'p' });
    const hash = await hasher.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong horse battery')).resolves.toBe(false);
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(hasher.verifyDummy('x')).resolves.toBeUndefined();
    const stronger = createPasswordHasher({ memoryKib: 19456, iterations: 2, pepper: 'p' });
    expect(stronger.needsRehash(hash)).toBe(true);
  });

  it('enforces the §4.2 policy', () => {
    expect(checkPasswordPolicy('short')).toMatch(/at least 10/);
    expect(checkPasswordPolicy('x'.repeat(129))).toMatch(/at most 128/);
    expect(checkPasswordPolicy('password123')).toMatch(/too common/);
    expect(checkPasswordPolicy('riya-is-great-2026', { email: 'riya@example.com' })).toMatch(
      /name or email/,
    );
    expect(checkPasswordPolicy('correct horse battery', { firstName: 'Riya' })).toBeUndefined();
  });
});

describe('field cipher (AES-256-GCM)', () => {
  it('round-trips and detects tampering', () => {
    const { key, ephemeral } = parseFieldKey(Buffer.alloc(32, 7).toString('base64'));
    expect(ephemeral).toBe(false);
    const cipher = createFieldCipher(key);
    const sealed = cipher.encrypt('JBSWY3DPEHPK3PXP');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(cipher.decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
    expect(() => cipher.decrypt('v2:a:b:c')).toThrow(/Unsupported/);
    expect(() => parseFieldKey('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(parseFieldKey('a'.repeat(64)).key).toHaveLength(32);
    expect(parseFieldKey(undefined).ephemeral).toBe(true);
  });
});

describe('totp (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = Buffer.from('12345678901234567890');
    // T = 59 s → counter 1 → 94287082 (8 digits) → last 6 digits 287082
    expect(hotp(secret, 1, 8)).toBe('94287082');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('verifies within ±1 step and returns the matched step for replay protection', () => {
    const secretB32 = generateTotpSecret();
    const step = totpStep(NOW);
    const code = hotp(base32Decode(secretB32), step - 1);
    expect(verifyTotp(secretB32, code, NOW)).toBe(step - 1);
    expect(verifyTotp(secretB32, hotp(base32Decode(secretB32), step - 3), NOW)).toBeUndefined();
    expect(verifyTotp(secretB32, 'abcdef', NOW)).toBeUndefined();
    expect(() => base32Decode('!!!')).toThrow();
    expect(otpauthUri('Brand Admin', 'a@b.c', secretB32)).toMatch(
      /^otpauth:\/\/totp\/Brand%20Admin%3Aa%40b\.c\?secret=/,
    );
  });
});
