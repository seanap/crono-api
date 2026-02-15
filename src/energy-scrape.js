import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";

const DEFAULT_CREDENTIALS_MODULE =
  "/app/runtime/node_modules/@milldr/crono/dist/credentials.js";
const DEFAULT_KERNEL_SDK_MODULE_CANDIDATES = [
  "/app/runtime/node_modules/@onkernel/sdk/index.mjs",
  "/app/runtime/node_modules/@onkernel/sdk/index.js",
  "/app/runtime/node_modules/@onkernel/sdk/dist/index.js",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDates(dates) {
  const unique = new Set();
  for (const date of dates || []) {
    if (typeof date !== "string") continue;
    const trimmed = date.trim();
    if (DATE_RE.test(trimmed)) unique.add(trimmed);
  }
  return Array.from(unique).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

async function loadCredentialsModule(raw = process.env) {
  const modulePath = raw.CRONO_CREDENTIALS_MODULE || DEFAULT_CREDENTIALS_MODULE;
  const moduleUrl = pathToFileURL(modulePath).href;
  const mod = await import(moduleUrl);
  if (typeof mod.getCredential !== "function") {
    throw new Error(
      `Invalid credentials module at ${modulePath}: getCredential() not found`
    );
  }
  return mod;
}

async function importFirstExistingModule(candidates) {
  let lastError = null;
  for (const modulePath of candidates) {
    try {
      await access(modulePath);
      const moduleUrl = pathToFileURL(modulePath).href;
      return await import(moduleUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to load module from candidates: ${candidates.join(", ")} (${lastError})`
  );
}

async function loadKernelClass(raw = process.env) {
  const configured = raw.CRONO_KERNEL_SDK_MODULE;
  const candidates = configured
    ? [configured]
    : DEFAULT_KERNEL_SDK_MODULE_CANDIDATES;
  const mod = await importFirstExistingModule(candidates);
  const Kernel = mod.default || mod.Kernel;
  if (typeof Kernel !== "function") {
    throw new Error(`Invalid Kernel SDK module from candidates: ${candidates.join(", ")}`);
  }
  return Kernel;
}

function getRequiredCredential(envKey, credKey, raw, credentialsModule) {
  const envValue = raw[envKey];
  if (typeof envValue === "string" && envValue.trim() !== "") {
    return envValue.trim();
  }
  const fromStore = credentialsModule.getCredential(credKey);
  if (typeof fromStore === "string" && fromStore.trim() !== "") {
    return fromStore.trim();
  }
  throw new Error(`Missing credential: ${envKey}`);
}

function buildAutoLoginCode(username, password) {
  const safeUser = JSON.stringify(username);
  const safePass = JSON.stringify(password);

  return `
    await page.goto('https://cronometer.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const loginLinkSelectors = ['a[href="/login/"]', 'a[href="/login"]', 'a:has-text("Log In")', 'a:has-text("Login")'];
    let clickedLogin = false;
    for (const sel of loginLinkSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().click();
          clickedLogin = true;
          break;
        }
      } catch {}
    }
    if (!clickedLogin) {
      await page.goto('https://cronometer.com/login/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    await page.waitForSelector('input[type="email"], input[name="username"], input[name="email"], #email, #username', { timeout: 10000 }).catch(() => {});

    const emailSelectors = ['input[type="email"]', 'input[name="username"]', 'input[name="email"]', '#email', '#username'];
    let emailFilled = false;
    for (const sel of emailSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().fill(${safeUser});
          emailFilled = true;
          break;
        }
      } catch {}
    }
    if (!emailFilled) {
      return { success: false, loggedIn: false, url: page.url(), error: 'Could not find email input' };
    }

    const passSelectors = ['input[type="password"]', 'input[name="password"]', '#password'];
    let passFilled = false;
    for (const sel of passSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().fill(${safePass});
          passFilled = true;
          break;
        }
      } catch {}
    }
    if (!passFilled) {
      return { success: false, loggedIn: false, url: page.url(), error: 'Could not find password input' };
    }

    const submitSelectors = ['#login-button', 'button:has-text("LOG IN")', 'button:has-text("Log In")', 'button[type="submit"]', 'input[type="submit"]'];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().click();
          submitted = true;
          break;
        }
      } catch {}
    }
    if (!submitted) {
      return { success: false, loggedIn: false, url: page.url(), error: 'Could not find submit button' };
    }

    await page.waitForURL(u => !u.href.includes('/login') && !u.href.includes('/signin'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    const url = page.url();
    const loggedIn = !url.includes('/login') && !url.includes('/signin');
    let loginError = null;
    if (!loggedIn) {
      loginError = await page.evaluate(() => {
        const selectors = [
          ".error-message",
          ".alert",
          ".notification",
          "[class*='error']",
          "[class*='alert']",
          ".gwt-HTML",
        ];
        for (const sel of selectors) {
          const elements = document.querySelectorAll(sel);
          for (const el of elements) {
            const text = el.textContent?.trim();
            if (
              text &&
              text.length > 5 &&
              text.length < 400 &&
              el instanceof HTMLElement &&
              el.offsetParent !== null
            ) {
              return text;
            }
          }
        }
        return null;
      });
    }

    return { success: true, loggedIn, url, loginError };
  `;
}

function buildEnergyScrapeCode(dates) {
  const safeDates = JSON.stringify(dates);

  return `
    const dates = ${safeDates};
    const entries = [];

    async function clickPrevDay() {
      const prev = page.locator('i.diary-date-previous').filter({ visible: true });
      if (await prev.count() > 0) {
        await prev.first().click();
        await page.waitForTimeout(1300);
        return true;
      }
      return false;
    }

    async function gotoDateBySteppingBack(daysBack) {
      if (daysBack <= 0) return;
      for (let i = 0; i < daysBack; i++) {
        const ok = await clickPrevDay();
        if (!ok) break;
      }
    }

    async function extractEnergySummary() {
      return await page.evaluate(() => {
        function num(str) {
          if (typeof str !== "string") return null;
          const cleaned = str
            .replace(/[−–—]/g, "-")
            .replace(/,/g, "")
            .trim();
          const n = Number(cleaned);
          return Number.isFinite(n) ? n : null;
        }
        function escRegex(value) {
          const specials = "\\\\^$.*+?()[]{}|";
          let out = "";
          for (const ch of String(value || "")) {
            out += specials.includes(ch) ? "\\\\" + ch : ch;
          }
          return out;
        }
        function extractFromText(text, labels) {
          if (!text) return null;
          for (const label of labels) {
            const e = escRegex(label);
            const after = new RegExp(
              e + "[^\\\\n\\\\r]{0,120}?([−–—-]?\\\\d[\\\\d,]*(?:\\\\.\\\\d+)?)\\\\s*(?:k?cal(?:ories)?)?",
              "i"
            );
            const m1 = text.match(after);
            if (m1) return num(m1[1]);

            const before = new RegExp(
              "([−–—-]?\\\\d[\\\\d,]*(?:\\\\.\\\\d+)?)\\\\s*(?:k?cal(?:ories)?)?[^\\\\n\\\\r]{0,120}?" + e,
              "i"
            );
            const m2 = text.match(before);
            if (m2) return num(m2[1]);
          }
          return null;
        }

        function visible(el) {
          if (!el) return false;
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function extractMetric(labels) {
          const bodyText = document.body.innerText.replace(/\\u00a0/g, " ");
          const direct = extractFromText(bodyText, labels);
          if (direct !== null) return direct;

          const candidates = Array.from(
            document.querySelectorAll("div, section, article, tr, li, p, span, td, th")
          );

          for (const el of candidates) {
            if (!visible(el)) continue;
            const text = (el.textContent || "").replace(/\\u00a0/g, " ").trim();
            if (!text || text.length > 400) continue;

            let matchedLabel = false;
            for (const label of labels) {
              if (text.toLowerCase().includes(label.toLowerCase())) {
                matchedLabel = true;
                break;
              }
            }
            if (!matchedLabel) continue;

            const fromSelf = extractFromText(text, labels);
            if (fromSelf !== null) return fromSelf;

            const parent = el.closest("tr, li, section, article, div");
            const parentText = (parent?.textContent || "")
              .replace(/\\u00a0/g, " ")
              .trim()
              .slice(0, 1000);
            const fromParent = extractFromText(parentText, labels);
            if (fromParent !== null) return fromParent;
          }

          return null;
        }

        const text = document.body.innerText.replace(/\\u00a0/g, " ");

        const bmr = extractMetric([
          "Basal Metabolic Rate",
          "BMR",
          "Resting Metabolic Rate",
          "RMR",
        ]);
        const tef = extractMetric([
          "Thermic Effect of Food",
          "Thermal Effect of Food",
          "TEF",
        ]);
        const exercise = extractMetric([
          "Exercise",
          "Exercises",
          "Active Exercise",
          "Workout",
        ]);
        const trackerActivity = extractMetric([
          "Tracker Activity",
          "Tracker Calories",
          "Daily Activity",
          "Activity",
        ]);
        const baseline = extractMetric([
          "Baseline",
          "Baseline Activity",
          "Base",
          "Resting Expenditure",
        ]);
        const energyBurned = extractMetric([
          "Energy Burned",
          "Calories Burned",
          "Total Burned",
          "Burned",
          "Expenditure",
          "Expenditure",
          "Energy Expenditure",
          "Total Expenditure",
        ]);
        const energyBalance = extractMetric([
          "Energy Balance",
          "Calorie Balance",
        ]);

        return {
          bmr,
          tef,
          exercise,
          trackerActivity,
          baseline,
          energyBurned,
          energyBalance,
        };
      });
    }

    await page.goto('https://cronometer.com/#diary', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < dates.length; i++) {
      const targetDate = dates[i];

      if (i === 0) {
        const target = new Date(targetDate + 'T00:00:00');
        const daysBack = Math.max(0, Math.round((today - target) / ${DAY_MS}));
        await gotoDateBySteppingBack(daysBack);
      } else {
        const prev = new Date(dates[i - 1] + 'T00:00:00');
        const target = new Date(targetDate + 'T00:00:00');
        const stepBack = Math.max(0, Math.round((prev - target) / ${DAY_MS}));
        await gotoDateBySteppingBack(stepBack);
      }

      const extracted = await extractEnergySummary();
      entries.push({ date: targetDate, ...extracted });
    }

    return { success: true, entries };
  `;
}

function normalizeScrapedEntry(entry) {
  const bmr = entry?.bmr ?? null;
  const tef = entry?.tef ?? null;
  const exercise = entry?.exercise ?? null;
  const trackerActivity = entry?.trackerActivity ?? null;
  const baseline = entry?.baseline ?? null;
  const energyBurned = entry?.energyBurned ?? null;
  const energyBalance = entry?.energyBalance ?? null;

  const core = { bmr, tef, exercise, trackerActivity };
  const missingComponents = Object.entries(core)
    .filter(([, value]) => value === null || value === undefined)
    .map(([key]) => key);
  const componentTotalCore = Object.values(core).reduce(
    (sum, value) => sum + Math.abs(Number(value || 0)),
    0
  );
  const componentTotalWithBaseline =
    componentTotalCore + Math.abs(Number(baseline || 0));
  const energyBurnedAbs =
    energyBurned === null ? null : Math.abs(Number(energyBurned));
  const energyBalanceRaw =
    energyBalance === null ? null : Number(energyBalance);
  const energyBalanceAbs =
    energyBalanceRaw === null ? null : Math.abs(energyBalanceRaw);

  const burnCandidates = {
    energyBurned: energyBurnedAbs,
    energyBalance:
      energyBalanceRaw !== null && energyBalanceRaw > 0 ? energyBalanceAbs : null,
    componentTotalWithBaseline,
  };
  if (
    burnCandidates.energyBalance !== null &&
    componentTotalWithBaseline > 0
  ) {
    const ratio = burnCandidates.energyBalance / componentTotalWithBaseline;
    if (ratio < 0.7 || ratio > 1.8) {
      burnCandidates.energyBalance = null;
    }
  }
  const resolvedBurnedEntry = Object.entries(burnCandidates)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])[0] || null;
  const resolvedBurnedSource = resolvedBurnedEntry ? resolvedBurnedEntry[0] : null;
  const resolvedBurnedTotal = resolvedBurnedEntry ? resolvedBurnedEntry[1] : 0;

  return {
    date: entry?.date || null,
    components: {
      bmr: bmr === null ? null : Math.abs(Number(bmr)),
      tef: tef === null ? null : Math.abs(Number(tef)),
      exercise: exercise === null ? null : Math.abs(Number(exercise)),
      trackerActivity:
        trackerActivity === null ? null : Math.abs(Number(trackerActivity)),
      baseline: baseline === null ? null : Math.abs(Number(baseline)),
    },
    energyBurned: energyBurnedAbs,
    energyBalance: energyBalanceRaw,
    missingComponents,
    hasAllCoreComponents: missingComponents.length === 0,
    componentTotalCore,
    componentTotalWithBaseline,
    burnCandidates,
    resolvedBurnedSource,
    resolvedBurnedTotal,
    // Backward-compatible alias for existing diagnostics consumers.
    componentTotal: componentTotalWithBaseline,
  };
}

export async function scrapeEnergySummaryForDates(
  dates,
  { onStatus } = {}
) {
  const normalizedDates = normalizeDates(dates);
  if (normalizedDates.length === 0) return [];

  const credentialsModule = await loadCredentialsModule(process.env);
  const kernelApiKey = getRequiredCredential(
    "CRONO_KERNEL_API_KEY",
    "kernel-api-key",
    process.env,
    credentialsModule
  );
  const username = getRequiredCredential(
    "CRONO_CRONOMETER_EMAIL",
    "cronometer-username",
    process.env,
    credentialsModule
  );
  const password = getRequiredCredential(
    "CRONO_CRONOMETER_PASSWORD",
    "cronometer-password",
    process.env,
    credentialsModule
  );

  process.env.KERNEL_API_KEY = kernelApiKey;

  const Kernel = await loadKernelClass(process.env);
  const kernel = new Kernel();

  onStatus?.("Creating Kernel browser session...");
  const browser = await kernel.browsers.create({
    headless: true,
    stealth: true,
    timeout_seconds: 240,
  });

  try {
    onStatus?.("Logging into Cronometer...");
    const loginResult = await kernel.browsers.playwright.execute(
      browser.session_id,
      { code: buildAutoLoginCode(username, password), timeout_sec: 90 }
    );
    const loginData = loginResult?.result || {};
    if (!loginResult?.success || !loginData?.loggedIn) {
      const explicitError =
        loginData?.error || loginData?.loginError || loginResult?.error || "unknown";
      throw new Error(
        `Cronometer login failed during scrape (${explicitError})`
      );
    }

    onStatus?.("Scraping energy summary components...");
    const scrapeResult = await kernel.browsers.playwright.execute(
      browser.session_id,
      { code: buildEnergyScrapeCode(normalizedDates), timeout_sec: 180 }
    );
    if (!scrapeResult?.success) {
      throw new Error(`Energy scrape automation failed: ${scrapeResult?.error}`);
    }
    const data = scrapeResult?.result || {};
    if (!data?.success) {
      throw new Error(`Energy scrape failed: ${data?.error || "unknown"}`);
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    return entries.map(normalizeScrapedEntry);
  } finally {
    try {
      await kernel.browsers.deleteByID(browser.session_id);
    } catch {
      // Ignore cleanup errors
    }
  }
}
