import express from "express";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { syncCredentials } from "./credentials-sync.js";
import { scrapeEnergySummaryForDates } from "./energy-scrape.js";

const APP_VERSION = "0.1.0";
const PORT = parseInt(process.env.CRONO_PORT || "8080", 10);
const HOST = process.env.CRONO_HOST || "0.0.0.0";
const CLI_TIMEOUT_MS = parseInt(process.env.CRONO_CLI_TIMEOUT_MS || "180000", 10);
const CRONO_BIN =
  process.env.CRONO_BIN || "/app/runtime/node_modules/.bin/crono";
const CRONO_PACKAGE_JSON =
  process.env.CRONO_PACKAGE_JSON || "/app/runtime/node_modules/@milldr/crono/package.json";

const API_KEY = process.env.CRONO_API_KEY || "";
const ALLOW_NO_API_KEY = String(process.env.CRONO_ALLOW_NO_API_KEY || "false")
  .toLowerCase()
  .trim() === "true";
const REQUIRE_API_KEY = !ALLOW_NO_API_KEY && API_KEY.length > 0;

const app = express();
app.use(express.json({ limit: "256kb" }));

class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickApiKey(req) {
  const apiKeyHeader = req.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader.trim();

  const auth = req.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return "";
}

function apiKeyMiddleware(req, _res, next) {
  if (!REQUIRE_API_KEY) return next();

  const provided = pickApiKey(req);
  if (provided !== API_KEY) {
    return next(
      new HttpError(
        401,
        "Unauthorized. Provide x-api-key or Authorization: Bearer <key>."
      )
    );
  }

  return next();
}

function buildDateArgs(input) {
  const date = typeof input.date === "string" ? input.date.trim() : "";
  const range = typeof input.range === "string" ? input.range.trim() : "";

  if (date && range) {
    throw new HttpError(400, "date and range are mutually exclusive");
  }

  const args = [];
  if (date) args.push("--date", date);
  if (range) args.push("--range", range);
  return args;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

async function readCronoVersion() {
  try {
    const raw = await readFile(CRONO_PACKAGE_JSON, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.version || null;
  } catch {
    return null;
  }
}

function runCrono(args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CRONO_BIN, args, {
      env: {
        ...process.env,
        KERNEL_API_KEY:
          process.env.CRONO_KERNEL_API_KEY || process.env.KERNEL_API_KEY || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new HttpError(500, `Failed to execute crono: ${error.message}`, {
          args,
        })
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        return reject(
          new HttpError(504, `crono command timed out after ${timeoutMs}ms`, {
            args,
          })
        );
      }

      if (code !== 0) {
        return reject(
          new HttpError(502, "crono command failed", {
            args,
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          })
        );
      }

      return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function runCronoJson(args) {
  const result = await runCrono(args);
  const raw = result.stdout.trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(502, "crono returned invalid JSON", {
      args,
      stdout: raw,
    });
  }
}

function isRateLimitError(error) {
  if (!error) return false;
  const stdout = String(error?.extra?.stdout || "");
  const stderr = String(error?.extra?.stderr || "");
  const message = String(error?.message || "");
  const combined = `${stdout}\n${stderr}\n${message}`.toLowerCase();
  return combined.includes("rate limit");
}

async function runCronoJsonWithRetry(
  args,
  { attempts = 3, delayMs = 12000 } = {}
) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runCronoJson(args);
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error) && i < attempts - 1) {
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function getNumericField(entry, keys) {
  if (!entry || typeof entry !== "object") return null;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      const value = parseNumber(entry[key]);
      if (value !== null) return { value, key };
    }
  }
  return null;
}

function inferTargetCalories(entry) {
  const directTarget = getNumericField(entry, [
    "Energy Target (kcal)",
    "Calorie Target (kcal)",
    "Calories Target",
    "Target Calories",
    "Energy Budget (kcal)",
  ]);
  if (directTarget) {
    return { target: directTarget.value, source: `entry:${directTarget.key}` };
  }

  const remaining = getNumericField(entry, [
    "Energy Remaining (kcal)",
    "Calories Remaining",
    "Remaining Calories",
  ]);
  const intake = parseNumber(entry?.calories);
  if (remaining && intake !== null) {
    return {
      target: intake + remaining.value,
      source: `derived:calories+${remaining.key}`,
    };
  }

  return null;
}

function inferBurnedCalories(entry) {
  const directBurned = getNumericField(entry, [
    "Energy Burned (kcal)",
    "Calories Burned (kcal)",
    "Expenditure (kcal)",
    "Total Burned (kcal)",
    "Burned (kcal)",
    "TDEE (kcal)",
    "Total Energy Expenditure (kcal)",
  ]);

  if (directBurned) {
    return { burned: directBurned.value, source: `entry:${directBurned.key}` };
  }

  return null;
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildTrailingRangeExcludingToday(days) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return {
    start: formatLocalDate(start),
    end: formatLocalDate(end),
    rangeSpec: `${formatLocalDate(start)}:${formatLocalDate(end)}`,
  };
}

const BURN_COMPONENT_KEYS = {
  bmr: [
    "BMR (kcal)",
    "Basal Metabolic Rate (kcal)",
    "Resting Metabolic Rate (kcal)",
    "RMR (kcal)",
  ],
  tef: [
    "TEF (kcal)",
    "Thermic Effect of Food (kcal)",
    "Thermal Effect of Food (kcal)",
  ],
  exercise: [
    "Exercise (kcal)",
    "Exercises (kcal)",
    "Active Exercise (kcal)",
    "Workout (kcal)",
  ],
  trackerActivity: [
    "Tracker Activity (kcal)",
    "Tracker Calories (kcal)",
    "Daily Activity (kcal)",
    "Activity (kcal)",
  ],
};
const OPTIONAL_BURN_COMPONENT_KEYS = {
  baseline: [
    "Baseline (kcal)",
    "Baseline Activity (kcal)",
    "Base (kcal)",
    "Resting Expenditure (kcal)",
  ],
};

function extractBurnedComponents(entry) {
  const components = {};
  const missing = [];
  const missingOptional = [];
  let total = 0;
  let rawTotal = 0;

  for (const [component, keys] of Object.entries(BURN_COMPONENT_KEYS)) {
    const found = getNumericField(entry, keys);
    if (found) {
      const raw = found.value;
      const abs = Math.abs(raw);
      components[component] = {
        value: abs,
        rawValue: raw,
        sourceKey: found.key,
      };
      total += abs;
      rawTotal += raw;
    } else {
      missing.push(component);
    }
  }

  for (const [component, keys] of Object.entries(OPTIONAL_BURN_COMPONENT_KEYS)) {
    const found = getNumericField(entry, keys);
    if (found) {
      const raw = found.value;
      const abs = Math.abs(raw);
      components[component] = {
        value: abs,
        rawValue: raw,
        sourceKey: found.key,
      };
      total += abs;
      rawTotal += raw;
    } else {
      missingOptional.push(component);
    }
  }

  return {
    hasAny: Object.keys(components).length > 0,
    hasAll: missing.length === 0,
    total,
    rawTotal,
    components,
    missingComponents: missing,
    missingOptionalComponents: missingOptional,
  };
}

function collectBurnRelatedNutritionKeys(entries) {
  const keys = new Set();
  for (const entry of entries) {
    for (const key of Object.keys(entry || {})) {
      if (/bmr|tef|therm|exercise|tracker|activity|burn|expend|balance|energy/i.test(key)) {
        keys.add(key);
      }
    }
  }
  return Array.from(keys).sort();
}

function normalizeNutritionList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return [data];
}

function normalizeExerciseList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return [data];
}

function mapEnergyScrapeByDate(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const date = typeof entry?.date === "string" ? entry.date : null;
    if (!date) continue;
    map.set(date, entry);
  }
  return map;
}

function aggregateBurnedByDate(exercises) {
  const byDate = new Map();

  for (const entry of exercises) {
    const date = typeof entry?.date === "string" ? entry.date : null;
    if (!date) continue;

    const raw = parseNumber(entry?.caloriesBurned) ?? 0;
    const abs = Math.abs(raw);

    const existing = byDate.get(date) || {
      burnedRawCalories: 0,
      burnedCalories: 0,
      entries: 0,
      components: {},
    };
    existing.burnedRawCalories += raw;
    existing.burnedCalories += abs;
    existing.entries += 1;
    const component = typeof entry?.exercise === "string" ? entry.exercise : "Unknown";
    existing.components[component] = (existing.components[component] || 0) + abs;
    byDate.set(date, existing);
  }

  return byDate;
}

function computeCalorieBalance(entries, explicitTarget) {
  const perDay = [];

  for (const entry of entries) {
    const intake = parseNumber(entry?.calories);
    const inferred = inferTargetCalories(entry);
    const target = explicitTarget ?? inferred?.target ?? null;
    const delta = intake !== null && target !== null ? intake - target : null;

    perDay.push({
      date: entry?.date || null,
      calories: intake,
      targetCalories: target,
      netCalories: delta,
      status:
        delta === null ? "unknown" : delta > 0 ? "surplus" : delta < 0 ? "deficit" : "at_target",
      targetSource:
        explicitTarget !== null
          ? "explicit"
          : inferred?.source || "none",
    });
  }

  const complete = perDay.filter((d) => d.netCalories !== null);
  const totalNet = complete.reduce((sum, d) => sum + d.netCalories, 0);
  const totalDeficit = complete
    .filter((d) => d.netCalories < 0)
    .reduce((sum, d) => sum + Math.abs(d.netCalories), 0);
  const totalSurplus = complete
    .filter((d) => d.netCalories > 0)
    .reduce((sum, d) => sum + d.netCalories, 0);

  return {
    days: perDay.length,
    daysWithTarget: complete.length,
    totalNetCalories: totalNet,
    totalDeficitCalories: totalDeficit,
    totalSurplusCalories: totalSurplus,
    trend:
      totalNet > 0
        ? "surplus"
        : totalNet < 0
          ? "deficit"
          : "at_target",
    perDay,
  };
}

app.use(apiKeyMiddleware);

app.get(
  "/health",
  asyncRoute(async (_req, res) => {
    const cronoVersion = await readCronoVersion();
    res.json({
      status: "ok",
      wrapperVersion: APP_VERSION,
      cronoVersion,
      requireApiKey: REQUIRE_API_KEY,
    });
  })
);

app.get(
  "/api/v1/endpoints",
  asyncRoute(async (_req, res) => {
    res.json({
      read: [
        "GET /api/v1/diary?date=YYYY-MM-DD|range=7d",
        "GET /api/v1/weight?date=YYYY-MM-DD|range=7d",
        "GET /api/v1/export/{nutrition|exercises|biometrics}?date=YYYY-MM-DD|range=7d&csv=true",
        "GET /api/v1/summary/today-macros?date=YYYY-MM-DD",
        "GET /api/v1/summary/calorie-balance?days=7&target_kcal=2400",
        "GET /api/v1/summary/weekly-average-deficit?days=7",
      ],
      write: [
        "POST /api/v1/quick-add",
        "POST /api/v1/add/custom-food",
        "POST /api/v1/log",
        "POST /api/v1/admin/sync-credentials",
      ],
    });
  })
);

app.get(
  "/api/v1/diary",
  asyncRoute(async (req, res) => {
    const args = ["diary", ...buildDateArgs(req.query), "--json"];
    const data = await runCronoJson(args);
    res.json({ data });
  })
);

app.get(
  "/api/v1/weight",
  asyncRoute(async (req, res) => {
    const args = ["weight", ...buildDateArgs(req.query), "--json"];
    const data = await runCronoJson(args);
    res.json({ data });
  })
);

app.get(
  "/api/v1/export/:type",
  asyncRoute(async (req, res) => {
    const { type } = req.params;
    if (!["nutrition", "exercises", "biometrics"].includes(type)) {
      throw new HttpError(400, "Invalid export type");
    }

    const dateArgs = buildDateArgs(req.query);
    const csv = toBool(req.query.csv);
    const args = ["export", type, ...dateArgs, csv ? "--csv" : "--json"];

    if (csv) {
      const { stdout } = await runCrono(args);
      res.type("text/csv").send(stdout);
      return;
    }

    const data = await runCronoJson(args);
    res.json({ data });
  })
);

app.post(
  "/api/v1/quick-add",
  asyncRoute(async (req, res) => {
    const protein = parseNumber(req.body?.protein);
    const carbs = parseNumber(req.body?.carbs);
    const fat = parseNumber(req.body?.fat);
    const meal = typeof req.body?.meal === "string" ? req.body.meal.trim() : "";

    if (protein === null && carbs === null && fat === null) {
      throw new HttpError(400, "At least one of protein, carbs, fat is required");
    }

    const args = ["quick-add"];
    if (protein !== null) args.push("--protein", String(protein));
    if (carbs !== null) args.push("--carbs", String(carbs));
    if (fat !== null) args.push("--fat", String(fat));
    if (meal) args.push("--meal", meal);

    const result = await runCrono(args);
    res.json({ ok: true, output: result.stdout });
  })
);

app.post(
  "/api/v1/add/custom-food",
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const protein = parseNumber(req.body?.protein);
    const carbs = parseNumber(req.body?.carbs);
    const fat = parseNumber(req.body?.fat);
    const total = parseNumber(req.body?.total);
    const log = req.body?.log;

    if (!name) {
      throw new HttpError(400, "name is required");
    }
    if (protein === null && carbs === null && fat === null) {
      throw new HttpError(400, "At least one of protein, carbs, fat is required");
    }

    const args = ["add", "custom-food", name];
    if (protein !== null) args.push("--protein", String(protein));
    if (carbs !== null) args.push("--carbs", String(carbs));
    if (fat !== null) args.push("--fat", String(fat));
    if (total !== null) args.push("--total", String(total));

    if (typeof log === "boolean" && log) {
      args.push("--log");
    } else if (typeof log === "string" && log.trim() !== "") {
      args.push("--log", log.trim());
    }

    const result = await runCrono(args);
    res.json({ ok: true, output: result.stdout });
  })
);

app.post(
  "/api/v1/log",
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const meal = typeof req.body?.meal === "string" ? req.body.meal.trim() : "";
    const servings = parseNumber(req.body?.servings);

    if (!name) {
      throw new HttpError(400, "name is required");
    }

    const args = ["log", name];
    if (meal) args.push("--meal", meal);
    if (servings !== null) args.push("--servings", String(servings));

    const result = await runCrono(args);
    res.json({ ok: true, output: result.stdout });
  })
);

app.get(
  "/api/v1/summary/today-macros",
  asyncRoute(async (req, res) => {
    const hasDate =
      typeof req.query.date === "string" && req.query.date.trim() !== "";
    const date = hasDate ? req.query.date.trim() : null;

    const args = ["export", "nutrition"];
    if (date) {
      args.push("--date", date);
    }
    args.push("--json");

    const data = await runCronoJson(args);
    const entry = Array.isArray(data) ? data[0] : data;

    if (!entry) {
      throw new HttpError(404, "No nutrition data returned");
    }

    res.json({
      date: entry.date || date,
      calories: parseNumber(entry.calories),
      protein: parseNumber(entry.protein),
      carbs: parseNumber(entry.carbs),
      fat: parseNumber(entry.fat),
      raw: entry,
    });
  })
);

app.get(
  "/api/v1/summary/calorie-balance",
  asyncRoute(async (req, res) => {
    const daysRaw = parseNumber(req.query.days);
    const days = daysRaw === null ? 7 : Math.trunc(daysRaw);
    if (days <= 0 || days > 365) {
      throw new HttpError(400, "days must be between 1 and 365");
    }

    const range =
      typeof req.query.range === "string" && req.query.range.trim() !== ""
        ? req.query.range.trim()
        : `${days}d`;

    const targetFromQuery = parseNumber(req.query.target_kcal);
    const targetFromEnv = parseNumber(process.env.CRONO_DEFAULT_CALORIE_TARGET);
    const explicitTarget = targetFromQuery ?? targetFromEnv;

    const data = await runCronoJson([
      "export",
      "nutrition",
      "--range",
      range,
      "--json",
    ]);
    const entries = normalizeNutritionList(data);

    const balance = computeCalorieBalance(entries, explicitTarget);
    res.json({
      range,
      explicitTargetCalories: explicitTarget,
      notes:
        explicitTarget === null
          ? "No explicit target provided. API attempts to infer target calories from Cronometer export columns when possible."
          : "Using explicit calorie target for all days.",
      ...balance,
    });
  })
);

app.get(
  "/api/v1/summary/weekly-average-deficit",
  asyncRoute(async (req, res) => {
    const daysRaw = parseNumber(req.query.days);
    const days = daysRaw === null ? 7 : Math.trunc(daysRaw);
    if (days <= 0 || days > 365) {
      throw new HttpError(400, "days must be between 1 and 365");
    }

    const explicitRange =
      typeof req.query.range === "string" && req.query.range.trim() !== ""
        ? req.query.range.trim()
        : null;
    const trailing = buildTrailingRangeExcludingToday(days);
    const rangeSpec = explicitRange || trailing.rangeSpec;
    const todayLocal = formatLocalDate(new Date());

    const nutritionRaw = await runCronoJsonWithRetry([
      "export",
      "nutrition",
      "--range",
      rangeSpec,
      "--json",
    ]);
    const nutritionEntries = normalizeNutritionList(nutritionRaw);
    const burnRelatedNutritionKeys = collectBurnRelatedNutritionKeys(
      nutritionEntries
    );

    const completedEntries = nutritionEntries.filter((entry) => {
      const date = typeof entry?.date === "string" ? entry.date : "";
      const isCompleted = String(entry?.Completed || "").toLowerCase() === "true";
      const notToday = date !== todayLocal;
      return isCompleted && notToday;
    });

    const completedDates = completedEntries
      .map((entry) => (typeof entry?.date === "string" ? entry.date : null))
      .filter(Boolean);

    let scrapeError = null;
    let scrapedEntries = [];
    if (completedDates.length > 0) {
      try {
        scrapedEntries = await scrapeEnergySummaryForDates(completedDates);
      } catch (error) {
        scrapeError = error instanceof Error ? error.message : String(error);
      }
    }
    const scrapedByDate = mapEnergyScrapeByDate(scrapedEntries);

    const needsExerciseFallback = completedEntries.some((entry) => {
      const date = entry?.date;
      if (!date) return true;

      const scraped = scrapedByDate.get(date);
      if (
        scraped &&
        (scraped.hasAllCoreComponents ||
          scraped.energyBurned !== null ||
          scraped.componentTotal > 0)
      ) {
        return false;
      }

      const burnComponents = extractBurnedComponents(entry);
      if (burnComponents.hasAny) return false;

      const inferredBurned = inferBurnedCalories(entry);
      if (inferredBurned) return false;

      return true;
    });

    let burnedByDate = new Map();
    let exercisesError = null;
    if (needsExerciseFallback) {
      try {
        const exercisesRetried = await runCronoJsonWithRetry([
          "export",
          "exercises",
          "--range",
          rangeSpec,
          "--json",
        ]);
        const exerciseEntries = normalizeExerciseList(exercisesRetried);
        burnedByDate = aggregateBurnedByDate(exerciseEntries);
      } catch (error) {
        exercisesError = error instanceof Error ? error.message : String(error);
      }
    }

    const perDay = completedEntries.map((entry) => {
      const date = entry?.date || null;
      const consumed = parseNumber(entry?.calories) ?? 0;
      const burnedAgg = date ? burnedByDate.get(date) : null;
      const inferredBurned = inferBurnedCalories(entry);
      const burnComponents = extractBurnedComponents(entry);
      const scraped = date ? scrapedByDate.get(date) : null;

      let burned = null;
      let burnedRaw = null;
      let burnedSource = "none";
      let burnedBreakdown = {};
      let missingBurnComponents = Object.keys(BURN_COMPONENT_KEYS);

      const scrapedComponentTotal =
        scraped?.componentTotalWithBaseline ??
        scraped?.componentTotal ??
        scraped?.componentTotalCore ??
        0;

      if (scraped?.energyBurned !== null && scraped?.energyBurned !== undefined) {
        burned = Math.abs(scraped.energyBurned);
        burnedRaw = scraped.energyBurned;
        burnedSource = "scrape_energy_burned_total";
        burnedBreakdown = {
          ...scraped.components,
          energyBurned: scraped.energyBurned,
          componentTotalCore: scraped.componentTotalCore ?? null,
          componentTotalWithBaseline: scraped.componentTotalWithBaseline ?? null,
        };
        missingBurnComponents = scraped.missingComponents || Object.keys(BURN_COMPONENT_KEYS);
      } else if (scraped?.hasAllCoreComponents && scrapedComponentTotal > 0) {
        burned = scrapedComponentTotal;
        burnedRaw = scrapedComponentTotal;
        burnedSource = "scrape_components_complete";
        burnedBreakdown = scraped.components;
        missingBurnComponents = [];
      } else if (scrapedComponentTotal > 0) {
        burned = scrapedComponentTotal;
        burnedRaw = scrapedComponentTotal;
        burnedSource = "scrape_components_partial";
        burnedBreakdown = scraped.components;
        missingBurnComponents = scraped.missingComponents || Object.keys(BURN_COMPONENT_KEYS);
      } else if (burnComponents.hasAny) {
        burned = burnComponents.total;
        burnedRaw = burnComponents.rawTotal;
        burnedSource = burnComponents.hasAll
          ? "nutrition_components_complete"
          : "nutrition_components_partial";
        burnedBreakdown = burnComponents.components;
        missingBurnComponents = burnComponents.missingComponents;
      } else if (inferredBurned) {
        burned = inferredBurned.burned;
        burnedRaw = inferredBurned.burned;
        burnedSource = inferredBurned.source;
        burnedBreakdown = { inferred: inferredBurned.burned };
      } else if (burnedAgg) {
        burned = burnedAgg.burnedCalories;
        burnedRaw = burnedAgg.burnedRawCalories;
        burnedSource = "exercise_export_abs";
        burnedBreakdown = burnedAgg.components;
        missingBurnComponents = ["bmr", "tef"];
      }

      const burnedFinal = burned ?? 0;
      const burnedRawFinal = burnedRaw ?? 0;
      const net = consumed - burnedFinal;

      return {
        date,
        completed: true,
        consumedCalories: consumed,
        burnedCalories: burnedFinal,
        burnedRawCalories: burnedRawFinal,
        burnedSource,
        burnedBreakdown,
        missingBurnComponents,
        netCalories: net,
        status: net < 0 ? "deficit" : net > 0 ? "surplus" : "at_target",
      };
    });

    const daysWithoutBurnSource = perDay
      .filter((day) => day.burnedSource === "none")
      .map((day) => day.date)
      .filter(Boolean);
    if (daysWithoutBurnSource.length > 0) {
      throw new HttpError(
        503,
        "Unable to determine burned calories for one or more completed days.",
        {
          range: rangeSpec,
          daysWithoutBurnSource,
          scrapeError,
          exercisesFallbackError: exercisesError,
        }
      );
    }

    const daysUsed = perDay.length;
    const consumedTotal = perDay.reduce((sum, d) => sum + d.consumedCalories, 0);
    const burnedTotal = perDay.reduce((sum, d) => sum + d.burnedCalories, 0);
    const burnedRawTotal = perDay.reduce((sum, d) => sum + d.burnedRawCalories, 0);
    const netTotal = consumedTotal - burnedTotal;
    const averagePerDay = daysUsed === 0 ? 0 : netTotal / daysUsed;
    const averageDeficitPerDay = averagePerDay < 0 ? Math.abs(averagePerDay) : 0;
    const averageSurplusPerDay = averagePerDay > 0 ? averagePerDay : 0;
    const completeBurnSources = new Set([
      "scrape_components_complete",
      "scrape_energy_burned_total",
      "nutrition_components_complete",
    ]);
    const partialBurnSources = new Set([
      "scrape_components_partial",
      "nutrition_components_partial",
    ]);
    const daysWithCompleteComponents = perDay.filter((d) =>
      completeBurnSources.has(d.burnedSource)
    ).length;
    const daysWithPartialComponents = perDay.filter((d) =>
      partialBurnSources.has(d.burnedSource)
    ).length;
    const daysUsingFallback = perDay.filter(
      (d) =>
        !completeBurnSources.has(d.burnedSource) &&
        !partialBurnSources.has(d.burnedSource)
    ).length;
    const missingComponentCounts = { bmr: 0, tef: 0, exercise: 0, trackerActivity: 0 };
    for (const day of perDay) {
      for (const component of day.missingBurnComponents || []) {
        if (Object.prototype.hasOwnProperty.call(missingComponentCounts, component)) {
          missingComponentCounts[component] += 1;
        }
      }
    }
    const dataQuality =
      daysWithCompleteComponents === daysUsed && daysUsed > 0
        ? "component_complete"
        : daysWithPartialComponents > 0 || daysUsingFallback > 0
          ? "component_incomplete"
          : "no_completed_days";
    const burnSourceCounts = {};
    for (const day of perDay) {
      burnSourceCounts[day.burnedSource] = (burnSourceCounts[day.burnedSource] || 0) + 1;
    }

    res.json({
      range: rangeSpec,
      trailingWindowExcludingToday:
        explicitRange === null
          ? { start: trailing.start, end: trailing.end }
          : null,
      daysRequested: days,
      daysUsed,
      completedOnly: true,
      formula:
        "(trailing calories consumed total - trailing calories burned total) / daysUsed",
      totals: {
        consumedCalories: consumedTotal,
        burnedCalories: burnedTotal,
        burnedRawCalories: burnedRawTotal,
        netCalories: netTotal,
      },
      averageNetCaloriesPerDay: averagePerDay,
      averageDeficitPerDay,
      averageSurplusPerDay,
      averageStatus:
        averagePerDay < 0
          ? "deficit"
          : averagePerDay > 0
            ? "surplus"
            : "at_target",
      diagnostics: {
        dataQuality,
        daysWithCompleteComponents,
        daysWithPartialComponents,
        daysUsingFallback,
        missingComponentCounts,
        burnRelatedNutritionKeys,
        burnSourceCounts,
        scrapeAttempted: completedDates.length > 0,
        scrapeDaysRequested: completedDates.length,
        scrapeDaysReturned: scrapedEntries.length,
        scrapeError,
        scrapePreview: scrapedEntries,
        exercisesFallbackAttempted: needsExerciseFallback,
        exercisesFallbackError: exercisesError,
        fallbackReason:
          dataQuality === "component_incomplete"
            ? "Missing complete burn components in scrape/export for one or more completed days."
            : null,
      },
      notes: [
        "completed days only are included",
        "today is excluded by date even if marked completed",
        "default range is yesterday-back for requested day count",
        "burnedCalories first uses scraped Cronometer Energy Summary data when available",
        "scrape prefers scraped Energy Burned total; else uses BMR + TEF + Exercise + Tracker Activity (+ Baseline when present)",
        "if scrape/export components are unavailable, endpoint falls back to inferred burned fields or exercise export totals",
        "burnedRawCalories preserves raw source sign/value",
        "if averageNetCaloriesPerDay is positive, that is an average surplus",
      ],
      perDay,
    });
  })
);

app.post(
  "/api/v1/admin/sync-credentials",
  asyncRoute(async (req, res) => {
    const merged = {
      ...process.env,
      CRONO_KERNEL_API_KEY:
        req.body?.kernelApiKey || process.env.CRONO_KERNEL_API_KEY,
      CRONO_CRONOMETER_EMAIL:
        req.body?.cronometerEmail || process.env.CRONO_CRONOMETER_EMAIL,
      CRONO_CRONOMETER_PASSWORD:
        req.body?.cronometerPassword || process.env.CRONO_CRONOMETER_PASSWORD,
    };

    const result = await syncCredentials(merged);
    res.json({ ok: true, ...result });
  })
);

app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const payload = {
    error: err?.message || "Internal server error",
  };
  if (err?.extra) payload.details = err.extra;
  res.status(status).json(payload);
});

app.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      message: "crono-api started",
      host: HOST,
      port: PORT,
      requireApiKey: REQUIRE_API_KEY,
      cronoBin: CRONO_BIN,
    })
  );
});
