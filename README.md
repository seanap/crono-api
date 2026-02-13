# crono-api 
### Local API wrapper for `@milldr/crono`

Local HTTP API around [`@milldr/crono`](https://www.npmjs.com/package/@milldr/crono) so other apps on your LAN can read/write Cronometer data without using the CLI directly.

This project is designed for homelab usage:

- runs with Dockge using `compose.yaml` and `.env`
- auto-updates `@milldr/crono` to latest npm on every container start
- loads credentials from an externally mounted `.env`

## Crono Summary

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
- Interactive `login` exists in upstream CLI, but this API wrapper uses non-interactive credential sync from `.env` instead to make it container-friendly.

References:

- https://github.com/milldr/crono
- https://www.npmjs.com/package/@milldr/crono

## Setup

1. Quick Start:

```yaml
services:
  crono-api:
    image: seanap/crono-api:latest
    container_name: crono-api
    restart: unless-stopped
    ports:
      - 8777:8080
    environment:
      - TZ=America/New_York
      - HOME=/data
      - CRONO_ENV_FILE=/app/config/.env
    volumes:
      - /opt/stacks/crono-api/data:/data
      - /opt/stacks/crono-api/.env:/app/config/.env:ro
```

2. Edit `.env` and set:

- `CRONO_KERNEL_API_KEY`
- `CRONO_CRONOMETER_EMAIL`
- `CRONO_CRONOMETER_PASSWORD`
- `CRONO_ALLOW_NO_API_KEY=true`

3. API is available at:

```
http://<docker-host-lan-ip>:8777
```

## Auth

If you set `.env` with `CRONO_ALLOW_NO_API_KEY=true`, requests do not need auth headers.

If you run with API key auth enabled, pass:

- In `.env` include `CRONO_API_KEY=<input_strong_key_here>`
- `x-api-key: <CRONO_API_KEY>`
- or `Authorization: Bearer <CRONO_API_KEY>`

If API key auth is enabled, add this header to all calls:

```bash
-H "x-api-key: $CRONO_API_KEY"
```

## All Endpoint Examples

Base URL used below:

```bash
BASE_URL="http://<host_IP>:8777"
```

Read endpoints:

```bash
# health and endpoint discovery
curl -s "$BASE_URL/health"
curl -s "$BASE_URL/api/v1/endpoints"

# diary
curl -s "$BASE_URL/api/v1/diary"
curl -s "$BASE_URL/api/v1/diary?date=2026-02-13"
curl -s "$BASE_URL/api/v1/diary?range=7d"
curl -s "$BASE_URL/api/v1/diary?range=2026-02-01:2026-02-13"

# weight
curl -s "$BASE_URL/api/v1/weight"
curl -s "$BASE_URL/api/v1/weight?date=2026-02-13"
curl -s "$BASE_URL/api/v1/weight?range=7d"
curl -s "$BASE_URL/api/v1/weight?range=2026-02-01:2026-02-13"

# export nutrition / exercises / biometrics
curl -s "$BASE_URL/api/v1/export/nutrition"
curl -s "$BASE_URL/api/v1/export/nutrition?range=7d"
curl -s "$BASE_URL/api/v1/export/nutrition?date=2026-02-13"
curl -s "$BASE_URL/api/v1/export/nutrition?range=30d&csv=true"
curl -s "$BASE_URL/api/v1/export/exercises?range=7d"
curl -s "$BASE_URL/api/v1/export/biometrics?range=30d"

# required summaries
curl -s "$BASE_URL/api/v1/summary/today-macros"
curl -s "$BASE_URL/api/v1/summary/today-macros?date=2026-02-13"
curl -s "$BASE_URL/api/v1/summary/calorie-balance?days=7"
curl -s "$BASE_URL/api/v1/summary/calorie-balance?days=7&target_kcal=2400"
curl -s "$BASE_URL/api/v1/summary/calorie-balance?range=2026-02-01:2026-02-13"

# weekly average net calories using your formula:
# (trailing consumed total - trailing burned total) / days
curl -s "$BASE_URL/api/v1/summary/weekly-average-deficit?days=7"
curl -s "$BASE_URL/api/v1/summary/weekly-average-deficit?range=2026-02-01:2026-02-13"
```

`weekly-average-deficit` details:

- `consumedCalories` comes from nutrition export daily calories.
- Completed days only are included.
- `burnedCalories` uses nutrition burned fields when available, otherwise exercise export `caloriesBurned` with absolute-value normalization.
- `burnedRawCalories` preserves raw Cronometer sign (your current data is negative for burned).
- `averageNetCaloriesPerDay`:
  - `< 0` means average deficit
  - `> 0` means average surplus

Write endpoints:

```bash
# quick-add
curl -s -X POST \
  -H "content-type: application/json" \
  -d '{"protein":30,"carbs":100,"fat":20,"meal":"Dinner"}' \
  "$BASE_URL/api/v1/quick-add"

# add custom food
curl -s -X POST \
  -H "content-type: application/json" \
  -d '{"name":"Post-Workout Shake","protein":40,"carbs":60,"fat":10}' \
  "$BASE_URL/api/v1/add/custom-food"

# add custom food and also log it
curl -s -X POST \
  -H "content-type: application/json" \
  -d '{"name":"Wendys Sandwich","protein":50,"carbs":100,"fat":50,"log":"Dinner"}' \
  "$BASE_URL/api/v1/add/custom-food"

# log existing food
curl -s -X POST \
  -H "content-type: application/json" \
  -d '{"name":"Post-Workout Shake","meal":"Snacks","servings":1}' \
  "$BASE_URL/api/v1/log"

# re-sync credentials after editing mounted .env
curl -s -X POST \
  -H "content-type: application/json" \
  "$BASE_URL/api/v1/admin/sync-credentials"
```

## How Auto-Update Works

On each container start (`scripts/start.sh`):

1. Source mounted env file (`/app/config/.env`).
2. Run `npm install --prefix /app/runtime @milldr/crono@latest`.
3. Sync credentials into crono storage.
4. Start API server.

This keeps upstream `@milldr/crono` current with no manual image rebuild for package updates.
