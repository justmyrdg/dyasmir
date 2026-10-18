#!/usr/bin/env bash
# Sets up, or updates, JASthinkAboutIT on an Amazon Linux 2023 EC2 instance:
#   - Node.js, and PostgreSQL when DATABASE_URL points at this machine (user and database created from it)
#   - the app built in /opt/jasthinkaboutit and run as a systemd service (website + API on one address)
#   - Caddy in front, with a free HTTPS certificate for your domain
#   - swap for the frontend build on small instances, and a nightly database backup
#
# Everything except backend/.env, which you fill in first (see backend/.env.production.example).
#
# Usage, from the project folder copied to the instance:
#   sudo bash deploy/setup-ec2.sh quiz.yourschool.edu
# Run it again after copying in new code: it rebuilds, applies new migrations and restarts.
set -euo pipefail

DOMAIN="${1:-}"
NODE_VERSION=22.23.1
CADDY_VERSION=2.10.0

APP_NAME=jasthinkaboutit
APP_USER=quiz
APP_DIR=/opt/$APP_NAME
APP_HOME=/var/lib/$APP_NAME
BACKUP_DIR=/var/backups/$APP_NAME
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SRC_DIR/backend/.env"
export PATH="/usr/local/bin:$PATH"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWarning: %s\033[0m\n' "$*" >&2; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
# Runs a command as the app user with a clean environment (no NODE_ENV leaking into npm ci, no Angular prompts).
as_app() { runuser -u "$APP_USER" -- env -i HOME="$APP_HOME" PATH="/usr/local/bin:/usr/bin:/bin" NG_CLI_ANALYTICS=false bash -c "$1"; }
# Reads one value from backend/.env the same way the app does.
env_get() { env -i /usr/local/bin/node -e 'process.loadEnvFile(process.argv[1]); process.stdout.write(process.env[process.argv[2]] ?? "")' "$ENV_FILE" "$1"; }

# ---------------------------------------------------------------------------- checks

[[ $EUID -eq 0 ]] || die "Run it with sudo: sudo bash deploy/setup-ec2.sh <your domain>"
[[ -n $DOMAIN ]] || die "Give the site's domain name: sudo bash deploy/setup-ec2.sh quiz.yourschool.edu"
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]] || die "\"$DOMAIN\" is not a domain name (no https://, no slashes)."
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == amzn && ${VERSION_ID:-} == 2023 ]] || die "This script is for Amazon Linux 2023 (this machine is ${PRETTY_NAME:-unknown})."
[[ -f $ENV_FILE ]] || die "Create $ENV_FILE first: cp backend/.env.production.example backend/.env, then fill it in."
[[ -f $SRC_DIR/backend/package.json && -f $SRC_DIR/frontend/package.json ]] || die "Run this from the project folder (backend/ and frontend/ not found in $SRC_DIR)."

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

# ---------------------------------------------------------------------------- system packages and swap

log "Installing system packages"
dnf install -y -q rsync tar gzip

if [[ -z $(swapon --show --noheadings) ]] && (( $(awk '/^MemTotal/ {print $2}' /proc/meminfo) < 3000000 )); then
  log "Adding 2 GB of swap (building the frontend needs more memory than small instances have)"
  [[ -f /swapfile ]] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------------------- Node.js

if [[ $(/usr/local/bin/node --version 2>/dev/null || true) != "v$NODE_VERSION" ]]; then
  log "Installing Node.js $NODE_VERSION"
  tmp=$(mktemp -d)
  name="node-v$NODE_VERSION-linux-$NODE_ARCH"
  curl -fsSL -o "$tmp/$name.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.tar.gz\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node.js download failed its checksum."
  mkdir -p /usr/local/lib/nodejs
  rm -rf "/usr/local/lib/nodejs/$name"
  tar -xzf "$tmp/$name.tar.gz" -C /usr/local/lib/nodejs
  for bin in node npm npx; do ln -sf "/usr/local/lib/nodejs/$name/bin/$bin" "/usr/local/bin/$bin"; done
  rm -rf "$tmp"
fi

# ---------------------------------------------------------------------------- read and check backend/.env

[[ $(env_get NODE_ENV) == production ]] || die "Set NODE_ENV=production in backend/.env (it makes the sign-in cookie HTTPS-only)."
JWT_SECRET=$(env_get JWT_ACCESS_SECRET)
[[ ${#JWT_SECRET} -ge 32 && $JWT_SECRET != *CHANGE_ME* && $JWT_SECRET != *change-me* ]] \
  || die "Set JWT_ACCESS_SECRET in backend/.env to a long random value: openssl rand -hex 48"
[[ $(env_get FRONTEND_URL) == "https://$DOMAIN" ]] || warn "FRONTEND_URL in backend/.env should be https://$DOMAIN"
PORT=$(env_get PORT); PORT=${PORT:-3000}
[[ -n $(env_get DATABASE_URL) ]] || die "Set DATABASE_URL in backend/.env."
[[ $(env_get DATABASE_URL) != *CHANGE_ME* ]] || die "Replace CHANGE_ME in DATABASE_URL with a database password: openssl rand -hex 24"

mapfile -t DB < <(env -i /usr/local/bin/node -e '
  process.loadEnvFile(process.argv[1]);
  const u = new URL(process.env.DATABASE_URL);
  const d = decodeURIComponent;
  console.log([u.hostname, u.port || "5432", d(u.pathname.slice(1)), d(u.username), d(u.password)].join("\n"));
' "$ENV_FILE")
DB_HOST=${DB[0]:-}; DB_NAME=${DB[2]:-}; DB_USER=${DB[3]:-}; DB_PASS=${DB[4]:-}
[[ -n $DB_HOST && -n $DB_NAME && -n $DB_USER && -n $DB_PASS ]] \
  || die "DATABASE_URL in backend/.env must look like postgresql://user:password@localhost:5432/database"
LOCAL_DB=false
[[ $DB_HOST == localhost || $DB_HOST == 127.0.0.1 || $DB_HOST == "[::1]" ]] && LOCAL_DB=true

# ---------------------------------------------------------------------------- PostgreSQL (only when it runs here)

if $LOCAL_DB; then
  if ! rpm -qa 'postgresql*-server' | grep -q .; then
    log "Installing PostgreSQL"
    installed=false
    for v in 17 16 15; do
      if dnf install -y -q "postgresql$v-server" "postgresql$v" 2>/dev/null; then installed=true; break; fi
    done
    $installed || die "Could not install PostgreSQL from the Amazon Linux repositories."
  fi
  PGDATA=/var/lib/pgsql/data
  [[ -f $PGDATA/PG_VERSION ]] || postgresql-setup --initdb
  # The app connects over TCP with a password; Amazon Linux defaults those connections to "ident".
  sed -ri 's/^(host\s+all\s+all\s+(127\.0\.0\.1\/32|::1\/128)\s+)\S+/\1scram-sha-256/' "$PGDATA/pg_hba.conf"
  systemctl enable --now postgresql
  systemctl reload postgresql

  log "Creating database user \"$DB_USER\" and database \"$DB_NAME\" (from DATABASE_URL)"
  (cd /tmp && runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -v u="$DB_USER" -v p="$DB_PASS" -v d="$DB_NAME") <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'u') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'u', :'p') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'d', :'u') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'d') \gexec
SQL
else
  log "DATABASE_URL points at $DB_HOST, so PostgreSQL is not installed here"
fi

# ---------------------------------------------------------------------------- copy and build the app

log "Copying the app to $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_HOME" --create-home --shell /sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
if [[ $SRC_DIR != "$APP_DIR" ]]; then
  # Build output and dependencies are made on the server, never copied (a Windows node_modules won't run here).
  rsync -a --delete --exclude node_modules/ --exclude dist/ --exclude .angular/ --exclude .git/ --exclude coverage/ \
    "$SRC_DIR/" "$APP_DIR/"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/backend/.env"

log "Building the backend"
as_app "cd '$APP_DIR/backend' && npm ci --no-audit --no-fund && npx prisma generate && npm run build"

log "Building the frontend"
as_app "cd '$APP_DIR/frontend' && npm ci --no-audit --no-fund && npm run build"

log "Applying database migrations"
as_app "cd '$APP_DIR/backend' && npx prisma migrate deploy && npm run db:seed"

# ---------------------------------------------------------------------------- app service

log "Starting the app"
cat > /etc/systemd/system/$APP_NAME.service <<EOF
[Unit]
Description=JASthinkAboutIT (quiz website and API)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/backend
Environment=NODE_ENV=production
Environment=FRONTEND_DIST_DIR=$APP_DIR/frontend/dist/frontend/browser
Environment=TRUST_PROXY=1
ExecStart=/usr/local/bin/node dist/src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $APP_NAME >/dev/null 2>&1
systemctl restart $APP_NAME
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || die "The app did not start. See what went wrong with: journalctl -u $APP_NAME -n 50"

# ---------------------------------------------------------------------------- Caddy (HTTPS)

if [[ $(/usr/local/bin/caddy version 2>/dev/null | awk '{print $1}' || true) != "v$CADDY_VERSION" ]]; then
  log "Installing Caddy $CADDY_VERSION"
  tmp=$(mktemp -d)
  name="caddy_${CADDY_VERSION}_linux_$CADDY_ARCH.tar.gz"
  base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  curl -fsSL -o "$tmp/$name" "$base/$name"
  curl -fsSL -o "$tmp/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$tmp" && grep " $name\$" checksums.txt | sha512sum -c --quiet -) || die "Caddy download failed its checksum."
  tar -xzf "$tmp/$name" -C "$tmp" caddy
  install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
id -u caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy

log "Setting up HTTPS for $DOMAIN"
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || die "The Caddy configuration is invalid: /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile"
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS in front of JASthinkAboutIT)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1
systemctl reload-or-restart caddy

# ---------------------------------------------------------------------------- nightly backups

if $LOCAL_DB; then
  log "Scheduling a nightly database backup (2:00 AM Manila time, kept 14 days, in $BACKUP_DIR)"
  install -d -m 700 -o postgres -g postgres "$BACKUP_DIR"
  cat > /usr/local/bin/$APP_NAME-backup <<'EOF'
#!/usr/bin/env bash
# Database backup, run nightly by jasthinkaboutit-backup.timer. Keeps 14 days.
# Restore one: gunzip -c FILE.sql.gz | sudo -u postgres psql DB_NAME
set -euo pipefail
dir=/var/backups/jasthinkaboutit
file="$dir/$DB_NAME-$(date +%Y-%m-%d_%H%M).sql.gz"
pg_dump "$DB_NAME" | gzip > "$file.part"
mv "$file.part" "$file"
find "$dir" -name '*.sql.gz' -mtime +14 -delete
EOF
  chmod 755 /usr/local/bin/$APP_NAME-backup
  cat > /etc/systemd/system/$APP_NAME-backup.service <<EOF
[Unit]
Description=JASthinkAboutIT database backup

[Service]
Type=oneshot
User=postgres
UMask=0077
Environment=DB_NAME=$DB_NAME
ExecStart=/usr/local/bin/$APP_NAME-backup
EOF
  cat > /etc/systemd/system/$APP_NAME-backup.timer <<EOF
[Unit]
Description=Nightly JASthinkAboutIT database backup

[Timer]
OnCalendar=*-*-* 02:00:00 Asia/Manila
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now $APP_NAME-backup.timer >/dev/null 2>&1
fi

# ---------------------------------------------------------------------------- done

cat <<EOF

$(printf '\033[1;32m')Done.$(printf '\033[0m') The site will be at https://$DOMAIN once your domain points at this server
(Caddy gets the HTTPS certificate on the first visit; ports 80 and 443 must be open).

First time only, create the teacher account:
  sudo runuser -u $APP_USER -- bash -c 'cd $APP_DIR/backend && /usr/local/bin/node dist/scripts/create-teacher.js --email you@school.edu --name "Your Name"'

Load quizzes from a JSON file (put it in backend/data/ before running this script):
  sudo runuser -u $APP_USER -- bash -c 'cd $APP_DIR/backend && /usr/local/bin/node dist/scripts/seed-quizzes.js data/your-quizzes.json'

Useful:
  journalctl -u $APP_NAME -f     app log
  journalctl -u caddy -f               HTTPS / certificate log
  sudo ls $BACKUP_DIR      database backups
  Changed backend/.env or the code? Edit it in $SRC_DIR and run this script again.
EOF
