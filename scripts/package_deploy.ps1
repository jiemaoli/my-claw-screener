param(
  [string]$OutputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) "..\claw_screener_deploy.tar.gz")
)

$projectRoot = Split-Path $PSScriptRoot -Parent
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)

Push-Location $projectRoot
try {
  tar -czf $resolvedOutput `
    --exclude=.git `
    --exclude=.env `
    --exclude=node_modules `
    --exclude=dist `
    --exclude=data `
    --exclude=coverage `
    --exclude='*.db' `
    .
  if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive" }
} finally {
  Pop-Location
}

Write-Host "Created $resolvedOutput"
