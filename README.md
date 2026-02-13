# crono-api (LAN wrapper for `@milldr/crono`)

Local HTTP API around [`@milldr/crono`](https://www.npmjs.com/package/@milldr/crono) so other apps on your LAN can read/write Cronometer data without using the CLI directly.

This project is designed for homelab usage:

- no public deployment requirements
- runs with Dockge using `compose.yaml`
- auto-updates `@milldr/crono` to latest npm on every container start
- loads credentials from an externally mounted `.env`

## Upstream Research Summary

Based on current upstream repo/package (`milldr/crono`, npm `@milldr/crono`):

- Read operations:
  - `diary`
  - `weight`
  - `export nutrition`
  - `export exercises`
  - `export biometrics`
- Write operations:
  - `quick-add`
  - `add custom-food`
  - `log`
- Interactive `login` exists in upstream CLI, but this API wrapper uses non-interactive credential sync from env instead (container-friendly).

References:

- https://github.com/milldr/crono
- https://www.npmjs.com/package/@milldr/crono

## Setup

1. Create your persistent env file:

```bash
mkdir -p config data
cp .env.example config/.env
```

2. Edit `config/.env` and set:

- `CRONO_KERNEL_API_KEY`
- `CRONO_CRONOMETER_EMAIL`
- `CRONO_CRONOMETER_PASSWORD`
- `CRONO_API_KEY`

3. Start:

```bash
docker compose -f compose.yaml up -d --build
```

4. API is available at:

```text
http://<docker-host-lan-ip>:8787
```

## Docker Hub Publish

Local Docker is unavailable in this execution environment, so publishing is set up via GitHub Actions:

- Workflow file: `.github/workflows/dockerhub.yml`
- Image target: `<DOCKERHUB_USERNAME>/crono-api`
- Triggers: push to `main` and manual dispatch

Required repo secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN` (Docker Hub access token)

Set secrets:

```bash
gh secret set DOCKERHUB_USERNAME -R seanap/crono-api
gh secret set DOCKERHUB_TOKEN -R seanap/crono-api
```

Run publish workflow:

```bash
gh workflow run "Publish Docker Image" -R seanap/crono-api
```

Watch workflow:

```bash
gh run list -R seanap/crono-api
gh run view <run-id> -R seanap/crono-api --log
```

## Dockge Notes

- `compose.yaml` is Dockge-friendly.
- `./config/.env:/app/config/.env:ro` is the external persisted env mount.
- `./data:/data` persists crono config/runtime files.

If you prefer absolute host paths in Dockge, replace the bind mounts with your server paths.

If you want Dockge to pull from Docker Hub instead of building locally, use `compose.dockerhub.yaml`.

## Auth

Pass your local API key on every request:

- `x-api-key: <CRONO_API_KEY>`
- or `Authorization: Bearer <CRONO_API_KEY>`

## Endpoint Map

### Read

- `GET /health`
- `GET /api/v1/endpoints`
- `GET /api/v1/diary?date=YYYY-MM-DD`
- `GET /api/v1/diary?range=7d`
- `GET /api/v1/weight?date=YYYY-MM-DD`
- `GET /api/v1/weight?range=7d`
- `GET /api/v1/export/nutrition?date=YYYY-MM-DD`
- `GET /api/v1/export/nutrition?range=7d`
- `GET /api/v1/export/nutrition?range=30d&csv=true`
- `GET /api/v1/export/exercises?range=7d`
- `GET /api/v1/export/biometrics?range=30d`
- `GET /api/v1/summary/today-macros`
- `GET /api/v1/summary/today-macros?date=YYYY-MM-DD`
- `GET /api/v1/summary/calorie-balance?days=7`
- `GET /api/v1/summary/calorie-balance?days=7&target_kcal=2400`
- `GET /api/v1/summary/calorie-balance?range=2026-02-01:2026-02-07`

### Write

- `POST /api/v1/quick-add`
- `POST /api/v1/add/custom-food`
- `POST /api/v1/log`
- `POST /api/v1/admin/sync-credentials`

## Required Endpoints You Asked For

### 1) Current day protein + carbs

```bash
curl -s \
  -H "x-api-key: $CRONO_API_KEY" \
  "http://localhost:8787/api/v1/summary/today-macros"
```

Response includes:

- `protein`
- `carbs`
- `fat`
- `calories`
- `date`

### 2) Trailing 7-day calorie deficit/surplus

```bash
curl -s \
  -H "x-api-key: $CRONO_API_KEY" \
  "http://localhost:8787/api/v1/summary/calorie-balance?days=7"
```

If Cronometer export includes a calorie target column, it is inferred automatically.
If not, pass `target_kcal` query param or set `CRONO_DEFAULT_CALORIE_TARGET` in `.env`.

Response includes:

- `totalNetCalories` (`> 0` = surplus, `< 0` = deficit)
- `totalDeficitCalories`
- `totalSurplusCalories`
- `trend`
- `perDay[]`

## Write Examples

Quick add:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $CRONO_API_KEY" \
  -d '{"protein":30,"carbs":100,"fat":20,"meal":"Dinner"}' \
  "http://localhost:8787/api/v1/quick-add"
```

Add custom food:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $CRONO_API_KEY" \
  -d '{"name":"Post-Workout Shake","protein":40,"carbs":60,"log":"Snacks"}' \
  "http://localhost:8787/api/v1/add/custom-food"
```

Log food:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $CRONO_API_KEY" \
  -d '{"name":"Post-Workout Shake","meal":"Snacks","servings":1}' \
  "http://localhost:8787/api/v1/log"
```

Refresh credentials from env/body:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $CRONO_API_KEY" \
  "http://localhost:8787/api/v1/admin/sync-credentials"
```

## How Auto-Update Works

On each container start (`scripts/start.sh`):

1. Source mounted env file (`/app/config/.env`).
2. Run `npm install --prefix /app/runtime @milldr/crono@latest`.
3. Sync credentials into crono storage.
4. Start API server.

This keeps upstream `@milldr/crono` current with no manual image rebuild for package updates.
