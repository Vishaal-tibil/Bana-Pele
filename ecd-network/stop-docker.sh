#!/usr/bin/env bash
# stop-docker.sh -- stops and removes the ECD network containers (data/ is kept).
cd "$(dirname "$0")"
[ -f .generated/docker-compose.yml ] && docker compose -f .generated/docker-compose.yml down
