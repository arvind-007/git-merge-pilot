# Security policy

git-merge-pilot handles source code and credentials, so we take security reports seriously.

## Supported versions

Security fixes are made on the latest release and on `main`. Self-hosters should upgrade promptly:

```bash
git pull && docker compose up -d --build
```

## Reporting a vulnerability

**Please do not open a public issue.** Instead:

1. Use GitHub's **private vulnerability reporting** for this repository (**Security → Report a vulnerability**).
2. Include:
   - the affected version or commit
   - the impact
   - the steps to reproduce
   - any suggested fix

   Do not include real credentials or private code. Redact them.

We aim to acknowledge reports within 3 business days and to provide a fix or mitigation plan within 30 days for high-severity issues. Once a fix is available, we will coordinate disclosure with you and credit you if you wish.

## Scope

**In scope**, for example:

- authentication, session, CSRF or authorization bypass, including members accessing other projects' data
- webhook signature bypass
- disclosure of stored credentials (GitHub App key, AI keys, SMTP and Slack secrets) through the API, logs, the UI or errors
- weaknesses in credential encryption or `MASTER_KEY` handling
- prompt injection that leads to:
  - data exfiltration
  - actions
  - misleading "verified" findings
- XSS through PR content or AI output
- any path by which git-merge-pilot could write to GitHub
- secrets that reach an AI provider despite redaction or `exclude_paths`

**Out of scope:**

- issues that require a compromised host, database superuser or malicious admin
- findings in third-party services
- missing hardening on deployments that ignore [docs/security.md](docs/security.md), such as plain HTTP or an exposed Postgres
- false positives or negatives of analysis rules, unless they have a security impact. Please report those as normal issues.

## Security design

For the threat model, credential encryption, webhook verification, prompt-injection defenses, the data flow table and retention, see [docs/security.md](docs/security.md).
