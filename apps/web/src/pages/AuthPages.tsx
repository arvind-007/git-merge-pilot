import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAcceptInvite, useLogin, useMe, useSetupStatus } from '../api/hooks.ts';
import { errorMessage } from '../api/client.ts';
import { safeNext } from '../components/AuthGuard.tsx';
import { Logo } from '../components/Layout.tsx';
import { Alert, Button, Field, Input, LoadingBlock } from '../components/ui.tsx';
import { browserTimezone } from '../lib/format.ts';

export function AuthShell({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-slate-50 px-4 py-10 text-slate-900 sm:justify-center dark:bg-slate-950 dark:text-slate-100">
      <Logo className="mb-6 text-lg" />
      <main
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900`}
      >
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && (
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</div>
        )}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const setup = useSetupStatus();
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (setup.isPending || me.isPending) return <LoadingBlock />;
  if (setup.data && !setup.data.adminCreated) return <Navigate to="/setup" replace />;
  if (me.data)
    return <Navigate to={setup.data && !setup.data.completed ? '/setup' : next} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email: email.trim().toLowerCase(), password },
      {
        onSuccess: () =>
          navigate(setup.data && !setup.data.completed ? '/setup' : next, { replace: true }),
      },
    );
  };

  return (
    <AuthShell title="Sign in" subtitle="Pull request intelligence for your projects.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {login.isError && <Alert tone="danger">{errorMessage(login.error)}</Alert>}
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          className="w-full"
          loading={login.isPending}
          disabled={!email || !password}
        >
          Sign in
        </Button>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          No account? Ask an admin of this git-merge-pilot installation to invite you.
        </p>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const { token: pathToken } = useParams();
  const token = pathToken ?? params.get('token') ?? '';
  const accept = useAcceptInvite();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 12;

  if (!token) {
    return (
      <AuthShell title="Invitation link incomplete">
        <Alert tone="warning">
          This invitation link is missing its token. Open the full link from your invitation, or ask
          your admin for a new one.
        </Alert>
        <p className="mt-4 text-sm">
          <Link to="/login" className="text-indigo-700 underline dark:text-indigo-300">
            Go to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || tooShort) return;
    accept.mutate(
      { token, name: name.trim(), password, timezone: browserTimezone() },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  };

  return (
    <AuthShell
      title="Join your team"
      subtitle="Create your account to see pull request reports for your projects."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {accept.isError && <Alert tone="danger">{errorMessage(accept.error)}</Alert>}
        <Field label="Your name">
          <Input
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          hint="At least 12 characters."
          error={tooShort ? 'Use at least 12 characters.' : null}
        >
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match.' : null}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          className="w-full"
          loading={accept.isPending}
          disabled={!name.trim() || !password || mismatch || tooShort}
        >
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}

export function NotFoundPage() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        The page you opened does not exist or was moved.
      </p>
      <Link to="/" className="mt-4 inline-block text-indigo-700 underline dark:text-indigo-300">
        Back to overview
      </Link>
    </div>
  );
}
