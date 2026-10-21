param(
  [string]$HostName = "192.210.254.31",
  [int]$Port = 56787,
  [string]$UserName = "root",
  [string]$IdentityFile = "C:\Users\Jerry\.ssh\id_ed25519"
)

$archive = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) "..\claw_screener_deploy.tar.gz"))
& (Join-Path $PSScriptRoot "package_deploy.ps1") -OutputPath $archive
if ($LASTEXITCODE -ne 0) { throw "Packaging failed" }

scp -i $IdentityFile -P $Port -o BatchMode=yes $archive "${UserName}@${HostName}:/root/apps/claw_screener_deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "Upload failed" }

ssh -i $IdentityFile -p $Port -o BatchMode=yes "${UserName}@${HostName}" "mkdir -p /root/apps/claw-screener/deploy && tar -xzf /root/apps/claw_screener_deploy.tar.gz -C /root/apps/claw-screener ./deploy/deploy.sh && chmod +x /root/apps/claw-screener/deploy/deploy.sh && /root/apps/claw-screener/deploy/deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed" }

Write-Host "Deployment completed: https://stock-claw.hhxs.top"
