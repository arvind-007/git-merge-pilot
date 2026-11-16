/**
 * GitHub App Manifest flow (design §7): build the manifest the browser POSTs to
 * GitHub, and convert the temporary `code` GitHub redirects back with into the
 * App's credentials.
 *
 * The App is strictly read-only: git-merge-pilot never writes to GitHub.
 */
import { Octokit } from '@octokit/rest';
import { num, obj, str } from './util.ts';

/** Read-only permissions requested by the App (design §7). No write permissions, ever. */
export const APP_PERMISSIONS = Object.freeze({
  metadata: 'read',
  contents: 'read',
  pull_requests: 'read',
  issues: 'read',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
  security_events: 'read',
  vulnerability_alerts: 'read',
} as const);

/** Every webhook event git-merge-pilot handles (design §7). */
export const WEBHOOK_EVENTS = Object.freeze([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'check_run',
  'check_suite',
  'status',
  'push',
  'installation',
  'installation_repositories',
  'repository',
] as const);

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * Events GitHub delivers to every App automatically. GitHub does not allow
 * subscribing to them, so they are excluded from the manifest's `default_events`
 * (listing them makes app creation fail) while still being handled.
 */
export const IMPLICIT_APP_EVENTS: readonly WebhookEventName[] = Object.freeze([
  'installation',
  'installation_repositories',
]);

/** Events placed in the manifest's `default_events`. */
export const MANIFEST_EVENTS: readonly WebhookEventName[] = Object.freeze(
  WEBHOOK_EVENTS.filter((e) => !IMPLICIT_APP_EVENTS.includes(e)),
);

/** Paths (relative to PUBLIC_URL) the server must serve for the GitHub flows (design §12). */
export const GITHUB_ROUTES = Object.freeze({
  webhook: '/api/github/webhook',
  manifestCallback: '/api/github/manifest/callback',
  installCallback: '/api/github/install/callback',
});

/** GitHub limits App names to 34 characters. */
export const MAX_APP_NAME_LENGTH = 34;

const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface AppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, 'read'>;
  default_events: string[];
  request_oauth_on_install: boolean;
}

export interface BuildAppManifestInput {
  /** PUBLIC_URL of this install (trailing slash tolerated). */
  publicUrl: string;
  /** Display name for the new App (truncated to 34 chars, GitHub's limit). */
  appName: string;
  /** Organization login to create the App under; omit to create it on the user account. */
  org?: string | null;
  /** GitHub web URL (GITHUB_WEB_URL); default https://github.com. */
  webUrl?: string;
  /**
   * Override for the webhook URL, e.g. a smee.io channel (SMEE_URL) when
   * PUBLIC_URL is not reachable from GitHub. Default: PUBLIC_URL/api/github/webhook.
   */
  webhookUrl?: string | null;
  /** Opaque CSRF `state` echoed back on the redirect; appended to `postUrl`. */
  state?: string | null;
  /** Optional App description. */
  description?: string;
}

export interface BuildAppManifestResult {
  manifest: AppManifest;
  /** URL the browser form must POST `manifest` (JSON string field) to. */
  postUrl: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function assertHttpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${name} must use http or https`);
  }
  return trimSlash(value);
}

/** True when `login` is a syntactically valid GitHub user/org login. */
export function isValidGitHubLogin(loginValue: string): boolean {
  return GITHUB_LOGIN_RE.test(loginValue);
}

/** Builds the GitHub App manifest and the URL to POST it to (design §7). */
export function buildAppManifest(input: BuildAppManifestInput): BuildAppManifestResult {
  const publicUrl = assertHttpUrl(input.publicUrl, 'publicUrl');
  const webUrl = assertHttpUrl(input.webUrl ?? 'https://github.com', 'webUrl');
  const webhookUrl = input.webhookUrl
    ? assertHttpUrl(input.webhookUrl, 'webhookUrl')
    : `${publicUrl}${GITHUB_ROUTES.webhook}`;

  const name = input.appName.trim().slice(0, MAX_APP_NAME_LENGTH).trim();
  if (!name) throw new TypeError('appName must not be empty');

  const org = input.org?.trim() || null;
  if (org !== null && !isValidGitHubLogin(org)) {
    throw new TypeError('org must be a valid GitHub organization login');
  }

  const manifest: AppManifest = {
    name,
    url: publicUrl,
    description:
      input.description ??
      'git-merge-pilot: read-only pull request intelligence (risk, breaking changes, security, overlap).',
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: `${publicUrl}${GITHUB_ROUTES.manifestCallback}`,
    setup_url: `${publicUrl}${GITHUB_ROUTES.installCallback}`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [...MANIFEST_EVENTS],
    request_oauth_on_install: false,
  };

  const base = org
    ? `${webUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `${webUrl}/settings/apps/new`;
  const postUrl = input.state ? `${base}?state=${encodeURIComponent(input.state)}` : base;

  return { manifest, postUrl };
}

export interface ManifestConversion {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  /** PEM-encoded private key. Store encrypted; never log. */
  pem: string;
  /** Webhook secret GitHub generated for the App (null only if the App has no webhook). */
  webhookSecret: string | null;
  htmlUrl: string;
  ownerLogin: string;
  /** Permissions GitHub actually granted to the App. */
  permissions: Record<string, string>;
  /** Events the App is subscribed to. */
  events: string[];
}

export interface ConvertManifestCodeOptions {
  /** GITHUB_API_URL; default https://api.github.com. */
  apiUrl?: string;
  /** Custom Octokit request options (tests, proxies). */
  request?: Record<string, unknown>;
}

/** Thrown when the manifest conversion response is missing required fields. */
export class ManifestConversionError extends Error {
  override name = 'ManifestConversionError';
}

/**
 * Exchanges the one-hour manifest `code` for the new App's credentials
 * (`POST /app-manifests/{code}/conversions`, unauthenticated).
 */
export async function convertManifestCode(
  code: string,
  options: ConvertManifestCodeOptions = {},
): Promise<ManifestConversion> {
  const trimmed = code.trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(trimmed)) {
    throw new TypeError('Invalid manifest code');
  }
  const octokit = new Octokit({
    baseUrl: trimSlash(options.apiUrl ?? 'https://api.github.com'),
    userAgent: 'git-merge-pilot',
    ...(options.request ? { request: options.request } : {}),
  });
  const { data } = await octokit.rest.apps.createFromManifest({ code: trimmed });
  const d = data as unknown as Record<string, unknown>;

  const appId = num(d.id);
  const slug = str(d.slug);
  const clientId = str(d.client_id);
  const clientSecret = str(d.client_secret);
  const pem = str(d.pem);
  const ownerLogin = str(obj(d.owner)?.login);
  if (appId === null || !slug || !clientId || !clientSecret || !pem || !ownerLogin) {
    throw new ManifestConversionError(
      'GitHub returned an incomplete App manifest conversion response',
    );
  }
  const permissions: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(d.permissions) ?? {})) {
    if (typeof v === 'string') permissions[k] = v;
  }
  return {
    appId,
    slug,
    name: str(d.name) ?? slug,
    clientId,
    clientSecret,
    pem,
    webhookSecret: str(d.webhook_secret),
    htmlUrl: str(d.html_url) ?? '',
    ownerLogin,
    permissions,
    events: Array.isArray(d.events)
      ? d.events.filter((e): e is string => typeof e === 'string')
      : [],
  };
}
