# Backup and recovery

There are two things you need in order to restore git-merge-pilot:

1. **The Postgres database.** It holds all data, settings, encrypted credentials and the job queue.
2. **`MASTER_KEY`.** It is the only key that can decrypt the stored credentials.

You don't need to back up the repository cache (`/data/repos`). It is rebuilt automatically.

> **Warning: `MASTER_KEY`.** Store it in a password manager or secret manager, **separately from database backups**. If you have the database but lose the key, everything else still works, but the following are unrecoverable and must be re-entered:
>
> - the GitHub App private key and webhook secret (you'll need to re-create or reconnect the App)
> - AI keys
> - SMTP passwords and Slack URLs
>
> If an attacker gets the database backup but not the key, your credentials stay protected. Keep it that way.

Also keep `SESSION_SECRET`. Losing it only logs everyone out.

## Scheduled `pg_dump`

Here is a daily logical backup using the compose stack, run from cron on the host:

```bash
#!/bin/sh
# /opt/git-merge-pilot/backup.sh: daily database backup, keeps 14 days
set -eu
cd /opt/git-merge-pilot
BACKUP_DIR=/var/backups/git-merge-pilot
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "$BACKUP_DIR/gmp-$STAMP.dump"
find "$BACKUP_DIR" -name 'gmp-*.dump' -mtime +14 -delete
```

```cron
# crontab -e
15 2 * * * /opt/git-merge-pilot/backup.sh >> /var/log/gmp-backup.log 2>&1
```

Recommendations:

- Copy dumps off the host, for example with `rclone` or `restic` to object storage, and encrypt them at rest.
- Test a restore regularly. A backup you have never restored is not a backup.
- For managed Postgres (RDS, Cloud SQL, Fly, Railway), enable the provider's automated backups and point-in-time recovery. A periodic `pg_dump` is still useful for portability.
- Dumps include the pg-boss job tables, which hold the queue state. That's fine: idempotent jobs are retried after a restore.

## Restore

```bash
cd /opt/git-merge-pilot
docker compose stop server worker

# recreate an empty database
docker compose exec -T postgres sh -c \
  'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

# load the dump
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' \
  < /var/backups/git-merge-pilot/gmp-YYYYMMDDTHHMMSSZ.dump

# make sure .env has the SAME MASTER_KEY as when the backup was taken, then:
docker compose up -d       # migrate applies any newer migrations first
```

After the restore:

- Open **Settings → GitHub** and check that the App shows as connected. If it says the credentials cannot be decrypted, `MASTER_KEY` doesn't match.
- Webhooks that arrived while the server was down are covered by the 15-minute reconciliation poll. You can also redeliver them from the App's **Advanced** tab on GitHub.
- The repository cache refills on the next index.

## Moving to a new server

1. Take a fresh dump on the old server, then stop it.
2. Copy the dump and `.env` (with `MASTER_KEY`, `SESSION_SECRET` and `POSTGRES_PASSWORD`) to the new server.
3. On the new server, run `docker compose up -d postgres`. Restore as described above, then `docker compose up -d`.
4. Point DNS at the new server. If `PUBLIC_URL` changes, update the GitHub App's webhook URL and setup URL on GitHub.

## Disaster scenarios

| Situation                                  | Recovery                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost the database, have the key and a dump | Restore the dump. Reconciliation catches up on PRs                                                                                                              |
| Lost the database and every dump           | Fresh install: re-run setup and reconnect GitHub. Open PRs are analysed again. History is lost                                                                  |
| Lost `MASTER_KEY`, database intact         | Disconnect GitHub, then re-create or reconnect the App. Delete and re-add AI providers and notification channels. Set a new `MASTER_KEY` first. History is kept |
| Repository cache corrupted                 | `docker compose down`, then `docker volume rm <project>_repo-cache`, then `up -d`. It rebuilds                                                                  |
