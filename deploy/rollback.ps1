param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousImage,
  [string]$ComposeFile = "deploy/docker-compose.yml"
)

$env:PREMISE_IMAGE = $PreviousImage
docker compose -f $ComposeFile up -d --no-build premise
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose -f $ComposeFile exec -T -e PREMISE_HEALTH_PATH=/readyz premise node /app/ops/healthcheck.mjs
exit $LASTEXITCODE
