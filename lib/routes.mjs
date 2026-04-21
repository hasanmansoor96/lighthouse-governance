import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

const PAGE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mdx"])
const DEFAULT_APP_DIRS = ["app", "src/app"]
const DEFAULT_PAGES_DIRS = ["pages", "src/pages"]
const DEFAULT_EXCLUDE_PREFIXES = ["/api", "/admin", "/_next"]
const DEFAULT_CONFIG_FILES = [
  ".lighthouse-governance.json",
  "lighthouse-governance.config.json",
  ".lighthouse-governance.mjs",
  "lighthouse-governance.config.mjs",
  ".lighthouse-governance.cjs",
  "lighthouse-governance.config.cjs",
]

export function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitList(item))
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function sanitizeRoute(route) {
  if (typeof route !== "string") return null
  const trimmed = route.trim()
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1)
  }
  return normalized
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8")
  return JSON.parse(raw)
}

async function loadConfigFile(filePath) {
  if (filePath.endsWith(".json")) {
    return loadJsonFile(filePath)
  }

  if (filePath.endsWith(".cjs")) {
    return require(filePath)
  }

  const imported = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`)
  return imported.default || imported
}

async function resolveConfigFile(projectRoot, explicitConfigPath) {
  if (explicitConfigPath) {
    const resolved = path.resolve(projectRoot, explicitConfigPath)
    return (await pathExists(resolved)) ? resolved : null
  }

  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return null
}

export async function loadRouteConfig(projectRoot, explicitConfigPath) {
  const filePath = await resolveConfigFile(projectRoot, explicitConfigPath)
  if (!filePath) {
    return { config: {}, filePath: null }
  }

  const config = await loadConfigFile(filePath)
  if (!config || typeof config !== "object") {
    throw new Error(`Route config must export an object: ${filePath}`)
  }

  return { config, filePath }
}

function routeListFromPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.routes)) return payload.routes
  return []
}

async function loadRoutesFile(projectRoot, routesFile) {
  if (!routesFile) return []
  const filePath = path.resolve(projectRoot, routesFile)
  const payload = await loadJsonFile(filePath)
  return routeListFromPayload(payload)
}

function normalizeConfiguredRoutes(routes) {
  return routeListFromPayload(routes)
    .map(sanitizeRoute)
    .filter(Boolean)
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git" || entry.name === "out") {
      continue
    }

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)))
      continue
    }

    if (entry.isFile() && PAGE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

async function collectCandidateFiles(projectRoot, dirs) {
  const files = []
  for (const dir of dirs) {
    const fullPath = path.resolve(projectRoot, dir)
    if (await pathExists(fullPath)) {
      files.push(...(await collectFiles(fullPath)))
    }
  }
  return files
}

function stripPageExtension(segment) {
  return segment.replace(/\.(js|jsx|ts|tsx|mdx)$/u, "")
}

function isRouteGroup(segment) {
  return segment.startsWith("(") && segment.endsWith(")")
}

function normalizeNextSegments(segments) {
  return segments
    .filter(Boolean)
    .filter((segment) => !isRouteGroup(segment))
    .filter((segment) => !segment.startsWith("@"))
}

function appRouteFromFile(filePath, appRoot) {
  const relative = path.relative(appRoot, filePath)
  const segments = normalizeNextSegments(relative.split(path.sep))
  const last = segments[segments.length - 1]

  if (!last || stripPageExtension(last) !== "page") {
    return null
  }

  const routeSegments = segments.slice(0, -1)
  return sanitizeRoute(routeSegments.join("/") || "/")
}

function pagesRouteFromFile(filePath, pagesRoot) {
  const relative = path.relative(pagesRoot, filePath)
  const segments = normalizeNextSegments(relative.split(path.sep)).map(stripPageExtension)

  if (segments[0] === "api") return null
  const last = segments[segments.length - 1]
  if (!last || last.startsWith("_")) return null

  const routeSegments = last === "index" ? segments.slice(0, -1) : segments
  return sanitizeRoute(routeSegments.join("/") || "/")
}

async function discoverNextRoutes(projectRoot, appDirs, pagesDirs) {
  const routes = []

  for (const appDir of appDirs) {
    const appRoot = path.resolve(projectRoot, appDir)
    if (!(await pathExists(appRoot))) continue
    const files = await collectFiles(appRoot)
    routes.push(...files.map((file) => appRouteFromFile(file, appRoot)).filter(Boolean))
  }

  for (const pagesDir of pagesDirs) {
    const pagesRoot = path.resolve(projectRoot, pagesDir)
    if (!(await pathExists(pagesRoot))) continue
    const files = await collectFiles(pagesRoot)
    routes.push(...files.map((file) => pagesRouteFromFile(file, pagesRoot)).filter(Boolean))
  }

  return routes
}

function isDynamicRoute(route) {
  return typeof route === "string" && /\[[^/]+\]/u.test(route)
}

function matchesAny(route, patterns) {
  return patterns.some((pattern) => {
    if (!pattern) return false
    if (pattern.endsWith("*")) {
      return route.startsWith(pattern.slice(0, -1))
    }
    return route === pattern || route.startsWith(`${pattern}/`)
  })
}

function filterPublicRoutes(routes, config) {
  const excludePrefixes = [
    ...DEFAULT_EXCLUDE_PREFIXES,
    ...normalizeConfiguredRoutes(config.excludePrefixes || []),
  ]
  const excludeRoutes = normalizeConfiguredRoutes(config.excludeRoutes || [])

  return routes.filter((route) => {
    if (!route) return false
    if (/^https?:\/\//i.test(route)) return true
    if (matchesAny(route, excludePrefixes)) return false
    if (excludeRoutes.includes(route)) return false
    return true
  })
}

function routesForProfile(config, profile) {
  const baseRoutes = normalizeConfiguredRoutes(config.routes || [])
  const profileRoutes = profile === "mobile"
    ? normalizeConfiguredRoutes(config.mobileRoutes || config.routesMobile || [])
    : normalizeConfiguredRoutes(config.desktopRoutes || config.routesDesktop || [])

  return [...baseRoutes, ...profileRoutes]
}

function dynamicSamplesForRoutes(dynamicRoutes, sampledRoutes, config) {
  const map = config.dynamicRoutes && typeof config.dynamicRoutes === "object" ? config.dynamicRoutes : {}
  const samples = []
  const unresolved = []

  for (const route of dynamicRoutes) {
    const configured = normalizeConfiguredRoutes(map[route] || [])
    if (configured.length > 0) {
      samples.push(...configured)
    } else {
      unresolved.push(route)
    }
  }

  return {
    samples: [...samples, ...normalizeConfiguredRoutes(sampledRoutes || [])],
    unresolved,
  }
}

async function readSitemapRoutes(baseUrl) {
  const sitemapUrl = new URL("/sitemap.xml", baseUrl).toString()
  try {
    const response = await fetch(sitemapUrl)
    if (!response.ok) {
      return { routes: [], status: `status ${response.status}` }
    }

    const xml = await response.text()
    const routes = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/gu))
      .map((match) => match[1])
      .map((loc) => {
        try {
          const url = new URL(loc)
          return sanitizeRoute(`${url.pathname}${url.search}${url.hash}`)
        } catch {
          return null
        }
      })
      .filter(Boolean)

    return { routes, status: "ok" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { routes: [], status: message }
  }
}

export async function generateRouteManifest(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const profile = options.profile === "mobile" ? "mobile" : "desktop"
  const { config, filePath: configFile } = await loadRouteConfig(projectRoot, options.configPath)

  const cliRoutes = normalizeConfiguredRoutes(options.routes || [])
  const routesFileRoutes = normalizeConfiguredRoutes(await loadRoutesFile(projectRoot, options.routesFile))
  const explicitRoutes = [...cliRoutes, ...routesFileRoutes]

  const appDirs = splitList(options.appDirs).length > 0 ? splitList(options.appDirs) : splitList(config.appDirs || DEFAULT_APP_DIRS)
  const pagesDirs = splitList(options.pagesDirs).length > 0
    ? splitList(options.pagesDirs)
    : splitList(config.pagesDirs || DEFAULT_PAGES_DIRS)
  const discover = explicitRoutes.length === 0 && config.discover !== false

  const discoveredRoutes = discover ? await discoverNextRoutes(projectRoot, appDirs, pagesDirs) : []
  const staticRoutes = discoveredRoutes.filter((route) => !isDynamicRoute(route))
  const dynamicRoutes = discoveredRoutes.filter(isDynamicRoute)
  const dynamicResult = dynamicSamplesForRoutes(dynamicRoutes, options.sampledRoutes, config)
  const configuredRoutes = explicitRoutes.length > 0 ? explicitRoutes : routesForProfile(config, profile)

  const includeSitemap = Boolean(options.includeSitemap || config.includeSitemap)
  const sitemapResult = includeSitemap
    ? await readSitemapRoutes(options.baseUrl || config.baseUrl || "http://127.0.0.1:3100")
    : { routes: [], status: "disabled" }

  const failOnUnresolvedDynamicRoutes = Boolean(
    options.failOnUnresolvedDynamicRoutes || config.failOnUnresolvedDynamicRoutes,
  )

  if (dynamicResult.unresolved.length > 0 && failOnUnresolvedDynamicRoutes) {
    throw new Error(`Unresolved dynamic routes: ${dynamicResult.unresolved.join(", ")}`)
  }

  const routeSet = new Set([
    ...configuredRoutes,
    ...staticRoutes,
    ...dynamicResult.samples,
    ...sitemapResult.routes,
  ])

  if (routeSet.size === 0) {
    routeSet.add("/")
  }

  const routes = filterPublicRoutes(Array.from(routeSet), config)
    .map(sanitizeRoute)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  return {
    baseUrl: options.baseUrl || config.baseUrl || "http://127.0.0.1:3100",
    generatedAt: new Date().toISOString(),
    profile,
    routeCount: routes.length,
    routes,
    sources: {
      configFile,
      explicitRoutes: explicitRoutes.length,
      configuredRoutes: configuredRoutes.length,
      discoveredStaticRoutes: staticRoutes.length,
      discoveredDynamicRoutes: dynamicRoutes.length,
      dynamicSampleRoutes: dynamicResult.samples.length,
      unresolvedDynamicRoutes: dynamicResult.unresolved,
      sitemapRoutes: sitemapResult.routes.length,
      sitemapStatus: sitemapResult.status,
    },
  }
}

export async function writeRouteManifest(options = {}) {
  const manifest = await generateRouteManifest(options)
  const output = path.resolve(options.projectRoot || process.cwd(), options.output || ".lighthouseci/routes.json")
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return { manifest, output }
}
