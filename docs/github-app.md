# GitHub App

git-merge-pilot connects to GitHub through a **GitHub App that you own**. The App is created in your account or organization, and its credentials stay in your database, encrypted. The App asks for **read-only** permissions only. git-merge-pilot never comments, approves, merges, pushes or changes settings.

## One-click creation (manifest flow)

The setup wizard (step 2), or **Settings → GitHub**, uses GitHub's [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):

1. The server builds a manifest (`POST /api/github/manifest`, admin only). It contains:
   - the name, description and homepage
   - the webhook URL `PUBLIC_URL/api/github/webhook`, or `SMEE_URL`
   - the redirect URL `PUBLIC_URL/api/github/manifest/callback`
   - the setup URL `PUBLIC_URL/api/github/install/callback`
   - the permissions and events listed below
   - `public: false`
2. Your browser POSTs the manifest to `GITHUB_WEB_URL/settings/apps/new`, or to `GITHUB_WEB_URL/organizations/<org>/settings/apps/new` for an organization. A random `state` value protects the round trip.
3. You confirm on GitHub. GitHub redirects back with a temporary `code`. The server exchanges the code (`POST /app-manifests/{code}/conversions`) for:
   - the App ID, slug and name
   - the client ID and client secret
   - the private key (PEM)
   - the webhook secret
   - the HTML URL and owner
4. The client secret, private key and webhook secret are encrypted with AES-256-GCM under `MASTER_KEY` before they are stored (`github_apps.*_enc`). They are never returned by the API. The API only reports `"configured": true`.
5. Click **Install** and choose repositories. GitHub redirects to `/api/github/install/callback?installation_id=...`. The installation is recorded and its repositories become available for monitoring.

GitHub limits App names to 34 characters and requires them to be globally unique. If the name is taken, change it on the GitHub confirmation page.

## Permissions and why each is needed

| Permission (all read-only)   | Used for                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata: read`             | Mandatory for every App: repository list, names, default branch, visibility.                                                                                                                                                        |
| `contents: read`             | PR diffs and file contents (before/after) for analysis. Repository discovery (manifests, CI files, CODEOWNERS, docs). Shallow clones of the default branch for the symbol and contract index. Compare API for incremental analysis. |
| `pull_requests: read`        | PR metadata, changed files, commits, reviews, review decision, mergeable state, review-comment events.                                                                                                                              |
| `issues: read`               | Linked and closing issues, `issue_comment` events on PRs (PR conversations are issue comments), labels.                                                                                                                             |
| `checks: read`               | Check runs and check suites, for merge readiness and the CI summary in reports.                                                                                                                                                     |
| `statuses: read`             | Legacy commit statuses posted by external CI.                                                                                                                                                                                       |
| `actions: read`              | Workflow runs and workflow definitions, to explain CI failures and detect workflow changes.                                                                                                                                         |
| `security_events: read`      | Code-scanning alerts (and secret-scanning, where GitHub exposes it) to include in the Security section. Optional: if not granted, the API returns 403 and git-merge-pilot carries on.                                               |
| `vulnerability_alerts: read` | Dependabot alerts, to connect dependency changes in a PR to known vulnerabilities. Optional, handled the same way.                                                                                                                  |

**Webhook events:**

- `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`
- `check_run`, `check_suite`, `status`
- `push`, for default-branch changes that trigger re-discovery and re-indexing
- `repository`
- `installation` and `installation_repositories`, which GitHub sends to every App automatically, so they are not listed in the manifest

**Not requested:**

- any write permission
- `administration`, so branch protection is inferred from `mergeable_state` and `reviewDecision`
- members or organization permissions

## Manual creation

This version connects GitHub **only through the manifest flow** above: there is no screen or API for pasting App credentials by hand. If your organization restricts App creation, ask an organization owner to run the manifest flow from git-merge-pilot (or to allow you to create Apps). The result is an ordinary read-only GitHub App, and you can review or edit any of its settings on GitHub afterwards.

If the installation redirect didn't reach git-merge-pilot, click **Sync installations** (`POST /api/github/sync-installations`).

## Webhooks and reachability

GitHub must be able to POST to the webhook URL.

- **Public server:** with `PUBLIC_URL=https://gmp.example.com`, webhooks go to `https://gmp.example.com/api/github/webhook`. They need valid TLS. See [deployment.md](deployment.md).
- **Webhook handling:** every delivery is checked against `X-Hub-Signature-256` using HMAC-SHA256 and a timing-safe compare, before any parsing. The delivery is deduplicated by `X-GitHub-Delivery` and stored. The server then answers `202` straight away, and a worker processes it.
- **Safety net:** a reconciliation poll runs every 15 minutes. It lists the open PRs of each monitored repository and re-syncs any whose head SHA or update time changed. Missed webhooks therefore delay a report but never lose it.

### Local development: webhooks via smee

1. Open <https://smee.io/new> and copy the channel URL.
2. Put it in `.env` as `SMEE_URL=https://smee.io/<channel>` and restart the server.
3. Create the GitHub App **after** setting `SMEE_URL`. The manifest then uses the smee URL as its webhook URL. If the App already exists, edit its webhook URL on GitHub instead.
4. The server runs a built-in smee client that forwards events to its own `/api/github/webhook`. Signatures are still verified.

smee.io is a public relay. Anyone with the channel URL can read the payloads, which contain PR metadata and code snippets, though never your credentials. Use it for development and evaluation, not for production with private code.

## Reauthorize, rotate and disconnect

- **Permission changes:** if a future version needs another read permission, GitHub asks an org owner to approve the updated permissions on the installation. The wizard links to the installation page. Until it's approved, features that depend on the permission degrade gracefully.
- **Webhook secret rotation:** change the secret on GitHub (**App settings → Webhook secret**), then update it in **Settings → GitHub**. Deliveries signed with the old secret fail verification and are recorded as failed. The reconciliation poll covers the gap.
- **Private key rotation:** generate a new key on GitHub, upload it in **Settings → GitHub**, then delete the old key on GitHub.
- **Suspending or uninstalling on GitHub:** git-merge-pilot receives `installation` events and marks the installation suspended or removed. Repositories, PRs and history are **kept**, because `repositories.installation_id` becomes null rather than being deleted. They are not updated while disconnected.
- **Disconnect in git-merge-pilot:** **Settings → GitHub → Disconnect** (`DELETE /api/github/app`) deletes the stored App credentials. Historical data stays. To remove the App completely, also delete it on GitHub (**App settings → Advanced → Delete GitHub App**).

## GitHub Enterprise Server

GHES is **not officially supported in the MVP and is untested**. The base URLs are configurable:

```env
GITHUB_API_URL=https://ghes.example.com/api/v3
GITHUB_WEB_URL=https://ghes.example.com
```

The manifest flow requires GHES 3.x with GitHub App manifests enabled. Some endpoints, such as GraphQL closing references and code-scanning or Dependabot alerts, may be missing or differ by GHES version. git-merge-pilot treats missing features like missing permissions: the report states the limitation, and processing does not fail.
