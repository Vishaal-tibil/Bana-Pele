#!/usr/bin/env bash
# Stops everything (saved state is kept; ./start.sh brings it back).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -d "$INSTALL_DIR" ] || die "nothing to stop: $INSTALL_DIR does not exist"
compose --profile tunnel --profile test down
ok "stopped (state kept; use ./start.sh to bring it back)"
