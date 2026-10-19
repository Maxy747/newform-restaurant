#!/usr/bin/env bash
# Nightly encrypted backup of the Newform Supabase database (plus menu/gallery photos) to the NAS.
# Runs on Dosimeter from newform-backup.timer. Settings come from /etc/newform-backup.env
# (see newform-backup.env.example); nothing secret lives in this file.
#
# Each run:
#   1. pings oms-api so the Free-plan project never counts as idle (optional),
#   2. dumps the public, auth and storage schemas with pg_dump 17 (custom format),
#   3. checks the dump really contains the core tables,
#   4. encrypts it with age (only the offline private key can read it) and writes it to the NAS,
#   5. mirrors new photos from the public storage buckets,
#   6. deletes dated backups past their retention.
set -Eeuo pipefail
umask 077

: "${NEWFORM_DB_URL:?Set NEWFORM_DB_URL (session pooler URL without the password)}"
: "${NEWFORM_DB_PASSWORD:?Set NEWFORM_DB_PASSWORD}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT (age public key, age1...)}"
: "${BACKUP_DIR:?Set BACKUP_DIR (a folder on the mounted NAS share)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
MONTHLY_KEEP_DAYS="${MONTHLY_KEEP_DAYS:-365}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
STORAGE_PUBLIC_URL="${STORAGE_PUBLIC_URL:-}"
PHOTO_BUCKETS="${PHOTO_BUCKETS:-menu-images gallery-photos}"
KEEPALIVE_URL="${KEEPALIVE_URL:-}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
LOCK_FILE="${LOCK_FILE:-/run/lock/newform-backup.lock}"
# Tables that must be in every dump; an empty or partial dump fails the run instead of replacing good backups.
REQUIRED_TABLES="${REQUIRED_TABLES:-menu_items menu_categories orders checkout_settings}"

# Logs go to stderr (journald keeps both streams) so a failure inside `pg_dump > file` is not
# written into the dump file instead of the log.
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >&2; }
ping_healthcheck() { if [ -n "$HEALTHCHECK_URL" ]; then curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL}$1" || true; fi; }
fail() { log "FAILED: $*"; ping_healthcheck /fail; exit 1; }
trap 'fail "line $LINENO: $BASH_COMMAND"' ERR

for tool in age curl findmnt flock; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another backup is already running"

# Refuse to write onto the local disk when the NAS share is not mounted.
[ -d "$BACKUP_DIR" ] || fail "$BACKUP_DIR does not exist (is the NAS mounted?)"
[ "$(findmnt -n -o TARGET -T "$BACKUP_DIR")" != "/" ] || fail "$BACKUP_DIR is on the root filesystem, not the NAS share"
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/photos"

# Runs a PostgreSQL client tool (pg_dump, pg_restore, psql) of version 17+, from the host if it
# has one, otherwise from the official postgres image. The password travels in PGPASSWORD,
# never on the command line.
export PGPASSWORD="$NEWFORM_DB_PASSWORD" PGCONNECT_TIMEOUT=30
pg_tool() {
  local tool=$1; shift
  if command -v "$tool" >/dev/null && [ "$("$tool" --version | grep -oE '[0-9]+' | head -1)" -ge 17 ]; then
    "$tool" "$@"
  else
    command -v docker >/dev/null || fail "need $tool 17+ or docker"
    docker run --rm -i --network host -e PGPASSWORD -e PGCONNECT_TIMEOUT "$PG_IMAGE" "$tool" "$@"
  fi
}

ping_healthcheck /start

if [ -n "$KEEPALIVE_URL" ]; then
  if curl -fsS -m 20 --retry 2 -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"action":"config"}' "$KEEPALIVE_URL"; then
    log "keep-alive ok"
  else
    log "WARNING: keep-alive request failed"
  fi
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stamp=$(date +%Y-%m-%d_%H%M)
name="newform-$stamp.dump"

log "dumping database"
pg_tool pg_dump --dbname="$NEWFORM_DB_URL" --format=custom --compress=9 --no-owner --no-privileges \
  --schema=public --schema=auth --schema=storage > "$work/$name"

pg_tool pg_restore --list < "$work/$name" > "$work/contents"
for table in $REQUIRED_TABLES; do
  grep -qE "TABLE DATA public $table " "$work/contents" || fail "dump is missing table data for public.$table"
done
log "dump ok: $(du -h "$work/$name" | cut -f1), $(grep -c 'TABLE DATA' "$work/contents") tables with data"

age --recipient "$AGE_RECIPIENT" --output "$BACKUP_DIR/db/$name.age.partial" "$work/$name"
mv "$BACKUP_DIR/db/$name.age.partial" "$BACKUP_DIR/db/$name.age"
(cd "$BACKUP_DIR/db" && sha256sum "$name.age" > "$name.age.sha256")
log "saved $BACKUP_DIR/db/$name.age"

# Photos are public and never change once uploaded (random file names), so only new ones are fetched.
if [ -n "$STORAGE_PUBLIC_URL" ]; then
  read -ra bucket_list <<< "$PHOTO_BUCKETS"
  buckets=$(printf "'%s'," "${bucket_list[@]}")
  pg_tool psql --dbname="$NEWFORM_DB_URL" --no-psqlrc --tuples-only --no-align \
    --command="select bucket_id || '/' || name from storage.objects where bucket_id in (${buckets%,}) order by 1" > "$work/photos"
  fetched=0
  while IFS= read -r path; do
    [ -n "$path" ] && [ ! -s "$BACKUP_DIR/photos/$path" ] || continue
    mkdir -p "$(dirname "$BACKUP_DIR/photos/$path")"
    if curl -fsS -m 120 --retry 2 -o "$BACKUP_DIR/photos/$path.partial" "$STORAGE_PUBLIC_URL/$path"; then
      mv "$BACKUP_DIR/photos/$path.partial" "$BACKUP_DIR/photos/$path"
      fetched=$((fetched + 1))
    else
      rm -f "$BACKUP_DIR/photos/$path.partial"
      log "WARNING: could not download photo $path"
    fi
  done < "$work/photos"
  log "photos: $(grep -c . "$work/photos" || true) in storage, $fetched new"
fi

# Retention runs only after a successful backup: daily copies for RETENTION_DAYS, and the
# first backup of each month for MONTHLY_KEEP_DAYS.
find "$BACKUP_DIR/db" -maxdepth 1 -name 'newform-*.dump.age*' ! -name 'newform-????-??-01_*' -mtime +"$RETENTION_DAYS" -print -delete
find "$BACKUP_DIR/db" -maxdepth 1 -name 'newform-????-??-01_*.dump.age*' -mtime +"$MONTHLY_KEEP_DAYS" -print -delete

ping_healthcheck ""
log "backup complete"
