# Newform nightly backup to the NAS

Runs on **Dosimeter** every night at 03:30 and saves an **encrypted** copy of the Newform
database (plus the menu and gallery photos) to **NASig**. The Supabase Free plan has no
backups of its own; this is the restaurant's backup.

What each run does (`newform-backup.sh`):

1. Pings `oms-api` so the Free project is never paused for inactivity.
2. `pg_dump` (PostgreSQL 17) of the `public`, `auth` and `storage` schemas: orders, menu,
   settings, staff logins and photo records.
3. Checks the dump really contains the core tables; a broken dump fails the run and never
   replaces older good backups.
4. Encrypts it with [age](https://age-encryption.org). Only the private key, kept **off**
   Dosimeter, can read it. It contains customers' names, phones and addresses.
5. Mirrors any new photos from the public storage buckets.
6. Keeps 30 days of daily backups plus the 1st-of-month backup for a year.

It refuses to run if `BACKUP_DIR` is not on the mounted NAS share, so it never silently fills
Dosimeter's own disk.

```
<BACKUP_DIR>/
  db/newform-2026-10-20_0330.dump.age          encrypted dump
  db/newform-2026-10-20_0330.dump.age.sha256   checksum of the encrypted file
  photos/menu-images/...                       photo mirror
  photos/gallery-photos/...
```

## Install on Dosimeter

1. **Tools.** `pg_dump` must be version 17 (the Supabase server is 17). Docker is already
   installed for Immich, so the script uses the `postgres:17` image automatically.

   ```bash
   sudo apt install age curl
   ```

2. **Encryption key.** Make the key, copy the private key somewhere safe *off* Dosimeter
   (password manager or USB drive), then delete it here. Only the public key stays.

   ```bash
   age-keygen -o newform-backup.key
   ```

   Note the printed `Public key: age1...`. Store `newform-backup.key` safely. Without it,
   **no backup can be restored**. Then remove it from Dosimeter:

   ```bash
   shred -u newform-backup.key
   ```

3. **Backup folder on NASig.** Use the share Dosimeter already mounts (it must mount at boot,
   from `/etc/fstab`). Example:

   ```bash
   sudo mkdir -p /mnt/nasig/backups/newform
   ```

4. **Database password.** Supabase Dashboard → Project Settings → Database. If you don't know
   it, reset it there (the website and `oms-api` don't use it, so nothing else breaks).

5. **Install the files** (from a checkout of this repo, in `ops/nas-backup`):

   ```bash
   sudo install -m 755 newform-backup.sh /usr/local/bin/newform-backup.sh
   sudo install -m 644 newform-backup.service newform-backup.timer /etc/systemd/system/
   sudo install -m 600 -o root -g root newform-backup.env.example /etc/newform-backup.env
   sudo nano /etc/newform-backup.env
   ```

   Fill in `NEWFORM_DB_PASSWORD`, `AGE_RECIPIENT` (the `age1...` public key) and `BACKUP_DIR`.

6. **Optional failure alerts.** Create a free check at healthchecks.io (period 1 day, grace
   2 hours) and paste its ping URL into `HEALTHCHECK_URL`. You get an email if a backup fails
   or does not run.

7. **First run, then schedule it:**

   ```bash
   sudo timedatectl set-timezone Asia/Kolkata
   sudo systemctl daemon-reload
   sudo systemctl start newform-backup.service
   journalctl -u newform-backup -n 30 --no-pager
   sudo systemctl enable --now newform-backup.timer
   systemctl list-timers newform-backup.timer
   ```

## Restore

Practise this on a throwaway database first (and once a month as a drill). On a machine that
has the private key:

```bash
sha256sum -c newform-2026-10-20_0330.dump.age.sha256
age -d -i newform-backup.key newform-2026-10-20_0330.dump.age > newform.dump
docker run -d --name newform-restore -e POSTGRES_PASSWORD=restore -p 55432:5432 postgres:17
docker exec -i newform-restore pg_restore -U postgres -d postgres --no-owner < newform.dump
docker exec newform-restore psql -U postgres -c "select count(*) from public.orders"
```

`schema "public" already exists` is expected and harmless.

To restore **into Supabase** (a new or wiped project): apply the repo's migrations first
(`npx supabase db push`), then load only the data:

```bash
pg_restore --data-only --no-owner --schema=public --dbname="<session pooler URL>" newform.dump
```

Staff logins live in `auth.users`; restore them the same way with `--schema=auth --table=users`
before the `public` data. Photos are in `photos/` and can be re-uploaded to the matching buckets.

## Later: second copy in Cloudflare R2

The NAS copy fails if the home internet or power is out. A second copy of `db/` in Cloudflare
R2 (10 GB free) covers that and will be added once the Cloudflare account is set up.
