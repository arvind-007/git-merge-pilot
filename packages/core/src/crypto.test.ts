import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  generateToken,
  isEncrypted,
  parseMasterKey,
  setMasterKey,
  sha256Hex,
  timingSafeEqualStr,
} from './crypto.ts';

const key = randomBytes(32);

afterEach(() => setMasterKey(null));

describe('encrypt/decrypt', () => {
  it('round-trips unicode text with an explicit key', () => {
    const plain = 'hello — wörld 🔐 -----BEGIN RSA PRIVATE KEY-----';
    const blob = encrypt(plain, key);
    expect(blob).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(blob).not.toContain('hello');
    expect(decrypt(blob, key)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('round-trips the empty string', () => {
    expect(decrypt(encrypt('', key), key)).toBe('');
  });

  it('uses the configured master key', () => {
    setMasterKey(key.toString('base64'));
    const blob = encrypt('configured');
    expect(decrypt(blob, key)).toBe('configured');
  });

  it('falls back to process.env.MASTER_KEY', () => {
    const prev = process.env.MASTER_KEY;
    process.env.MASTER_KEY = key.toString('base64');
    try {
      expect(decrypt(encrypt('from env'), key)).toBe('from env');
    } finally {
      if (prev === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = prev;
    }
  });

  it('rejects a wrong key', () => {
    const blob = encrypt('secret', key);
    expect(() => decrypt(blob, randomBytes(32))).toThrow(/Decryption failed/);
  });

  it('detects tampering with the ciphertext and the tag', () => {
    const blob = encrypt('secret value', key);
    const [v, iv, tag, ct] = blob.split(':') as [string, string, string, string];
    const ctBuf = Buffer.from(ct, 'base64');
    ctBuf[0] = ctBuf[0]! ^ 0xff;
    expect(() => decrypt([v, iv, tag, ctBuf.toString('base64')].join(':'), key)).toThrow();
    const tagBuf = Buffer.from(tag, 'base64');
    tagBuf[0] = tagBuf[0]! ^ 0xff;
    expect(() => decrypt([v, iv, tagBuf.toString('base64'), ct].join(':'), key)).toThrow();
  });

  it('rejects malformed blobs', () => {
    expect(() => decrypt('nope', key)).toThrow(/malformed/);
    expect(() => decrypt('v2:a:b:c', key)).toThrow(/malformed/);
    expect(() => decrypt('v1:AAAA:AAAA:AAAA', key)).toThrow(/malformed/);
  });

  it('rejects keys of the wrong size', () => {
    expect(() => encrypt('x', randomBytes(16))).toThrow(/32 bytes/);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseMasterKey('not base64!!')).toThrow(/base64/);
  });

  it('round-trips JSON', () => {
    const value = { host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'p' } };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  it('isEncrypted recognises blobs', () => {
    expect(isEncrypted(encrypt('x', key))).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});

describe('token helpers', () => {
  it('generates url-safe unique tokens', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares strings in constant time', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});
