#!/usr/bin/env bash
# Deploy (or update) the proposals app on an Ubuntu server over SSH.
#
#   ./deploy/deploy.sh ubuntu@103.234.238.50                 # deploy / update
#   ./deploy/deploy.sh ubuntu@103.234.238.50 --domain proposals.samansamnuek.com   # also set up nginx + HTTPS
#
# Needs on your machine: ssh access to the server (key-based), rsync, node (only on the first run, to hash the password).
# Safe to run again: it never touches the server's .env or data folder after the first run.
set -euo pipefail

TARGET="${1:-}"
[[ -z "$TARGET" ]] && { echo "Usage: $0 user@host [--domain example.com] [--email you@example.com]"; exit 1; }
shift
DOMAIN=""; EMAIL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

APP_DIR="${APP_DIR:-/home/${TARGET%@*}/samansamnuek-proposals}"
DATA_DIR="${DATA_DIR:-/home/${TARGET%@*}/samansamnuek-proposals-data}"
PORT="${PORT:-3000}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -o StrictHostKeyChecking=accept-new $TARGET"

echo "==> Checking SSH to $TARGET"
$SSH 'echo ok' >/dev/null

echo "==> Installing Node.js 20, rsync and pm2 on the server if missing"
$SSH 'bash -s' <<'REMOTE'
set -e
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v rsync >/dev/null || sudo apt-get install -y rsync
command -v pm2 >/dev/null || sudo npm install -g pm2
REMOTE

echo "==> Uploading code to $APP_DIR"
$SSH "mkdir -p '$APP_DIR' '$DATA_DIR'"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude .git --exclude '*.zip' \
  "$HERE/" "$TARGET:$APP_DIR/"

if ! $SSH "test -f '$APP_DIR/.env'"; then
  echo "==> First deploy: creating .env on the server"
  read -r -s -p "Choose the admin password (10+ characters): " PW; echo
  [[ ${#PW} -lt 10 ]] && { echo "Password too short"; exit 1; }
  HASH_LINE="$(cd "$HERE" && node scripts/hash-password.js "$PW" 2>/dev/null | grep ADMIN_PASSWORD_HASH)"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  HOST_BIND="0.0.0.0"; [[ -n "$DOMAIN" ]] && HOST_BIND="127.0.0.1"
  $SSH "cat > '$APP_DIR/.env' && chmod 600 '$APP_DIR/.env'" <<ENV
PORT=$PORT
HOST=$HOST_BIND
$HASH_LINE
SESSION_SECRET=$SECRET
SESSION_HOURS=12
BASE_PATH=
TRUST_PROXY=1
DATA_DIR=$DATA_DIR
ENV
fi

echo "==> Installing dependencies and (re)starting with pm2"
$SSH "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund && pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save >/dev/null && sleep 2"

if [[ -n "$DOMAIN" ]]; then
  echo "==> Setting up nginx + HTTPS for $DOMAIN"
  $SSH "DOMAIN='$DOMAIN' EMAIL='$EMAIL' PORT='$PORT' bash -s" <<'REMOTE'
set -e
command -v nginx >/dev/null || sudo apt-get install -y nginx
CONF=/etc/nginx/sites-available/samansamnuek-proposals
if [ ! -f "$CONF" ]; then
  sudo tee "$CONF" >/dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  sudo ln -sf "$CONF" /etc/nginx/sites-enabled/samansamnuek-proposals
  sudo nginx -t && sudo systemctl reload nginx
fi
if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  command -v certbot >/dev/null || sudo apt-get install -y certbot python3-certbot-nginx
  if [ -n "$EMAIL" ]; then sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  else sudo certbot --nginx -d "$DOMAIN" --redirect; fi
fi
REMOTE
fi

echo "==> Health check"
# Read PORT/BASE_PATH from the server's .env: they may differ from this run's defaults after the first deploy.
$SSH "cd '$APP_DIR' && P=\$(grep -E '^PORT=' .env | cut -d= -f2) && B=\$(grep -E '^BASE_PATH=' .env | cut -d= -f2) && curl -fsS http://127.0.0.1:\${P:-3000}\${B%/}/healthz" && echo
echo
echo "Done."
if [[ -n "$DOMAIN" ]]; then echo "Backend: https://$DOMAIN/admin"
else echo "Backend: http://${TARGET#*@}:$PORT/admin   (plain HTTP — add --domain to get HTTPS before sharing links)"; fi
echo "Tip: run once on the server to survive reboots:  pm2 startup  (then run the command it prints)"
