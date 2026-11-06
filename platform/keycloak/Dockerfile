FROM quay.io/keycloak/keycloak:26.5
# Directory imports only pick up "<realm>-realm.json". (--chmod also applies to the created directory, hence 0755.)
COPY --chmod=0755 ilven-realm.json /opt/keycloak/data/import/ilven-realm.json
COPY --chmod=0755 entrypoint.sh /opt/keycloak/bin/ilven-entrypoint.sh
ENTRYPOINT ["/opt/keycloak/bin/ilven-entrypoint.sh"]
