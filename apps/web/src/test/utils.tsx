import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

export type RouteHandler = (
  init: RequestInit | undefined,
  url: URL,
) => { status?: number; body?: unknown } | undefined;

/**
 * Install a fetch mock that routes on "METHOD /path" (query ignored). Unknown routes return 404.
 * Returns the mock so tests can inspect calls.
 */
export function mockFetch(
  routes: Record<string, RouteHandler | { status?: number; body?: unknown }>,
) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      'http://localhost',
    );
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    const route = routes[key];
    const res = typeof route === 'function' ? route(init, url) : route;
    if (!res)
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
