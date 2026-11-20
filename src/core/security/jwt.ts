/**
 * Access-token JWTs — AUTHENTICATION_AUTHORIZATION.md §8, decision C1 (EdDSA / Ed25519).
 *
 * Implemented on `node:crypto` (no extra dependency). Verification pins `alg = EdDSA` per `kid`
 * (rejects `none`, HS256 and any alg confusion), checks `iss`, exact `aud`, `typ = access`, `exp`,
 * and `iat` not in the future beyond the clock-skew tolerance.
 *
 * Canonical env contract (R-46) has ONE signing key pair; the per-audience key separation
 * suggested in §8.2 is therefore not available — audience separation relies on the `aud` claim,
 * the account-type check and the server-side session lookup (§19). Recorded in the B1 report.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

export type Audience = 'storefront' | 'admin';

export interface AccessClaims {
  readonly sub: string;
  readonly aud: string;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly typ: 'access';
}

export class JwtError extends Error {
  constructor(
    readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'CLAIMS',
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface JwtKeySet {
  readonly signingKeyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

export interface JwtKeyInput {
  readonly privateKeyPem: string | undefined;
  readonly publicKeyPem: string | undefined;
  readonly keyId: string;
  readonly previous: { readonly keyId: string; readonly publicKeyPem: string } | undefined;
}

/** Builds the key set; generates an ephemeral Ed25519 pair when no PEMs are configured (dev/test only). */
export function buildKeySet(input: JwtKeyInput): { keySet: JwtKeySet; ephemeral: boolean } {
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  let ephemeral = false;
  if (input.privateKeyPem !== undefined && input.publicKeyPem !== undefined) {
    privateKey = createPrivateKey(input.privateKeyPem);
    publicKey = createPublicKey(input.publicKeyPem);
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    ephemeral = true;
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('JWT keys must be Ed25519 (EdDSA).');
  }
  const publicKeys = new Map<string, KeyObject>([[input.keyId, publicKey]]);
  if (input.previous !== undefined) {
    const previous = createPublicKey(input.previous.publicKeyPem);
    if (previous.asymmetricKeyType !== 'ed25519') {
      throw new Error('JWT_PREVIOUS_PUBLIC_KEY must be Ed25519.');
    }
    publicKeys.set(input.previous.keyId, previous);
  }
  return { keySet: { signingKeyId: input.keyId, privateKey, publicKeys }, ephemeral };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function parseJsonSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new JwtError('MALFORMED', 'Malformed token.');
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('MALFORMED', 'Malformed token.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SignInput {
  readonly sub: string;
  readonly aud: string;
  readonly sid: string;
  readonly iss: string;
  readonly ttlSeconds: number;
  readonly now: Date;
}

export function signAccessToken(keySet: JwtKeySet, input: SignInput): string {
  const iat = Math.floor(input.now.getTime() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keySet.signingKeyId };
  const payload = {
    iss: input.iss,
    sub: input.sub,
    aud: input.aud,
    typ: 'access',
    sid: input.sid,
    iat,
    exp: iat + input.ttlSeconds,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput), keySet.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

export interface VerifyOptions {
  readonly audience: string;
  readonly issuer: string;
  readonly now: Date;
  /** Clock-skew tolerance in seconds (§8.2: 30 s). */
  readonly skewSeconds?: number;
}

export function verifyAccessToken(
  keySet: JwtKeySet,
  token: string,
  options: VerifyOptions,
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('MALFORMED', 'Malformed token.');
  const [headerSeg = '', payloadSeg = '', signatureSeg = ''] = parts;
  const header = parseJsonSegment(headerSeg);
  if (!isRecord(header) || header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
    throw new JwtError('MALFORMED', 'Unsupported token header.');
  }
  const key = keySet.publicKeys.get(header.kid);
  if (key === undefined) throw new JwtError('BAD_SIGNATURE', 'Unknown key id.');
  if (!/^[A-Za-z0-9_-]+$/.test(signatureSeg)) throw new JwtError('MALFORMED', 'Malformed token.');
  const valid = edVerify(
    null,
    Buffer.from(`${headerSeg}.${payloadSeg}`),
    key,
    Buffer.from(signatureSeg, 'base64url'),
  );
  if (!valid) throw new JwtError('BAD_SIGNATURE', 'Invalid signature.');

  const payload = parseJsonSegment(payloadSeg);
  if (!isRecord(payload)) throw new JwtError('MALFORMED', 'Malformed token.');
  const { sub, aud, sid, iat, exp, iss, typ } = payload;
  if (
    typeof sub !== 'string' ||
    typeof aud !== 'string' ||
    typeof sid !== 'string' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    typeof iss !== 'string' ||
    typ !== 'access'
  ) {
    throw new JwtError('CLAIMS', 'Invalid claims.');
  }
  if (iss !== options.issuer || aud !== options.audience) {
    throw new JwtError('CLAIMS', 'Invalid issuer or audience.');
  }
  const skew = options.skewSeconds ?? 30;
  const nowSec = Math.floor(options.now.getTime() / 1000);
  if (iat > nowSec + skew) throw new JwtError('CLAIMS', 'Token issued in the future.');
  if (exp <= nowSec - skew) throw new JwtError('EXPIRED', 'Token expired.');
  return { sub, aud, sid, iat, exp, iss, typ };
}
