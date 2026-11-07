#!/bin/bash
# Idempotent hardening of the "ilven" realm, run after Keycloak is healthy.
set -euo pipefail
KC=/opt/keycloak/bin/kcadm.sh
SERVER=http://keycloak:8080/auth
CFG=/tmp/kcadm.config

# 1. Replace seeded dev passwords (admin/admin, alice/alice) if they still work. Passwords users set themselves are kept.
for u in admin alice; do
  if $KC config credentials --config /tmp/probe.config --server "$SERVER" --realm ilven --client admin-cli --user "$u" --password "$u" >/dev/null 2>&1; then
    $KC config credentials --config "$CFG" --server "$SERVER" --realm master --user kcadmin --password "$(cat /run/ilven-secrets/keycloak/admin_password)" >/dev/null
    $KC set-password --config "$CFG" -r ilven --username "$u" --new-password "$(cat "/run/ilven-secrets/keycloak-users/$u")"
    echo "replaced the dev password of '$u'"
  fi
done

$KC config credentials --config "$CFG" --server "$SERVER" --realm master --user kcadmin --password "$(cat /run/ilven-secrets/keycloak/admin_password)" >/dev/null

# 2. Realm security.
$KC update realms/ilven --config "$CFG" \
  -s bruteForceProtected=true -s failureFactor=10 -s waitIncrementSeconds=60 -s maxFailureWaitSeconds=900 \
  -s maxDeltaTimeSeconds=43200 -s permanentLockout=false -s registrationAllowed=true

# 3. Redirect URIs of the web client: local URL + every public host (ilven-<name>) + integrated app hosts (<name>).
uris=("${ILVEN_PUBLIC_URL}/*")
if [ -n "${ILVEN_PUBLIC_DOMAIN:-}" ]; then
  for h in ${ILVEN_PUBLIC_HOSTS:-}; do uris+=("https://ilven-${h}.${ILVEN_PUBLIC_DOMAIN}/*"); done
  for h in ${ILVEN_APP_HOSTS:-}; do uris+=("https://${h}.${ILVEN_PUBLIC_DOMAIN}/*"); done
fi
json=$(printf '"%s",' "${uris[@]}"); json="[${json%,}]"
logout=$(printf '%s##' "${uris[@]}"); logout="${logout%##}"
cid=$($KC get clients --config "$CFG" -r ilven -q clientId=ilven-web --fields id --format csv --noquotes)
$KC update "clients/$cid" --config "$CFG" -r ilven -s "redirectUris=$json" -s 'webOrigins=["+"]' -s "attributes.\"post.logout.redirect.uris\"=$logout"
echo "ilven-web redirect URIs: ${uris[*]}"
