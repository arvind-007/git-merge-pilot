import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  isDatabaseReachable,
  organizations,
  sessions,
  systemState,
  users,
  auditLog,
} from '@gmp/db';
import { ensureSetupToken } from './setup-token.ts';
import {
  ADMIN,
  as,
  createMember,
  createTestApp,
  sessionCookie,
  setupAdmin,
  toSession,
  type Session,
  type TestApp,
} from './test/helpers.ts';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('setup flow', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('reports setup required before an admin exists', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      completed: false,
      adminCreated: false,
      step: 1,
      setupTokenRequired: true,
    });
    expect(t.setupToken.length).toBeGreaterThan(20);
    const [state] = await t.db.handle.db.select().from(systemState);
    expect(state!.setupTokenHash).toBeTruthy();
    expect(state!.setupTokenHash).not.toContain(t.setupToken);
  });

  it('rejects a wrong setup token and invalid input', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, setupToken: 'not-the-token' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('invalid_setup_token');

    const weak = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, password: 'short', setupToken: t.setupToken },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('validation_error');
  });

  it('creates the first admin, signs them in, and clears the token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, setupToken: t.setupToken },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({
      email: 'admin@example.test',
      role: 'admin',
      name: ADMIN.name,
    });
    expect(body.org).toMatchObject({ name: ADMIN.orgName, timezone: 'UTC' });
    expect(typeof body.csrfToken).toBe('string');
    const cookie = res.cookies.find((c) => c.name === 'gmp_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const [state] = await t.db.handle.db.select().from(systemState);
    expect(state!.setupTokenHash).toBeNull();
    const [u] = await t.db.handle.db.select().from(users);
    expect(u!.passwordHash.startsWith('$argon2id$')).toBe(true);

    const status = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toMatchObject({ adminCreated: true, completed: false });

    // Replaying the token (or any token) no longer works.
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, email: 'other@example.test', setupToken: t.setupToken },
    });
    expect(again.statusCode).toBe(409);

    // A reboot does not generate a new token once an admin exists.
    const reboot = await ensureSetupToken(t.db.handle.db, {
      publicUrl: t.config.publicUrl,
      print: () => {},
    });
    expect(reboot.token).toBeNull();

    const s = toSession(res);
    const complete = await as(t, s)('POST', '/api/setup/complete');
    expect(complete.statusCode).toBe(200);
    const done = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(done.json()).toMatchObject({ completed: true, step: 7 });
    // Open PRs are imported right after setup instead of at the next 15-minute poll.
    expect(t.queue.byName('reconcile.poll')).toHaveLength(1);

    const audit = await t.db.handle.db.select().from(auditLog);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['setup.admin_created', 'setup.completed']),
    );
  });
});

describe.skipIf(!reachable)('simplified setup form', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('creates the admin with only name, email, password and timezone', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: {
        setupToken: t.setupToken,
        name: 'Pat Manager',
        email: 'pat@example.test',
        password: 'correct horse battery staple',
        timezone: 'Asia/Kolkata',
      },
    });
    expect(res.statusCode).toBe(201);
    const [org] = await t.db.handle.db.select().from(organizations);
    expect(org!.name).toBe('My organization');
    expect(org!.timezone).toBe('Asia/Kolkata');
    const [u] = await t.db.handle.db.select().from(users);
    expect(u!.timezone).toBe('Asia/Kolkata');
  });
});

describe.skipIf(!reachable)('GMP_SETUP_TOKEN preset', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('uses the operator-chosen token and never prints it', async () => {
    const printed: (string | null)[] = [];
    const preset = 'operator-chosen-token-123456';
    await ensureSetupToken(t.db.handle.db, {
      publicUrl: t.config.publicUrl,
      presetToken: preset,
      print: (tok) => printed.push(tok),
    });
    expect(printed).toEqual([null]);
    const old = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, setupToken: t.setupToken },
    });
    expect(old.statusCode).toBe(401);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, setupToken: preset },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe.skipIf(!reachable)('GMP_SETUP_TOKEN validation', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('rejects a preset token that is too short', async () => {
    await expect(
      ensureSetupToken(t.db.handle.db, {
        publicUrl: t.config.publicUrl,
        presetToken: 'short',
        print: () => {},
      }),
    ).rejects.toThrow(/at least 16/);
  });
});

describe.skipIf(!reachable)('login, logout, csrf and invites', () => {
  let t: TestApp;
  let admin: Session;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
  });
  afterAll(async () => t?.close());

  it('rejects bad credentials without revealing which part was wrong', async () => {
    const wrongPw = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'wrong password!!' },
    });
    const noUser = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong password!!' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(noUser.json());
    expect(wrongPw.json().code).toBe('invalid_credentials');
  });

  it('logs in (case-insensitive email), serves /me, and logs out', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ADMIN@example.TEST', password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    const s = toSession(res);
    const me = await as(t, s)('GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { role: 'admin' }, csrfToken: s.csrf });

    const out = await as(t, s)('POST', '/api/auth/logout');
    expect(out.statusCode).toBe(200);
    const cleared = out.cookies.find((c) => c.name === 'gmp_session');
    expect(cleared?.value).toBe('');
    const after = await as(t, s)('GET', '/api/auth/me');
    expect(after.statusCode).toBe(401);
    const rows = await t.db.handle.db.select().from(sessions);
    expect(rows.some((r) => r.csrfToken === s.csrf)).toBe(false);
  });

  it('stores only a hash of the session token', async () => {
    const rows = await t.db.handle.db.select().from(sessions);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.tokenHash).not.toBe(admin.cookie);
    }
  });

  it('rejects mutating requests without a valid CSRF header', async () => {
    const missing = await as(t, admin)('POST', '/api/projects', { name: 'X' }, { csrf: null });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe('csrf_invalid');
    const wrong = await as(t, admin)('POST', '/api/projects', { name: 'X' }, { csrf: 'nope' });
    expect(wrong.statusCode).toBe(403);
    const ok = await as(t, admin)('POST', '/api/projects', { name: 'X' });
    expect(ok.statusCode).toBe(201);
    // Logout is mutating too.
    const logout = await as(t, admin)('POST', '/api/auth/logout', undefined, { csrf: null });
    expect(logout.statusCode).toBe(403);
  });

  it('rejects non-JSON bodies on mutating API routes', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'email=a&password=b',
    });
    expect(res.statusCode).toBe(415);
  });

  it('requires auth and admin role where appropriate', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(anon.statusCode).toBe(401);
    const member = await createMember(t, admin, 'member1@example.test');
    const forbidden = await as(t, member)('GET', '/api/users');
    expect(forbidden.statusCode).toBe(403);
    const audit = await as(t, member)('GET', '/api/audit-log');
    expect(audit.statusCode).toBe(403);
  });

  it('runs the invite flow end to end', async () => {
    const inv = await as(t, admin)('POST', '/api/users/invite', {
      email: 'New.Person@Example.test',
      role: 'member',
    });
    expect(inv.statusCode).toBe(201);
    const { inviteUrl } = inv.json();
    expect(inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\//);
    const token = decodeURIComponent(inviteUrl.split('/invite/')[1]);

    const list = await as(t, admin)('GET', '/api/users');
    expect(list.json().invites.map((i: { email: string }) => i.email)).toContain(
      'new.person@example.test',
    );
    expect(JSON.stringify(list.json())).not.toContain(token);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: { token: 'x'.repeat(40), name: 'New', password: 'a long password 1' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invite_invalid');

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: {
        token,
        name: 'New Person',
        password: 'a long password 1',
        timezone: 'Europe/Berlin',
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user).toMatchObject({
      email: 'new.person@example.test',
      role: 'member',
      timezone: 'Europe/Berlin',
    });
    expect(sessionCookie(ok)).toBeTruthy();

    const reuse = await t.app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      payload: { token, name: 'New Person', password: 'a long password 1' },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it('disabling a user ends their sessions and blocks login; last admin is protected', async () => {
    const m = await createMember(t, admin, 'tobedisabled@example.test');
    const patch = await as(t, admin)('PATCH', `/api/users/${m.userId}`, { disabled: true });
    expect(patch.statusCode).toBe(200);
    expect((await as(t, m)('GET', '/api/auth/me')).statusCode).toBe(401);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tobedisabled@example.test', password: 'member password 123' },
    });
    expect(login.statusCode).toBe(401);

    const self = await as(t, admin)('PATCH', `/api/users/${admin.userId}`, { role: 'member' });
    expect(self.statusCode).toBe(400);
    const [row] = await t.db.handle.db.select().from(users).where(eq(users.id, admin.userId));
    expect(row!.role).toBe('admin');
  });
});

describe.skipIf(!reachable)('rate limiting', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ rateLimit: { max: 1000, loginMax: 3 } });
  });
  afterAll(async () => t?.close());

  it('applies the stricter limit to login', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'x@example.test', password: 'whatever pw' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
    const health = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');
  });

  it('sets security headers including a CSP that allows the GitHub manifest form', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('form-action');
    expect(csp).toContain('https://github.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
