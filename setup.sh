#!/usr/bin/env bash
# One-time prerequisites (safe to run again). After this, ./start.sh is all you need.
#
#   ./setup.sh
#
# It: checks Docker and git, gets the Beckn starter kit if missing, installs our
# apps into it, makes the one routing change the starter kit needs, and creates
# a strong API key. Run it from WSL (Windows) or a normal shell (macOS/Linux).
# STARTER_KIT_DIR (default ~/starter-kit) says where the starter kit lives.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

say "== Setting up the Naledi backbone"

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (Windows: enable WSL integration for your Ubuntu distro)."
docker info >/dev/null 2>&1 || die "Docker is installed but not reachable from here. Start Docker Desktop (and enable WSL integration), then try again."
docker compose version >/dev/null 2>&1 || die "'docker compose' is not available. Update Docker Desktop."
command -v git >/dev/null 2>&1 || die "git is not installed."
command -v curl >/dev/null 2>&1 || die "curl is not installed."
ok "docker, docker compose, git and curl are available"

if [ ! -d "$INSTALL_DIR" ]; then
  say "  getting the Beckn starter kit into $STARTER_KIT_DIR ..."
  git clone https://github.com/beckn/starter-kit.git "$STARTER_KIT_DIR" >/dev/null 2>&1 \
    || die "could not clone https://github.com/beckn/starter-kit.git (network problem?)"
fi
[ -f "$INSTALL_DIR/docker-compose-generic.yml" ] || die "the starter kit was not found at $STARTER_KIT_DIR (expected $INSTALL_DIR/docker-compose-generic.yml)"
ok "starter kit at $STARTER_KIT_DIR"

# Our apps, compose override, edge proxy and the partner kit go next to the starter kit's own compose file.
cp "$HERE/docker-compose.override-naledi.yml" "$HERE/edge.Caddyfile" "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/our-backend-naledi" "$INSTALL_DIR/partner-kit"
cp -r "$HERE/our-backend-naledi" "$INSTALL_DIR/our-backend-naledi"
cp -r "$HERE/partner-kit" "$INSTALL_DIR/partner-kit"
rm -rf "$INSTALL_DIR/partner-kit/node_modules"
cp "$HERE/.env.example" "$INSTALL_DIR/.env.example"
ok "our apps installed into $INSTALL_DIR"

# The starter kit sends "discover" to an external Discover Service. Ours answers
# discover itself, so point it at our own provider-side adapter.
ROUTING="$CONFIG_DIR/generic-routing-BAPCaller.yaml"
[ -f "$ROUTING" ] || die "missing $ROUTING"
if grep -Eq '^[[:space:]]*url:[[:space:]]*"http://onix-bpp:8082/bpp/receiver"' "$ROUTING"; then
  ok "discover already routed to our own provider adapter"
else
  [ -f "$ROUTING.orig" ] || cp "$ROUTING" "$ROUTING.orig"
  sed -i -E 's#^([[:space:]]*url:[[:space:]]*)"[^"]*"#\1"http://onix-bpp:8082/bpp/receiver"#' "$ROUTING"
  grep -Eq '^[[:space:]]*url:[[:space:]]*"http://onix-bpp:8082/bpp/receiver"' "$ROUTING" || die "could not update $ROUTING"
  ok "discover now routed to our own provider adapter (original kept as generic-routing-BAPCaller.yaml.orig)"
fi

if [ -z "$(env_get API_KEY)" ]; then
  KEY="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  env_set API_KEY "$KEY"
  ok "created a strong API key (kept in $ENV_FILE)"
else
  ok "API key already set (kept)"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

say ""
say "Done. Next:  ./start.sh            (add --tunnel for a public URL)"
