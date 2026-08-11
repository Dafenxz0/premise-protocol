#!/usr/bin/env sh
set -eu

: "${PREVIOUS_IMAGE:?Set PREVIOUS_IMAGE to an immutable, previously verified image reference}"

compose_file="${COMPOSE_FILE:-deploy/docker-compose.yml}"
if [ "${ROLLBACK_ALLOW_MUTABLE_TAGS:-0}" != "1" ]; then
  case "$PREVIOUS_IMAGE" in
    *:latest|*:stable|*:current|*:previous|*:local)
      echo "Refusing mutable rollback image tag: $PREVIOUS_IMAGE" >&2
      exit 2
      ;;
  esac
fi
export PREMISE_IMAGE="$PREVIOUS_IMAGE"

docker compose -f "$compose_file" config --quiet
docker image inspect "$PREVIOUS_IMAGE" >/dev/null
docker compose -f "$compose_file" up -d --no-build --pull never --no-deps --force-recreate premise
docker compose -f "$compose_file" exec -T -e PREMISE_HEALTH_PATH=/readyz premise node /app/ops/healthcheck.mjs

container_id="$(docker compose -f "$compose_file" ps -q premise)"
test -n "$container_id"
expected_image_id="$(docker image inspect "$PREVIOUS_IMAGE" --format '{{.Id}}')"
actual_image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
if [ "$expected_image_id" != "$actual_image_id" ]; then
  echo "Rollback image verification failed" >&2
  exit 1
fi
