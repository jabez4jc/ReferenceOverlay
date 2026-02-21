#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (example: sudo bash scripts/install_ubuntu_server.sh)"
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer is intended for Ubuntu/Debian systems with apt-get."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_REPO_URL="https://github.com/jabez4jc/Overlay"
REPO_URL="${DEFAULT_REPO_URL}"
BRANCH="main"

if [[ -d "${REPO_ROOT}/.git" ]]; then
  if git -C "${REPO_ROOT}" remote get-url origin >/dev/null 2>&1; then
    REPO_URL="$(git -C "${REPO_ROOT}" remote get-url origin)"
  fi
  if git -C "${REPO_ROOT}" symbolic-ref --short HEAD >/dev/null 2>&1; then
    BRANCH="$(git -C "${REPO_ROOT}" symbolic-ref --short HEAD)"
  fi
fi

APP_DIR="/opt/overlay"
APP_USER="overlay"
APP_PORT="3333"
SERVICE_NAME="overlay"

prompt() {
  local label="$1"
  local default="$2"
  local value
  read -r -p "${label} [${default}]: " value
  if [[ -z "${value}" ]]; then
    value="${default}"
  fi
  echo "${value}"
}

confirm() {
  local label="$1"
  local default="${2:-y}"
  local value
  local hint="Y/n"
  if [[ "${default}" == "n" ]]; then hint="y/N"; fi
  read -r -p "${label} (${hint}): " value
  value="${value,,}"
  if [[ -z "${value}" ]]; then value="${default}"; fi
  [[ "${value}" == "y" || "${value}" == "yes" ]]
}

echo "=== Overlay Ubuntu Server Installer ==="
echo

echo "Auto-detected/fixed deployment settings:"
echo "  Repository:    ${REPO_URL}"
echo "  Branch:        ${BRANCH}"
echo "  App directory: ${APP_DIR}"
echo "  App user:      ${APP_USER}"
echo "  App port:      ${APP_PORT}"
echo "  Service name:  ${SERVICE_NAME}"
echo

DOMAIN="$(prompt "Domain name (must already point DNS to this server)" "overlay.example.com")"
ADMIN_EMAIL="$(prompt "Email for Let's Encrypt notifications" "admin@example.com")"

echo
if ! confirm "Proceed with installation?" "y"; then
  echo "Installation cancelled."
  exit 0
fi

echo
echo "[1/9] Updating server packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

echo "[2/9] Installing prerequisites..."
apt-get install -y curl git nginx certbot python3-certbot-nginx ca-certificates gnupg ufw

echo "[3/9] Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "[4/9] Preparing service user and app directory..."
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi
mkdir -p "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo "[5/9] Deploying application..."
if [[ -d "${APP_DIR}/.git" ]]; then
  sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch --all --tags
  sudo -u "${APP_USER}" git -C "${APP_DIR}" checkout "${BRANCH}"
  sudo -u "${APP_USER}" git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
else
  if [[ -n "$(ls -A "${APP_DIR}" 2>/dev/null)" ]]; then
    echo "Directory ${APP_DIR} is not empty and not a git repo."
    echo "Please clear it and re-run this installer."
    exit 1
  fi
  sudo -u "${APP_USER}" git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

echo "[6/9] Installing Node dependencies..."
if [[ -f "${APP_DIR}/package-lock.json" ]]; then
  sudo -u "${APP_USER}" npm --prefix "${APP_DIR}" ci
else
  sudo -u "${APP_USER}" npm --prefix "${APP_DIR}" install
fi

echo "[7/9] Creating/updating systemd service..."
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "${SERVICE_FILE}" <<EOF_SERVICE
[Unit]
Description=Overlay app (${SERVICE_NAME})
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF_SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "[8/9] Configuring Nginx reverse proxy..."
NGINX_FILE="/etc/nginx/sites-available/${SERVICE_NAME}"
cat > "${NGINX_FILE}" <<EOF_NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
EOF_NGINX

ln -sfn "${NGINX_FILE}" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
if [[ -f /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx

echo "[9/9] Configuring firewall + HTTPS..."
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
if confirm "Enable UFW firewall now?" "n"; then
  ufw --force enable
fi

certbot --nginx --non-interactive --agree-tos --redirect -m "${ADMIN_EMAIL}" -d "${DOMAIN}"

echo
echo "Installation complete."
echo
echo "Service status:"
systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,14p' || true
echo
echo "URLs:"
echo "  Control UI: https://${DOMAIN}/"
echo "  Output:     https://${DOMAIN}/output.html?session=<session-id>"
echo
echo "Useful commands:"
echo "  journalctl -u ${SERVICE_NAME} -f"
echo "  systemctl restart ${SERVICE_NAME}"
echo "  nginx -t && systemctl reload nginx"
