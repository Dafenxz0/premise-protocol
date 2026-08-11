param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousImage,
  [string]$ComposeFile = "deploy/docker-compose.yml"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($PreviousImage)) { throw "PreviousImage is required" }
if ($env:ROLLBACK_ALLOW_MUTABLE_TAGS -ne "1" -and $PreviousImage -match ":(latest|stable|current|previous|local)$") {
  throw "Refusing mutable rollback image tag: $PreviousImage"
}
$env:PREMISE_IMAGE = $PreviousImage
docker compose -f $ComposeFile config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker image inspect $PreviousImage --format "{{.Id}}" | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose -f $ComposeFile up -d --no-build --pull never --no-deps --force-recreate premise
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose -f $ComposeFile exec -T -e PREMISE_HEALTH_PATH=/readyz premise node /app/ops/healthcheck.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$containerId = (& docker compose -f $ComposeFile ps -q premise).Trim()
if ([string]::IsNullOrWhiteSpace($containerId)) { throw "Could not identify the rolled-back premise container" }
$expectedImageId = (& docker image inspect $PreviousImage --format "{{.Id}}").Trim()
$actualImageId = (& docker inspect $containerId --format "{{.Image}}").Trim()
if ($expectedImageId -ne $actualImageId) { throw "Rollback image verification failed" }
exit 0
