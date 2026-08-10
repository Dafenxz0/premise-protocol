#!/usr/bin/env sh
set -eu

: "${PREVIOUS_IMAGE:?Set PREVIOUS_IMAGE to an immutable, previously verified image reference}"

compose_file="${COMPOSE_FILE:-deploy/docker-compose.yml}"
export PREMISE_IMAGE="$PREVIOUS_IMAGE"

docker compose -f "$compose_file" up -d --no-build premise
docker compose -f "$compose_file" exec -T -e PREMISE_HEALTH_PATH=/readyz premise node /app/ops/healthcheck.mjs
