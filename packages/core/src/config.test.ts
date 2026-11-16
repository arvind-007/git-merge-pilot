import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const masterKey = randomBytes(32).toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  MASTER_KEY: masterKey,
  SESSION_SECRET: randomBytes(48).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.webUrl).toBe('http://localhost:3000');
    expect(c.githubApiUrl).toBe('https://api.github.com');
    expect(c.githubWebUrl).toBe('https://github.com');
    expect(c.smeeUrl).toBeUndefined();
    expect(c.logLevel).toBe('info');
    expect(c.nodeEnv).toBe('development');
    expect(c.isProduction).toBe(false);
    expect(c.secureCookies).toBe(false);
    expect(isAbsolute(c.repoCacheDir)).toBe(true);
    expect(c.repoCacheDir.endsWith('.data/repos')).toBe(true);
    expect(c.masterKey.length).toBe(32);
    expect(c.masterKey.toString('base64')).toBe(masterKey);
  });

  it('parses explicit values and trims trailing slashes', () => {
    const c = loadConfig({
      ...base,
      PUBLIC_URL: 'https://gmp.example.com/',
      PORT: '8080',
      GITHUB_API_URL: 'https://ghe.example.com/api/v3/',
      SMEE_URL: 'https://smee.io/abc',
      LOG_LEVEL: 'DEBUG',
      NODE_ENV: 'production',
    });
    expect(c.publicUrl).toBe('https://gmp.example.com');
    expect(c.port).toBe(8080);
    expect(c.githubApiUrl).toBe('https://ghe.example.com/api/v3');
    expect(c.smeeUrl).toBe('https://smee.io/abc');
    expect(c.logLevel).toBe('debug');
    expect(c.isProduction).toBe(true);
    expect(c.secureCookies).toBe(true);
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ ...base, SMEE_URL: '', PORT: '', LOG_LEVEL: '' });
    expect(c.smeeUrl).toBeUndefined();
    expect(c.port).toBe(3000);
    expect(c.logLevel).toBe('info');
  });

  it('reports all problems without leaking secret values', () => {
    const badKey = randomBytes(16).toString('base64');
    try {
      loadConfig({
        DATABASE_URL: 'mysql://x',
        MASTER_KEY: badKey,
        SESSION_SECRET: 'short',
        PORT: '99999',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('MASTER_KEY');
      expect(e.message).toContain('SESSION_SECRET');
      expect(e.message).toContain('PORT');
      expect(e.message).not.toContain(badKey);
      expect(e.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('requires DATABASE_URL, MASTER_KEY and SESSION_SECRET', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*MASTER_KEY[\s\S]*SESSION_SECRET/);
  });

  it('rejects invalid urls', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'not a url' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...base, WEB_URL: 'not a url' })).toThrow(/WEB_URL/);
    expect(loadConfig({ ...base, WEB_URL: 'http://localhost:5173/' }).webUrl).toBe(
      'http://localhost:5173',
    );
    expect(loadConfig({ ...base, WEB_URL: '' }).webUrl).toBe(loadConfig(base).publicUrl);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://x' })).toThrow(/PUBLIC_URL/);
  });
});
