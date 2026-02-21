#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (example: curl ... | sudo bash)"
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrapper is intended for Ubuntu/Debian systems with apt-get."
  exit 1
fi

REPO_URL="https://github.com/jabez4jc/Overlay"
BRANCH="main"
APP_DIR="/opt/overlay"

echo "=== Overlay Bootstrap Installer ==="
echo "This will update the server, install git/curl, clone/update the repo,"
echo "and launch scripts/install_ubuntu_server.sh"
echo

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl ca-certificates

if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch --all --tags
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
else
  rm -rf "${APP_DIR}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
bash scripts/install_ubuntu_server.sh
