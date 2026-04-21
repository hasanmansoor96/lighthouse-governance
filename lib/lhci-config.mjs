import fs from "node:fs/promises"
import path from "node:path"

function quote(value) {
  return JSON.stringify(String(value ?? ""))
}

function normalizeThreshold(value, fallback = "") {
  if (value === undefined || value === null) return fallback
  return String(value)
}

export function createLhciConfigSource(options = {}) {
  const defaults = {
    baseUrl: normalizeThreshold(options.baseUrl, "http://127.0.0.1:3100"),
    profile: options.profile === "mobile" ? "mobile" : "desktop",
    routesFile: normalizeThreshold(options.routesFile, ".lighthouseci/routes.json"),
    numberOfRuns: normalizeThreshold(options.numberOfRuns, "1"),
    startServerReadyPattern: normalizeThreshold(options.startServerReadyPattern, "Ready|ready|started server|listening"),
    startServerReadyTimeout: normalizeThreshold(options.startServerReadyTimeout, "180000"),
    uploadTarget: normalizeThreshold(options.uploadTarget, "temporary-public-storage"),
    performanceMinScore: normalizeThreshold(options.performanceMinScore, "0.85"),
    accessibilityMinScore: normalizeThreshold(options.accessibilityMinScore, "0.95"),
    bestPracticesMinScore: normalizeThreshold(options.bestPracticesMinScore, ""),
    seoMinScore: normalizeThreshold(options.seoMinScore, "0.95"),
    lcpMaxMs: normalizeThreshold(options.lcpMaxMs, "2500"),
    tbtMaxMs: normalizeThreshold(options.tbtMaxMs, "200"),
    clsMax: normalizeThreshold(options.clsMax, "0.1"),
    errorsInConsoleMinScore: normalizeThreshold(options.errorsInConsoleMinScore, "1"),
  }

  return `const fs = require("node:fs")
const path = require("node:path")

const defaults = ${JSON.stringify(defaults, null, 2)}

function env(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === null || value === "" ? fallback : value
}

function numberEnv(name, fallback) {
  const value = Number(env(name, fallback))
  return Number.isFinite(value) ? value : Number(fallback)
}

function optionalNumberEnv(name, fallback) {
  const raw = env(name, fallback)
  if (raw === undefined || raw === null || raw === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function loadRoutes(routesFile) {
  const resolved = path.resolve(process.cwd(), routesFile)
  if (!fs.existsSync(resolved)) {
    return ["/"]
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"))
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.routes)) return parsed.routes
  return ["/"]
}

function toUrl(route, baseUrl) {
  if (/^https?:\\/\\//i.test(route)) return route
  return new URL(route, baseUrl).toString()
}

function addMinScore(assertions, id, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  assertions[id] = ["error", { minScore: value }]
}

function addMaxNumericValue(assertions, id, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  assertions[id] = ["error", { maxNumericValue: value }]
}

const baseUrl = env("LHCI_BASE_URL", defaults.baseUrl)
const profile = env("LHCI_PROFILE", defaults.profile) === "mobile" ? "mobile" : "desktop"
const routesFile = env("LHCI_ROUTES_FILE", defaults.routesFile)
const urls = loadRoutes(routesFile).map((route) => toUrl(route, baseUrl))

const settings = {
  chromeFlags: env("LHCI_CHROME_FLAGS", "--no-sandbox --disable-dev-shm-usage"),
}

if (profile === "desktop") {
  settings.preset = "desktop"
}

const assertions = {}
addMinScore(assertions, "categories:performance", optionalNumberEnv("LIGHTHOUSE_PERFORMANCE_MIN_SCORE", defaults.performanceMinScore))
addMinScore(assertions, "categories:accessibility", optionalNumberEnv("LIGHTHOUSE_ACCESSIBILITY_MIN_SCORE", defaults.accessibilityMinScore))
addMinScore(assertions, "categories:best-practices", optionalNumberEnv("LIGHTHOUSE_BEST_PRACTICES_MIN_SCORE", defaults.bestPracticesMinScore))
addMinScore(assertions, "categories:seo", optionalNumberEnv("LIGHTHOUSE_SEO_MIN_SCORE", defaults.seoMinScore))
addMaxNumericValue(assertions, "largest-contentful-paint", optionalNumberEnv("LIGHTHOUSE_LCP_MAX_MS", defaults.lcpMaxMs))
addMaxNumericValue(assertions, "total-blocking-time", optionalNumberEnv("LIGHTHOUSE_TBT_MAX_MS", defaults.tbtMaxMs))
addMaxNumericValue(assertions, "cumulative-layout-shift", optionalNumberEnv("LIGHTHOUSE_CLS_MAX", defaults.clsMax))
addMinScore(assertions, "errors-in-console", optionalNumberEnv("LIGHTHOUSE_ERRORS_IN_CONSOLE_MIN_SCORE", defaults.errorsInConsoleMinScore))

module.exports = {
  ci: {
    collect: {
      url: urls,
      numberOfRuns: numberEnv("LHCI_NUMBER_OF_RUNS", defaults.numberOfRuns),
      startServerCommand: env("LHCI_START_SERVER_COMMAND", ${quote(options.startServerCommand || "npm run start -- --hostname=127.0.0.1 --port=3100")}),
      startServerReadyPattern: env("LHCI_START_SERVER_READY_PATTERN", defaults.startServerReadyPattern),
      startServerReadyTimeout: numberEnv("LHCI_START_SERVER_READY_TIMEOUT", defaults.startServerReadyTimeout),
      settings,
    },
    assert: {
      assertions,
    },
    upload: {
      target: env("LHCI_UPLOAD_TARGET", defaults.uploadTarget),
    },
  },
}
`
}

export async function writeLhciConfig(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const output = path.resolve(projectRoot, options.output || ".lighthouseci/lighthouserc.cjs")
  const source = createLhciConfigSource(options)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, source, "utf8")
  return { output, source }
}
