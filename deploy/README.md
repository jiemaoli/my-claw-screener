# VPS deployment

Production uses the same package deployment pattern as finTwt and stock-screener. The VPS does not clone or pull from GitHub and does not store GitHub credentials.

- Application: `/root/apps/claw-screener`
- Persistent data and schedule: `/root/apps/claw-screener/data`
- Secrets: `/root/apps/claw-screener/.env`
- Compose: `/root/apps/claw-screener/deploy/docker-compose.yml`
- Shared network: `infrastructure_infra-net`
- Domain: `stock-claw.hhxs.top`

Deploy the current local working tree from Windows:

```powershell
.\scripts\deploy_vps.ps1
```

The script creates an archive excluding Git metadata, credentials, dependencies, build output, caches, and runtime data. It uploads the archive over SSH, builds the Docker image on the VPS, updates the Compose services, validates Nginx, and reloads the reverse proxy.

Manual package deployment:

```powershell
.\scripts\package_deploy.ps1
scp -i C:\Users\Jerry\.ssh\id_ed25519 -P 56787 `
  ..\claw_screener_deploy.tar.gz `
  root@192.210.254.31:/root/apps/
ssh -i C:\Users\Jerry\.ssh\id_ed25519 -p 56787 root@192.210.254.31 `
  "mkdir -p /root/apps/claw-screener/deploy && tar -xzf /root/apps/claw_screener_deploy.tar.gz -C /root/apps/claw-screener ./deploy/deploy.sh && chmod +x /root/apps/claw-screener/deploy/deploy.sh && /root/apps/claw-screener/deploy/deploy.sh"
```
