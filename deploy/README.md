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

The application provides its own login page. Set `APP_USERNAME`, `APP_PASSWORD`, and a random value of at least 32 characters in `APP_SESSION_SECRET`. The default screening schedule is 18:15 America/New_York on weekdays, corresponding to 06:15 Beijing time during US daylight saving time and 07:15 during standard time.

## fin_twt screening API

Set `SCREENER_API_TOKEN` to a random value of at least 32 characters. Containers on `infrastructure_infra-net` can trigger a screening without sending Telegram messages:

```http
POST http://claw-screener-dashboard:5051/api/v1/screen
Authorization: Bearer <SCREENER_API_TOKEN>
Content-Type: application/json

{
  "strategy": "quality_oversold",
  "market": "US",
  "limit": 10,
  "parameters": { "min_score": 5 }
}
```

Use `strategy: "technical_oversold"` with an optional `parameters.threshold` for technical-only screening. The response follows shared screening schema `1.0` and returns normalized `candidates`. The legacy `/api/v1/fin-twt/screen` endpoint remains available during migration.

Manual package deployment:

```powershell
.\scripts\package_deploy.ps1
scp -i C:\Users\Jerry\.ssh\id_ed25519 -P 56787 `
  ..\claw_screener_deploy.tar.gz `
  root@192.210.254.31:/root/apps/
ssh -i C:\Users\Jerry\.ssh\id_ed25519 -p 56787 root@192.210.254.31 `
  "mkdir -p /root/apps/claw-screener/deploy && tar -xzf /root/apps/claw_screener_deploy.tar.gz -C /root/apps/claw-screener ./deploy/deploy.sh && chmod +x /root/apps/claw-screener/deploy/deploy.sh && /root/apps/claw-screener/deploy/deploy.sh"
```
