import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

let configuredKey: Buffer | null = null;

/** Parses a base64 MASTER_KEY and checks it is exactly 32 bytes. */
export function parseMasterKey(base64: string): Buffer {
  const v = base64.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) throw new Error('MASTER_KEY is not valid base64');
  const key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');
  return key;
}

/**
 * Sets the process-wide master key used by {@link encrypt}/{@link decrypt}.
 * Accepts the decoded 32-byte key (e.g. `config.masterKey`) or its base64 form.
 * When never called, `process.env.MASTER_KEY` is used.
 */
export function setMasterKey(key: Buffer | string | null): void {
  if (key === null) {
    configuredKey = null;
    return;
  }
  const buf = typeof key === 'string' ? parseMasterKey(key) : Buffer.from(key);
  if (buf.length !== 32) throw new Error('MASTER_KEY must be exactly 32 bytes');
  configuredKey = buf;
}

function resolveKey(key?: Buffer): Buffer {
  if (key) {
    if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes');
    return key;
  }
  if (configuredKey) return configuredKey;
  const fromEnv = process.env.MASTER_KEY;
  if (!fromEnv) throw new Error('MASTER_KEY is not configured');
  return parseMasterKey(fromEnv);
}

/**
 * AES-256-GCM encryption with the master key.
 * Output format: `v1:<iv>:<tag>:<ciphertext>` (each part base64).
 */
export function encrypt(plain: string, key?: Buffer): string {
  const k = resolveKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypts a blob produced by {@link encrypt}. Throws on tampering or a wrong key. */
export function decrypt(blob: string, key?: Buffer): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported or malformed encrypted value');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Unsupported or malformed encrypted value');
  }
  const decipher = createDecipheriv(ALGORITHM, resolveKey(key), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Decryption failed (wrong MASTER_KEY or corrupted value)');
  }
}

/** True when the value looks like an {@link encrypt} output. */
export function isEncrypted(value: unknown): value is string {
  return (
    typeof value === 'string' && /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(value)
  );
}

/** Encrypts a JSON-serialisable value. */
export function encryptJson(value: unknown, key?: Buffer): string {
  return encrypt(JSON.stringify(value), key);
}

/** Decrypts a value produced by {@link encryptJson}. */
export function decryptJson<T = unknown>(blob: string, key?: Buffer): T {
  return JSON.parse(decrypt(blob, key)) as T;
}

/** Cryptographically random URL-safe token (default 32 bytes of entropy). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256 — used to store session/invite/setup tokens (`token_hash` columns). */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hex HMAC-SHA256. */
export function hmacSha256Hex(secret: string | Buffer, value: string | Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time string comparison (false on length mismatch). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
