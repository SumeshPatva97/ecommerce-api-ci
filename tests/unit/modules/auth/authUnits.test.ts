/**
 * Unit tests for auth helpers (pure / in-memory; no DB): mappers, CAPTCHA thresholds, MFA service,
 * schemas.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createFieldCipher } from '../../../../src/core/security/fieldCipher.js';
import { base32Decode, hotp, totpStep } from '../../../../src/core/security/totp.js';
import { createMemoryStore } from '../../../../src/core/store/memoryStore.js';
import { createMfaService, MFA_MAX_FAILURES } from '../../../../src/modules/admin-auth/mfa.js';
import { isMfaMandatory } from '../../../../src/modules/admin-auth/admin-auth.service.js';
import { MfaVerifyBody } from '../../../../src/modules/admin-auth/admin-auth.schemas.js';
import { deviceLabel, maskIp, toSessionDto } from '../../../../src/modules/auth/auth.mapper.js';
import { LoginBody, OtpSendBody, RegisterBody } from '../../../../src/modules/auth/auth.schemas.js';
import {
  CAPTCHA_IP_THRESHOLD,
  createCaptchaPolicy,
  noopCaptchaVerifier,
  type CaptchaVerifier,
} from '../../../../src/modules/auth/captcha.js';

describe('auth mappers', () => {
  it('masks IPv4 / IPv6 addresses', () => {
    expect(maskIp('49.36.120.7')).toBe('49.36.***.***');
    expect(maskIp('::ffff:127.0.0.1')).toBe('127.0.***.***');
    expect(maskIp('2401:4900:1c20:abcd::1')).toBe('2401:4900:****');
    expect(maskIp(null)).toBeNull();
  });

  it('derives a device label from the user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36')).toBe(
      'Chrome on Android',
    );
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130.0')).toBe(
      'Edge on Windows',
    );
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/131.0')).toBe(
      'Firefox on macOS',
    );
    expect(deviceLabel('curl/8.0')).toBe('Unknown device');
    expect(deviceLabel(undefined)).toBe('Unknown device');
  });

  it('maps a session row without secrets', () => {
    const dto = toSessionDto(
      {
        familyId: 'f1',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        issuedAt: new Date('2026-11-02T00:00:00.000Z'),
        lastUsedAt: null,
        expiresAt: new Date('2026-12-02T00:00:00.000Z'),
        ipAddress: '10.1.2.3',
        userAgent: null,
      },
      'f1',
    );
    expect(dto).toEqual({
      sessionId: 'f1',
      deviceLabel: 'Unknown device',
      ipAddress: '10.1.***.***',
      createdAt: '2026-11-01T00:00:00.000Z',
      lastUsedAt: '2026-11-02T00:00:00.000Z',
      expiresAt: '2026-12-02T00:00:00.000Z',
      current: true,
    });
  });
});

describe('CAPTCHA policy (provider none = no-op verifier)', () => {
  it('requires a CAPTCHA after the IP threshold or an account lockout', async () => {
    const store = createMemoryStore();
    const policy = createCaptchaPolicy(store, noopCaptchaVerifier, 'customer');
    expect(policy.isRequired('1.1.1.1')).toBe(false);
    for (let i = 0; i < CAPTCHA_IP_THRESHOLD; i += 1) policy.recordIpFailure('1.1.1.1');
    expect(policy.isRequired('1.1.1.1')).toBe(true);
    expect(policy.isRequired('2.2.2.2', 'u1')).toBe(false);
    policy.flagAccount('u1');
    expect(policy.isRequired('2.2.2.2', 'u1')).toBe(true);
    await expect(policy.enforce('1.1.1.1', undefined, undefined)).resolves.toBeUndefined();
  });

  it('rejects with 422 captchaToken when a real verifier fails', async () => {
    const rejecting: CaptchaVerifier = { provider: 'test', verify: () => Promise.resolve(false) };
    const policy = createCaptchaPolicy(createMemoryStore(), rejecting, 'staff');
    await expect(policy.enforce('3.3.3.3', undefined, 'x')).resolves.toBeUndefined();
    policy.flagAccount('u2');
    await expect(policy.enforce('3.3.3.3', 'u2', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'captchaToken', code: 'CAPTCHA_FAILED' }],
    });
  });
});

describe('MFA service', () => {
  const now = { value: new Date('2026-11-19T06:30:00.000Z') };
  const build = () =>
    createMfaService({
      store: createMemoryStore(() => now.value.getTime()),
      cipher: createFieldCipher(randomBytes(32)),
      clock: () => now.value,
      issuer: 'Test Admin',
      pepper: undefined,
    });

  it('enrols with an encrypted secret and rejects replayed steps', () => {
    const mfa = build();
    const { secret, otpauthUri, encryptedSecret } = mfa.beginEnrollment('a@example.com');
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(encryptedSecret).not.toContain(secret);
    const code = hotp(base32Decode(secret), totpStep(now.value));
    expect(mfa.verifyCode('u1', encryptedSecret, code)).toBe(true);
    expect(mfa.verifyCode('u1', encryptedSecret, code)).toBe(false); // replay
    now.value = new Date(now.value.getTime() + 30_000);
    const next = hotp(base32Decode(secret), totpStep(now.value));
    expect(mfa.verifyCode('u1', encryptedSecret, next)).toBe(true);
    expect(mfa.verifyCode('u1', 'garbage', next)).toBe(false);
  });

  it('binds challenges to IP + UA, expires them and invalidates after 5 failures', () => {
    const mfa = build();
    const challenge = mfa.createChallenge('u1', '1.1.1.1', 'UA');
    expect(mfa.getChallenge(challenge.id, '1.1.1.1', 'UA')).toBeDefined();
    expect(mfa.getChallenge(challenge.id, '9.9.9.9', 'UA')).toBeUndefined();
    expect(mfa.getChallenge(challenge.id, '1.1.1.1', 'other')).toBeUndefined();
    const results: boolean[] = [];
    for (let i = 0; i < MFA_MAX_FAILURES; i += 1) results.push(mfa.recordFailure(challenge));
    expect(results).toEqual([false, false, false, false, true]);
    expect(mfa.getChallenge(challenge.id, '1.1.1.1', 'UA')).toBeUndefined();

    const short = mfa.createChallenge('u1', '1.1.1.1', 'UA');
    now.value = new Date(now.value.getTime() + 301_000);
    expect(mfa.getChallenge(short.id, '1.1.1.1', 'UA')).toBeUndefined();
  });

  it('issues single-use enrolment tokens', () => {
    const mfa = build();
    const token = mfa.issueEnrollmentToken('u9');
    expect(mfa.redeemEnrollmentToken(token)).toBe('u9');
    expect(mfa.redeemEnrollmentToken(token)).toBeUndefined();
  });

  it('marks MFA mandatory for Superadmin and ADMIN only', () => {
    const role = (code: string) => ({ id: code, code, name: code, isSystem: false });
    expect(isMfaMandatory({ isSuperadmin: true }, [])).toBe(true);
    expect(isMfaMandatory({ isSuperadmin: false }, [role('ADMIN')])).toBe(true);
    expect(isMfaMandatory({ isSuperadmin: false }, [role('MANAGER')])).toBe(false);
  });
});

describe('auth schemas', () => {
  it('normalises email and phone, rejects unknown keys', () => {
    const parsed = RegisterBody.parse({
      firstName: ' Riya ',
      email: '  Riya@Example.COM ',
      phone: '098765 43210',
      password: 'x'.repeat(12),
      acceptTerms: true,
    });
    expect(parsed.email).toBe('riya@example.com');
    expect(parsed.phone).toBe('+919876543210');
    expect(parsed.firstName).toBe('Riya');
    expect(RegisterBody.safeParse({ ...parsed, acceptTerms: true, role: 'ADMIN' }).success).toBe(
      false,
    );
    expect(LoginBody.parse({ email: 'a@b.co', password: 'p' }).rememberMe).toBe(false);
    expect(
      OtpSendBody.safeParse({ channel: 'FAX', destination: '+919876543210', purpose: 'LOGIN' })
        .success,
    ).toBe(false);
  });

  it('requires exactly one of totpCode / recoveryCode', () => {
    const id = '6f1d1d4e-1111-4c1c-8c1c-111111111111';
    expect(MfaVerifyBody.safeParse({ mfaChallengeId: id, totpCode: '123456' }).success).toBe(true);
    expect(MfaVerifyBody.safeParse({ mfaChallengeId: id }).success).toBe(false);
    expect(
      MfaVerifyBody.safeParse({ mfaChallengeId: id, totpCode: '123456', recoveryCode: 'a' })
        .success,
    ).toBe(false);
  });
});
