# Setup guide: the first-time wizard

The wizard lives at `PUBLIC_URL/setup`. Until setup is finished, the only endpoints that answer without a login are the setup endpoints and the GitHub callbacks. Progress is saved after each step (`system_state.setup_step`), so you can close the browser and come back later.

Before you start:

- The stack is running ([installation.md](installation.md)) and `GET /healthz` succeeds.
- You have the **one-time setup link** from the server log (`docker compose logs server | grep -o 'http[^ ]*/setup?token=[^ ]*'`). The link has the setup token built in. It is printed on first boot, and only the token's hash is stored. If you lose it, see [troubleshooting.md](troubleshooting.md#lost-setup-token).
- Optional: set `GMP_SETUP_TOKEN` (16+ characters) in `.env` before the first start to choose the token yourself. It is then never printed; enter it on the setup page.
- If GitHub cannot reach `PUBLIC_URL` (laptop, private network), set `SMEE_URL` **before** step 2.

## Step 1: Admin account

Fill in your name, email and password. The time zone is detected from your browser and pre-selected; change it if it is wrong.

If you opened the setup link from the log, the setup token is filled in for you and removed from the address bar. If you opened `/setup` directly (or set `GMP_SETUP_TOKEN`), a **Setup token** field appears.

The request is `POST /api/setup/admin`. It creates the organization (named "My organization") and the first `admin` user, then signs you in. The setup token stops working after this step.

The time zone becomes the default for the daily digest and quiet hours. Users can override it later.

## Step 2: Connect GitHub

1. Choose where the GitHub App is created: your personal account, or an organization you administer. Enter the org login if it's an organization.
2. Click **Create GitHub App**. Your browser posts a pre-filled _manifest_ to GitHub. The manifest has read-only permissions and the webhook URL `PUBLIC_URL/api/github/webhook`, or your `SMEE_URL`.
3. On GitHub, check the name and click **Create GitHub App**. GitHub redirects back to `/api/github/manifest/callback`. git-merge-pilot exchanges the one-time code for the App's credentials (private key, webhook secret, client secret) and stores them encrypted with `MASTER_KEY`.
4. Click **Install**. On GitHub, choose **All repositories** or **Only select repositories**. GitHub redirects back to `/api/github/install/callback`, and the installation is recorded.

You can install the App on several accounts or organizations. Each installation shows up in the wizard. Use **Sync installations** if one is missing.

See [github-app.md](github-app.md) for the permission list, manual creation and troubleshooting.

## Step 3: Repositories and your first project

The wizard lists every repository that your installations can see (`GET /api/github/repositories`). In this step:

- Tick the repositories to monitor. Monitoring can be switched per repository later.
- Create the first project, for example "Checkout revamp", and add repositories to it. A repository can belong to several projects.
- Optionally invite project members now, or later under **Settings → Users**.

Nothing is hard-coded: projects, repositories and members are all yours to define.

## Step 4: AI (optional)

AI is **disabled by default**. git-merge-pilot works without it: reports are then built from deterministic analysis and marked "Generated without AI".

To enable AI:

1. **Read the data-flow screen.** It shows exactly what would be sent to the provider in each data mode:
   - `full`: PR text and redacted code diffs
   - `metadata_only`: PR text, paths and symbol names, but no code
   - `off`: nothing
     Secrets are always redacted, and `exclude_paths` are always removed.
2. **Add a provider.** This is either Anthropic, or any OpenAI-compatible endpoint (OpenAI, Azure, OpenRouter, LiteLLM, Ollama, vLLM). The API key is stored encrypted. Use **Test** to check connectivity.
3. **Choose a model per task.** The defaults are:

   | Task            | Default model       |
   | --------------- | ------------------- |
   | `triage`        | `claude-haiku-5-5`  |
   | `pr_report`     | `claude-sonnet-5-5` |
   | `deep_analysis` | `claude-opus-5-5`   |
   | `digest`        | `claude-haiku-5-5`  |

4. **Set a monthly budget.** The default is $100, with an alert at 80%. At 100%, AI calls stop and reports fall back to deterministic analysis with a visible "AI budget reached" banner.
5. **Give consent.** Your consent is recorded with your user and a timestamp (`ai_settings.consent_at` and `consent_by`).

Details: [ai-providers.md](ai-providers.md).

## Step 5: Notifications

- **In-app** notifications are always available.
- **Email**: enter your SMTP host, port, TLS setting, username, password and from address. Emails go to each recipient's own account address: admins, plus the members of the project the notification is about. Use **Test** to send a test message (to the optional test address, or to you).
- **Slack**: paste an incoming webhook URL (`https://hooks.slack.com/services/…`). Other hosts are rejected unless the operator allows them with `GMP_SLACK_EXTRA_WEBHOOK_HOSTS`. Use **Test** to post a test message.
- **Rules**: set these for the organization default, and optionally per project:
  - minimum severity (default `high`)
  - which events to send
  - which channels to use
  - quiet hours (non-critical notifications are deferred until they end)
  - the daily digest hour and timezone

Secrets are write-only. After you save, the UI only shows "configured".

## Step 6: Review repository profiles

For each selected repository, git-merge-pilot reads the default branch through the API and builds a profile with:

- languages, frameworks, build tools and package managers
- test frameworks and CI workflows
- security tools
- CODEOWNERS, PR template, contributing and architecture docs
- monorepo packages

Check them and correct anything that's wrong (the **overrides**). Better profiles mean better reports. For example, telling git-merge-pilot which directory holds migrations improves database risk detection.

You can also set two things per repository:

- `ai_mode`: `full`, `metadata_only` or `off`
- `exclude_paths`: globs that are never analysed by AI, such as `secrets/**` or `customer-data/**`

## Step 7: Start monitoring

Click **Start monitoring**. git-merge-pilot then does the following:

- queues discovery and indexing for each repository, using shallow clones of the default branch to build the symbol and contract index
- syncs every open PR and analyses it
- turns on webhook processing and the 15-minute reconciliation poll

The first full analysis of a large organization can take a while. Progress and any failures are shown under **Settings → System status**.

## After setup

- Invite people: **Settings → Users → Invite**. Invite links expire. Members see only the projects they belong to.
- Read the [user guide](user-guide.md) to understand reports.
- Set up [backups](backup-recovery.md), and store `MASTER_KEY` somewhere safe **today**.
