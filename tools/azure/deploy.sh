#!/usr/bin/env bash
# deploy.sh -- puts the Naledi network stack on Azure Container Apps (task 6.4).
#
#   az login
#   RG=<resource group> CONFIG_DIR=~/starter-kit/generic-devkit/config bash tools/azure/deploy.sh
#
# What it builds (dev/staging; safe to re-run, it reuses what already exists):
#
#   Container Apps environment cae-naledi (must already exist, or set CREATE_ENV=1)
#   └─ app "naledi-stack", exactly ONE replica, six containers sharing localhost:
#        edge (Caddy :3010, the only ingress: https://<app>.<env-domain>/v1/*)
#        sandbox-bap :3001   sandbox-bpp :3002   (our images, built in ACR)
#        onix-bap :8081      onix-bpp :8082      redis :6379
#   Azure Database for PostgreSQL flexible server: databases naledi_bap, naledi_bpp
#   Azure Files share "naledi-config": adapter configs + Caddyfile (read-only mount)
#   Container registry (ACR): our two images + mirrored onix/redis/caddy images
#   Logs: container stdout -> the environment's Log Analytics workspace
#
# Why one app with six containers: the containers then reach each other on
# localhost with the same ports as in Docker, so the adapter configs only need
# their host names swapped to localhost, and no VNet / TCP ingress is needed.
# Why one replica: each app keeps its working state in memory and syncs it to
# Postgres; two replicas would overwrite each other. Do not scale it out.
#
# Needs: az CLI with the containerapp extension, rights on the resource group,
# and the starter kit's config folder (with our local beckn.yaml schema file).

set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

# ---- settings (override with environment variables) ----
RG="${RG:?set RG to the resource group}"
ENV_NAME="${ENV_NAME:-cae-naledi}"
APP="${APP:-naledi-stack}"
CONFIG_DIR="${CONFIG_DIR:?set CONFIG_DIR to the starter kit config folder}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
SUFFIX="${SUFFIX:-$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)}"
ACR="${ACR:-acrnaledi$SUFFIX}"
PG="${PG:-pg-naledi-$SUFFIX}"
PG_ADMIN="${PG_ADMIN:-naledi}"
SA="${SA:-stnaledi$SUFFIX}"
SHARE="naledi-config"
IDENTITY="${IDENTITY:-}"                 # user-assigned identity that may pull from the registry (shared registry)
BAP_ID="${BAP_ID:-bap.example.com}"      # task 6.7: our own ids once registered in DeDi
BPP_ID="${BPP_ID:-bpp.example.com}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.naledi-azure-secrets}"   # kept on your machine only

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
need az; need openssl
az extension add --name containerapp --upgrade --only-show-errors >/dev/null
[ -f "$CONFIG_DIR/generic-bap.yaml" ] && [ -f "$CONFIG_DIR/generic-bpp.yaml" ] || { echo "no adapter configs in $CONFIG_DIR"; exit 1; }

# Secrets: created once, reused on every run.
touch "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"
# shellcheck disable=SC1090
. "$SECRETS_FILE"
newsecret() { grep -q "^$1=" "$SECRETS_FILE" || echo "$1=$(openssl rand -hex 24)" >> "$SECRETS_FILE"; }
newsecret API_KEY; newsecret INTERNAL_KEY
# shellcheck disable=SC1090
. "$SECRETS_FILE"
# URL-encode a value for use inside a postgres:// URL.
urlenc() { local s="$1" o="" c i; for ((i=0; i<${#s}; i++)); do c="${s:i:1}"; case "$c" in [a-zA-Z0-9._~-]) o+="$c" ;; *) o+=$(printf '%%%02X' "'$c") ;; esac; done; printf '%s' "$o"; }

say "1/6 Container Apps environment $ENV_NAME"
if ! az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null; then
  [ "${CREATE_ENV:-0}" = 1 ] || { echo "environment $ENV_NAME not found in $RG (set CREATE_ENV=1 to create it)"; exit 1; }
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "${LOCATION:?set LOCATION}" -o none
fi
LOCATION="$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query location -o tsv)"
echo "location $LOCATION"

say "2/6 Registry $ACR and images (tag $TAG)"
if ! az acr show -n "$ACR" -o none 2>/dev/null; then
  az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -o none
fi
# A shared registry with the admin user off is pulled from with a managed identity
# (IDENTITY); we never switch the admin user on for someone else's registry.
if [ "$(az acr show -n "$ACR" --query adminUserEnabled -o tsv)" != "true" ]; then
  [ -n "$IDENTITY" ] || { echo "registry $ACR has the admin user off: set IDENTITY to a user-assigned identity with AcrPull on it"; exit 1; }
  ID_RES="$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)"
  ID_PRINCIPAL="$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)"
  ACR_ID="$(az acr show -n "$ACR" --query id -o tsv)"
  if [ -z "$(az role assignment list --assignee "$ID_PRINCIPAL" --scope "$ACR_ID" --include-inherited --query "[?roleDefinitionName=='AcrPull' || roleDefinitionName=='AcrPush' || roleDefinitionName=='Owner' || roleDefinitionName=='Contributor'].roleDefinitionName" -o tsv)" ]; then
    echo "warning: identity $IDENTITY has no AcrPull on $ACR yet; the app will fail to pull images until an Owner grants it"
  fi
fi
# Build in the registry (ACR Tasks) when it allows it; otherwise build here with
# Docker and push (a registry with token-based auth off refuses ACR Tasks pushes).
LOGIN_SERVER="$(az acr show -n "$ACR" --query loginServer -o tsv)"
build_local() {
  command -v docker >/dev/null || { echo "docker is needed to build the images here"; exit 1; }
  az acr login -n "$ACR" --only-show-errors >/dev/null
  for side in bap:frontdoor-bap-server.js bpp:backbone-bpp-server.js; do
    docker build -q -t "$LOGIN_SERVER/naledi-${side%%:*}:$TAG" --build-arg "SERVER_FILE=${side#*:}" our-backend-naledi >/dev/null
    docker push -q "$LOGIN_SERVER/naledi-${side%%:*}:$TAG" >/dev/null
    echo "  pushed naledi-${side%%:*}:$TAG"
  done
}
if [ "${LOCAL_BUILD:-0}" = 1 ]; then
  build_local
else
  built=1
  for side in bap:frontdoor-bap-server.js bpp:backbone-bpp-server.js; do
    az acr build -r "$ACR" -t "naledi-${side%%:*}:$TAG" --build-arg "SERVER_FILE=${side#*:}" our-backend-naledi --only-show-errors -o none || { built=0; break; }
  done
  [ "$built" = 1 ] || { echo "  building in the registry failed; building here with Docker instead"; build_local; }
fi
# Mirror the public images so pulls never hit Docker Hub limits.
for img in fidedocker/onix-adapter:latest library/redis:alpine library/caddy:alpine; do
  az acr import -n "$ACR" --source "docker.io/$img" --image "${img#library/}" --force -o none 2>/dev/null || {
    echo "  import of $img failed; copying it with Docker instead"
    az acr login -n "$ACR" --only-show-errors >/dev/null
    docker pull -q "docker.io/$img" >/dev/null && docker tag "docker.io/$img" "$LOGIN_SERVER/${img#library/}" && docker push -q "$LOGIN_SERVER/${img#library/}" >/dev/null
  }
done
ACR_SERVER="$(az acr show -n "$ACR" --query loginServer -o tsv)"
ACR_PASS=""
[ -z "${ID_RES:-}" ] && ACR_PASS="$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)"

say "3/6 PostgreSQL $PG"
# Databases and firewall rules through the Azure REST API: the az postgres
# sub-command flags differ between CLI versions, the REST paths do not.
pg_api() { # pg_api METHOD sub-path [az rest args...]
  local m="$1" sub="$2"; shift 2
  local id; id="$(az postgres flexible-server show -g "$RG" -n "$PG" --query id -o tsv)"
  az rest --method "$m" --url "https://management.azure.com${id}/${sub}?api-version=2022-12-01" "$@"
}
if az postgres flexible-server show -g "$RG" -n "$PG" -o none 2>/dev/null; then
  # Existing (shared) server: use the login you were given; nothing is stored in the script.
  PG_ADMIN="${DB_USER:-$(az postgres flexible-server show -g "$RG" -n "$PG" --query administratorLogin -o tsv)}"
  [ -n "${DB_PASSWORD:-}" ] || { read -r -s -p "Password for $PG_ADMIN on $PG: " DB_PASSWORD; echo; }
  PG_PASSWORD="$DB_PASSWORD"
  if [ -z "$(pg_api GET firewallRules --query "value[?properties.startIpAddress=='0.0.0.0' && properties.endIpAddress=='0.0.0.0'].name" -o tsv 2>/dev/null)" ]; then
    echo "warning: $PG has no 'allow Azure services' firewall rule; the app may not reach it. Ask the owner, or run:"
    echo "  az postgres flexible-server firewall-rule create -g $RG --server-name $PG --name AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0"
  fi
else
  newsecret PG_PASSWORD; . "$SECRETS_FILE"
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOCATION" --version 16 \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --public-access 0.0.0.0 --yes -o none   # 0.0.0.0 = allow Azure services only
fi
for db in naledi_bap naledi_bpp; do
  if pg_api GET "databases/$db" -o none 2>/dev/null; then echo "  database $db exists"
  else
    pg_api PUT "databases/$db" --body '{"properties":{"charset":"UTF8","collation":"en_US.utf8"}}' -o none
    for i in $(seq 1 30); do pg_api GET "databases/$db" -o none 2>/dev/null && break; sleep 5; done
    pg_api GET "databases/$db" -o none 2>/dev/null || { echo "database $db was not created"; exit 1; }
    echo "  created database $db"
  fi
done
PG_HOST="$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)"
BAP_DB="postgres://$(urlenc "$PG_ADMIN"):$(urlenc "$PG_PASSWORD")@$PG_HOST:5432/naledi_bap?sslmode=require"
BPP_DB="postgres://$(urlenc "$PG_ADMIN"):$(urlenc "$PG_PASSWORD")@$PG_HOST:5432/naledi_bpp?sslmode=require"

say "4/6 Config share $SA/$SHARE"
az storage account show -g "$RG" -n "$SA" -o none 2>/dev/null \
  || az storage account create -g "$RG" -n "$SA" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 -o none
SA_KEY="$(az storage account keys list -g "$RG" -n "$SA" --query '[0].value' -o tsv)"
az storage share-rm show -g "$RG" --storage-account "$SA" -n "$SHARE" -o none 2>/dev/null \
  || az storage share-rm create -g "$RG" --storage-account "$SA" -n "$SHARE" --quota 1 -o none
# Copy the configs, swapping Docker host names for localhost (same ports).
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/onix" "$STAGE/edge"
cp -R "$CONFIG_DIR"/. "$STAGE/onix/"
cp edge.Caddyfile "$STAGE/edge/Caddyfile"
find "$STAGE" -type f \( -name '*.yaml' -o -name '*.yml' -o -name 'Caddyfile' \) ! -name '*.orig' -print0 |
  xargs -0 sed -i -E 's#\b(onix-bap|onix-bpp|sandbox-bap|sandbox-bpp|redis|naledi-edge):([0-9]+)#localhost:\2#g'
if grep -rqE '\b(onix-bap|onix-bpp|sandbox-bap|sandbox-bpp|naledi-edge)\b' "$STAGE" --include='*.yaml' --include=Caddyfile; then
  echo "note: these lines still name a Docker host (check them):"
  grep -rnE '\b(onix-bap|onix-bpp|sandbox-bap|sandbox-bpp|naledi-edge)\b' "$STAGE" --include='*.yaml' --include=Caddyfile | sed 's#^#  #'
fi
az storage file upload-batch --account-name "$SA" --account-key "$SA_KEY" -d "$SHARE" -s "$STAGE" -o none
az containerapp env storage set -g "$RG" -n "$ENV_NAME" --storage-name naledi-config \
  --azure-file-account-name "$SA" --azure-file-account-key "$SA_KEY" \
  --azure-file-share-name "$SHARE" --access-mode ReadOnly -o none

say "5/6 App $APP"
ENV_ID="$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)"
YAML="$STAGE/app.yaml"
# Partner URLs are optional; leave them out when not set.
OPT_BAP=""; OPT_BPP=""
[ -n "${MATCH_URL:-}" ] && OPT_BPP+="          - { name: MATCH_URL, value: \"$MATCH_URL\" }"$'\n'
[ -n "${EVENTS_URL:-}" ] && OPT_BPP+="          - { name: EVENTS_URL, value: \"$EVENTS_URL\" }"$'\n' \
                         && OPT_BAP+="          - { name: EVENTS_URL, value: \"$EVENTS_URL\" }"$'\n'
# Registry access: managed identity for a shared registry, else the admin user.
if [ -n "${ID_RES:-}" ]; then
  ID_BLOCK="identity:
  type: UserAssigned
  userAssignedIdentities:
    $ID_RES: {}"
  REG_BLOCK="      - server: $ACR_SERVER
        identity: $ID_RES"
  ACR_SECRET=""
else
  ID_BLOCK=""
  REG_BLOCK="      - server: $ACR_SERVER
        username: $ACR
        passwordSecretRef: acr-password"
  ACR_SECRET="      - { name: acr-password, value: \"$ACR_PASS\" }"
fi
cat > "$YAML" <<Y
location: $LOCATION
$ID_BLOCK
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 3010
      transport: auto
      allowInsecure: false
    registries:
$REG_BLOCK
    secrets:
$ACR_SECRET
      - { name: api-key, value: "$API_KEY" }
      - { name: internal-key, value: "$INTERNAL_KEY" }
      - { name: bap-db, value: "$BAP_DB" }
      - { name: bpp-db, value: "$BPP_DB" }
  template:
    scale: { minReplicas: 1, maxReplicas: 1 }
    volumes:
      - { name: config, storageType: AzureFile, storageName: naledi-config }
    containers:
      - name: redis
        image: $ACR_SERVER/redis:alpine
        resources: { cpu: 0.25, memory: 0.5Gi }
      - name: onix-bap
        image: $ACR_SERVER/fidedocker/onix-adapter:latest
        command: ["./server", "--config=/app/config/generic-bap.yaml"]
        env: [ { name: REDIS_ADDR, value: "localhost:6379" } ]
        volumeMounts: [ { volumeName: config, mountPath: /app/config, subPath: onix } ]
        resources: { cpu: 0.25, memory: 0.5Gi }
      - name: onix-bpp
        image: $ACR_SERVER/fidedocker/onix-adapter:latest
        command: ["./server", "--config=/app/config/generic-bpp.yaml"]
        env: [ { name: REDIS_ADDR, value: "localhost:6379" } ]
        volumeMounts: [ { volumeName: config, mountPath: /app/config, subPath: onix } ]
        resources: { cpu: 0.25, memory: 0.5Gi }
      - name: sandbox-bpp
        image: $ACR_SERVER/naledi-bpp:$TAG
        env:
          - { name: PORT, value: "3002" }
          - { name: ONIX_CALLER, value: "http://localhost:8082/bpp/caller" }
          - { name: API_KEY, secretRef: api-key }
          - { name: INTERNAL_KEY, secretRef: internal-key }
          - { name: DATABASE_URL, secretRef: bpp-db }
          - { name: PG_POOL_MAX, value: "3" }
$OPT_BPP        resources: { cpu: 0.25, memory: 0.5Gi }
        probes:
          - { type: Readiness, httpGet: { path: /api/health, port: 3002 }, periodSeconds: 10 }
      - name: sandbox-bap
        image: $ACR_SERVER/naledi-bap:$TAG
        env:
          - { name: PORT, value: "3001" }
          - { name: BACKBONE_CALLER, value: "http://localhost:8081/bap/caller" }
          - { name: BACKBONE_BASE_URL, value: "http://localhost:3002" }
          - { name: BAP_URI, value: "http://localhost:8081/bap/receiver" }
          - { name: BPP_URI, value: "http://localhost:8082/bpp/receiver" }
          - { name: BAP_ID, value: "$BAP_ID" }
          - { name: BPP_ID, value: "$BPP_ID" }
          - { name: NETWORK_ID, value: "beckn.one/testnet" }
          - { name: API_KEY, secretRef: api-key }
          - { name: INTERNAL_KEY, secretRef: internal-key }
          - { name: DATABASE_URL, secretRef: bap-db }
          - { name: PG_POOL_MAX, value: "3" }
$OPT_BAP        resources: { cpu: 0.25, memory: 0.5Gi }
        probes:
          - { type: Readiness, httpGet: { path: /api/health, port: 3001 }, periodSeconds: 10 }
      - name: edge
        image: $ACR_SERVER/caddy:alpine
        command: ["caddy", "run", "--config", "/etc/naledi/Caddyfile", "--adapter", "caddyfile"]
        volumeMounts: [ { volumeName: config, mountPath: /etc/naledi, subPath: edge } ]
        resources: { cpu: 0.25, memory: 0.5Gi }
Y
if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az containerapp update -g "$RG" -n "$APP" --yaml "$YAML" -o none
else
  az containerapp create -g "$RG" -n "$APP" --yaml "$YAML" -o none
fi

say "6/6 Check"
FQDN="$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
for i in $(seq 1 30); do
  curl -sf "https://$FQDN/v1/health" >/dev/null && break; sleep 10
done
echo "health: $(curl -s "https://$FQDN/v1/health")"
cat <<T

Base URL : https://$FQDN
API key  : in $SECRETS_FILE (API_KEY=...) -- share it privately, never in the group
Test     : BASE=https://$FQDN API_KEY=... bash try-all-apis.sh
Logs     : az containerapp logs show -g $RG -n $APP --container sandbox-bap --follow
           or Log Analytics: ContainerAppConsoleLogs_CL | where ContainerAppName_s == "$APP"
T
