import { clsx } from 'clsx';
import { Bell, Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client.ts';
import { useMarkNotificationRead, useNotifications } from '../api/hooks.ts';
import type { NotificationItem } from '../api/types.ts';
import { SeverityBadge } from '../components/badges.tsx';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  ExternalA,
  LoadingBlock,
  PageHeader,
  PlainText,
} from '../components/ui.tsx';
import { NOTIFICATION_KIND_LABEL, timeAgo } from '../lib/format.ts';
import { safeUrl } from '../lib/links.ts';

/** Convert absolute links to this app into in-app paths; leave other safe URLs alone. */
export function notificationTarget(
  n: Pick<NotificationItem, 'url' | 'pullRequestId'>,
  origin: string = typeof window !== 'undefined' ? window.location.origin : '',
): { internal: string } | { external: string } | null {
  if (n.url) {
    const safe = safeUrl(n.url);
    if (safe) {
      if (safe.startsWith('/')) return { internal: safe };
      try {
        const u = new URL(safe);
        if (origin && u.origin === origin) return { internal: `${u.pathname}${u.search}${u.hash}` };
      } catch {
        // ignore
      }
      return { external: safe };
    }
  }
  if (n.pullRequestId) return { internal: `/pull-requests/${n.pullRequestId}` };
  return null;
}

function NotificationRow({ n }: { n: NotificationItem }) {
  const mark = useMarkNotificationRead();
  const unread = !n.readAt && n.status !== 'read';
  const target = notificationTarget(n);
  const onOpen = () => {
    if (unread) mark.mutate(n.id);
  };
  return (
    <li className={clsx('flex gap-3 p-4', unread && 'bg-indigo-50/60 dark:bg-indigo-950/30')}>
      <span
        className={clsx(
          'mt-1.5 size-2 shrink-0 rounded-full',
          unread ? 'bg-indigo-600' : 'bg-transparent',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="gray">{NOTIFICATION_KIND_LABEL[n.kind] ?? n.kind}</Badge>
          {n.severity && <SeverityBadge severity={n.severity} />}
          {unread && <span className="sr-only">Unread.</span>}
          <span className="text-xs text-slate-500 dark:text-slate-400">{timeAgo(n.createdAt)}</span>
        </div>
        <div className="mt-1 font-medium break-words">
          {target && 'internal' in target ? (
            <Link
              to={target.internal}
              onClick={onOpen}
              className="hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              {n.title}
            </Link>
          ) : target ? (
            <span onClickCapture={onOpen}>
              <ExternalA href={target.external}>{n.title}</ExternalA>
            </span>
          ) : (
            n.title
          )}
        </div>
        {n.body && (
          <PlainText
            text={n.body}
            className="mt-0.5 line-clamp-3 text-sm text-slate-700 dark:text-slate-300"
          />
        )}
        {mark.isError && <p className="mt-1 text-xs text-red-700">{errorMessage(mark.error)}</p>}
      </div>
      {unread && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => mark.mutate(n.id)}
          loading={mark.isPending}
          icon={<Check className="size-4" aria-hidden />}
        >
          <span className="sr-only sm:not-sr-only">Mark read</span>
        </Button>
      )}
    </li>
  );
}

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useNotifications(unreadOnly);
  const mark = useMarkNotificationRead();
  const unread = (list.data ?? []).filter((n) => !n.readAt && n.status !== 'read');

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Alerts about risky changes, security findings, overlaps and system problems."
        actions={
          <>
            <div
              role="group"
              aria-label="Filter"
              className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-600"
            >
              {[false, true].map((u) => (
                <button
                  key={String(u)}
                  type="button"
                  aria-pressed={unreadOnly === u}
                  onClick={() => setUnreadOnly(u)}
                  className={clsx(
                    'rounded-md px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-indigo-500',
                    unreadOnly === u
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-700 dark:text-slate-300',
                  )}
                >
                  {u ? 'Unread' : 'All'}
                </button>
              ))}
            </div>
            {unread.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                loading={mark.isPending}
                onClick={async () => {
                  for (const n of unread) await mark.mutateAsync(n.id).catch(() => undefined);
                }}
              >
                Mark all read
              </Button>
            )}
          </>
        }
      />
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={<Bell />} title={unreadOnly ? 'All caught up' : 'No notifications yet'}>
          {unreadOnly
            ? 'You have read everything.'
            : 'You will be notified here when a pull request becomes high risk, a security or breaking change is found, or work overlaps. Admins can adjust rules in Settings → Notifications.'}
        </EmptyState>
      ) : (
        <>
          {mark.isError && (
            <Alert tone="danger" className="mb-3">
              {errorMessage(mark.error)}
            </Alert>
          )}
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-900">
            {list.data.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
