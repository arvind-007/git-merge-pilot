import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test/utils.tsx';
import {
  ApiError,
  CSRF_HEADER,
  api,
  asList,
  buildUrl,
  friendlyMessage,
  getCsrfToken,
  setCsrfToken,
} from './client.ts';

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe('api client', () => {
  beforeEach(() => setCsrfToken(null));
  afterEach(() => vi.unstubAllGlobals());

  it('sends cookies and no CSRF header on GET', async () => {
    const f = mockFetch({ 'GET /api/projects': { body: [{ id: 'p1' }] } });
    const res = await api.get<unknown[]>('/api/projects');
    expect(res).toEqual([{ id: 'p1' }]);
    const init = f.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(headerOf(init, CSRF_HEADER)).toBeUndefined();
  });

  it('fetches the CSRF token from /api/auth/me and sends it on mutations', async () => {
    const f = mockFetch({
      'GET /api/auth/me': { body: { user: {}, org: {}, csrfToken: 'tok-123' } },
      'POST /api/projects': { status: 201, body: { id: 'p1' } },
    });
    await api.post('/api/projects', { name: 'X' });
    const post = f.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'POST');
    expect(headerOf(post?.[1], CSRF_HEADER)).toBe('tok-123');
    expect(post?.[1]?.body).toBe(JSON.stringify({ name: 'X' }));
    expect(getCsrfToken()).toBe('tok-123');
  });

  it('retries once with a fresh token after a CSRF rejection', async () => {
    setCsrfToken('stale');
    let posts = 0;
    const f = mockFetch({
      'GET /api/auth/me': { body: { csrfToken: 'fresh' } },
      'DELETE /api/projects/1': (init) => {
        posts += 1;
        return headerOf(init, CSRF_HEADER) === 'fresh'
          ? { status: 204 }
          : { status: 403, body: { code: 'CSRF_INVALID' } };
      },
    });
    await api.delete('/api/projects/1');
    expect(posts).toBe(2);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('throws ApiError with friendly messages', async () => {
    mockFetch({ 'GET /api/x': { status: 500, body: { message: 'TypeError: secret stack' } } });
    const err = await api.get('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).not.toContain('TypeError');
    expect((err as ApiError).message).toMatch(/went wrong on the server/i);
  });

  it('passes validation messages through on 400', async () => {
    mockFetch({ 'POST /api/y': { status: 400, body: { message: 'Name is required' } } });
    setCsrfToken('t');
    await expect(api.post('/api/y', {})).rejects.toThrow('Name is required');
  });

  it('reports network failures as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const err = (await api.get('/api/z').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/could not reach/i);
  });

  it('friendlyMessage covers auth and rate limiting', () => {
    expect(friendlyMessage(401, null)).toMatch(/sign in again/i);
    expect(friendlyMessage(401, { message: 'Invalid email or password' })).toBe(
      'Invalid email or password',
    );
    expect(friendlyMessage(429, null)).toMatch(/too many/i);
    expect(friendlyMessage(403, { code: 'csrf_mismatch' })).toMatch(/security token/i);
  });

  it('buildUrl drops empty params and asList normalises wrappers', () => {
    expect(buildUrl('/api/pull-requests', { state: 'open', risk: '', author: undefined })).toBe(
      '/api/pull-requests?state=open',
    );
    expect(asList([1, 2])).toEqual([1, 2]);
    expect(asList({ items: [1] })).toEqual([1]);
    expect(asList({ projects: [3] }, 'projects')).toEqual([3]);
    expect(asList(null)).toEqual([]);
  });
});
