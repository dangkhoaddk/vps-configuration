#!/bin/bash
# Reproduce the nginx .conf files the three deploy.sh scripts write, WITHOUT
# running any of their docker/network/certbot commands.
#
# Extracts only `cat <<EOF > <path>` ... `EOF` blocks and evaluates them with the
# same variables the scripts set. Commented-out heredocs (`# cat <<EOF`) are not
# matched, so the disabled web-ssl.conf block in spa-api stays disabled.
set -euo pipefail

REPO="/Users/khoa.bui/Documents/bali-web"
OUT="${1:?usage: extract-heredocs.sh <output-dir>}"

rm -rf "$OUT"
mkdir -p "$OUT/nginx/conf" "$OUT/nginx/snippets"

extract() {
  awk '/^cat <<EOF > /{p=1} p{print} p && $0=="EOF"{p=0}' "$1"
}

echo "--- extracted heredoc blocks ---"
for f in spa-api/tool/deploy.sh spa-web/tool/deploy.sh spa-admin/tool/deploy.sh; do
  echo "  $f: $(extract "$REPO/$f" | grep -c '^cat <<EOF > ') block(s)"
done
echo

# ---- spa-api ----------------------------------------------------------------
# Only APP_NETWORK is referenced inside its heredocs (in a comment).
(
  cd "$OUT"
  APP_NETWORK="ext_network"
  export APP_NETWORK
  eval "$(extract "$REPO/spa-api/tool/deploy.sh")"
)

# ---- spa-web ----------------------------------------------------------------
# Values are the CI defaults from spa-web/.github/workflows/ci.yml + deploy.sh.
(
  API_DIR="$OUT"
  DOMAIN="balispacafe.com www.balispacafe.com"
  PRIMARY_DOMAIN="balispacafe.com"
  WEB_PORT="3000"
  export API_DIR DOMAIN PRIMARY_DOMAIN WEB_PORT
  eval "$(extract "$REPO/spa-web/tool/deploy.sh")"
)

# ---- spa-admin --------------------------------------------------------------
(
  API_DIR="$OUT"
  DOMAIN="admin.balispacafe.com www.admin.balispacafe.com"
  PRIMARY_DOMAIN="admin.balispacafe.com"
  ADMIN_PORT="3000"
  export API_DIR DOMAIN PRIMARY_DOMAIN ADMIN_PORT
  eval "$(extract "$REPO/spa-admin/tool/deploy.sh")"
)

echo "--- produced ---"
find "$OUT" -type f | sort
