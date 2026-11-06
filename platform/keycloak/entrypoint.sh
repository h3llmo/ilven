#!/bin/bash
# Reads generated secrets from files (Keycloak only accepts them as env vars), then starts Keycloak.
set -euo pipefail
export KC_DB_PASSWORD="$(cat /run/ilven-secrets/db/password)"
export KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/ilven-secrets/keycloak/admin_password)"
exec /opt/keycloak/bin/kc.sh "$@"
