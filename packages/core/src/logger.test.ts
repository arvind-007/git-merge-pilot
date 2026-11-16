import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, isSensitiveKey, redactLogValue } from './logger.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of chunk.toString().split('\n')) if (l.trim()) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

const fakeToken = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

describe('createLogger', () => {
  it('writes JSON with the logger name', () => {
    const { lines, stream } = capture();
    const log = createLogger('test-logger', { destination: stream, level: 'info' });
    log.info({ repo: 'a/b' }, 'hello');
    expect(lines[0]).toMatchObject({
      name: 'test-logger',
      repo: 'a/b',
      msg: 'hello',
      level: 'info',
    });
  });

  it('redacts sensitive keys at any depth', () => {
    const { lines, stream } = capture();
    const log = createLogger('t', { destination: stream, level: 'info' });
    log.info({
      token: 'abc',
      nested: { clientSecret: 'shh', password: 'p', apiKey: 'k', private_key: 'pem' },
      headers: { authorization: 'Bearer x', 'x-other': 'fine' },
      list: [{ webhookSecret: 'w' }],
    });
    const line = lines[0]!;
    expect(line.token).toBe('[REDACTED]');
    expect(line.nested).toEqual({
      clientSecret: '[REDACTED]',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      private_key: '[REDACTED]',
    });
    expect(line.headers).toEqual({ authorization: '[REDACTED]', 'x-other': 'fine' });
    expect(line.list).toEqual([{ webhookSecret: '[REDACTED]' }]);
  });

  it('keeps token counts and dedup keys', () => {
    const { lines, stream } = capture();
    const log = createLogger('t', { destination: stream, level: 'info' });
    log.info({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      dedupKey: 'pr:1',
      singletonKey: 's',
    });
    expect(lines[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      dedupKey: 'pr:1',
      singletonKey: 's',
    });
  });

  it('redacts secrets in message strings and string values', () => {
    const { lines, stream } = capture();
    const log = createLogger('t', { destination: stream, level: 'info' });
    log.info(
      { url: `https://x-access-token:${fakeToken}@github.com/a/b.git` },
      `cloning with ${fakeToken}`,
    );
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain(fakeToken);
    expect(lines[0]!.msg).toContain('[REDACTED:github_token]');
  });

  it('serialises and redacts errors', () => {
    const { lines, stream } = capture();
    const log = createLogger('t', { destination: stream, level: 'info' });
    const err = Object.assign(new Error(`bad credentials ${fakeToken}`), {
      status: 401,
      token: 'x',
    });
    log.error({ err }, 'failed');
    const e = lines[0]!.err as Record<string, unknown>;
    expect(e.type).toBe('Error');
    expect(e.status).toBe(401);
    expect(e.token).toBe('[REDACTED]');
    expect(String(e.message)).not.toContain(fakeToken);
    expect(String(e.stack)).not.toContain(fakeToken);
  });

  it('respects level', () => {
    const { lines, stream } = capture();
    const log = createLogger('t', { destination: stream, level: 'warn' });
    log.info('hidden');
    log.warn('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });

  it('returns a usable shared child logger without options', () => {
    const log = createLogger('shared');
    expect(typeof log.info).toBe('function');
  });
});

describe('redaction helpers', () => {
  it('classifies keys', () => {
    expect(isSensitiveKey('MASTER_KEY')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('sessionCookie')).toBe(true);
    expect(isSensitiveKey('maxOutputTokens')).toBe(false);
    expect(isSensitiveKey('repo')).toBe(false);
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactLogValue(a)).toEqual({ name: 'a', self: '[Circular]' });
  });
});
