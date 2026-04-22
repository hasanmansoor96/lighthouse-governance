import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const PAGE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mdx"])
const APP_SUBTREE_FILES = new Set(["layout", "template", "default", "error", "global-error", "loading", "not-found"])
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
    .split(/[,\r\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitLines(value) {
  if (typeof value !== "string") return []
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function booleanOption(...values) {
  return values.some((value) => value === true || value === "true")
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

function toProjectRelativePath(projectRoot, filePath) {
  if (typeof filePath !== "string") return null
  const trimmed = filePath.trim()
  if (!trimmed) return null

  const relative = path.isAbsolute(trimmed) ? path.relative(projectRoot, trimmed) : trimmed
  return relative.replace(/\\/gu, "/").replace(/^\.\//u, "")
}

function isSameOrDescendant(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath)
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
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

function appRouteEntryFromFile(filePath, appRoot) {
  const route = appRouteFromFile(filePath, appRoot)
  if (!route) return null

  return {
    kind: "app",
    route,
    filePath,
    routeRoot: path.dirname(filePath),
  }
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

function pagesRouteEntryFromFile(filePath, pagesRoot) {
  const route = pagesRouteFromFile(filePath, pagesRoot)
  if (!route) return null

  return {
    kind: "pages",
    route,
    filePath,
    routeRoot: path.dirname(filePath),
  }
}

async function discoverNextRouteEntries(projectRoot, appDirs, pagesDirs) {
  const entries = []

  for (const appDir of appDirs) {
    const appRoot = path.resolve(projectRoot, appDir)
    if (!(await pathExists(appRoot))) continue
    const files = await collectFiles(appRoot)
    entries.push(...files.map((file) => appRouteEntryFromFile(file, appRoot)).filter(Boolean))
  }

  for (const pagesDir of pagesDirs) {
    const pagesRoot = path.resolve(projectRoot, pagesDir)
    if (!(await pathExists(pagesRoot))) continue
    const files = await collectFiles(pagesRoot)
    entries.push(...files.map((file) => pagesRouteEntryFromFile(file, pagesRoot)).filter(Boolean))
  }

  return entries
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

async function loadGithubEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) return null

  try {
    return JSON.parse(await fs.readFile(eventPath, "utf8"))
  } catch {
    return null
  }
}

async function gitChangedFiles(projectRoot, args, source) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
  })

  return {
    files: splitLines(stdout),
    source,
    status: "ok",
  }
}

async function inferChangedFilesFromGit(projectRoot, options) {
  const attempts = []
  const eventPayload = await loadGithubEventPayload()
  const explicitBase = options.changedBase || options.changedBaseRef || process.env.LIGHTHOUSE_CHANGED_BASE
  const explicitHead = options.changedHead || options.changedHeadRef || process.env.LIGHTHOUSE_CHANGED_HEAD

  if (explicitBase && explicitHead) {
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", `${explicitBase}...${explicitHead}`],
      source: `git:${explicitBase}...${explicitHead}`,
      allowEmpty: true,
    })
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", explicitBase, explicitHead],
      source: `git:${explicitBase}..${explicitHead}`,
      allowEmpty: true,
    })
  }

  if (eventPayload?.pull_request?.base?.sha && eventPayload?.pull_request?.head?.sha) {
    const base = eventPayload.pull_request.base.sha
    const head = eventPayload.pull_request.head.sha
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", `${base}...${head}`],
      source: "git:pull_request",
      allowEmpty: true,
    })
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", base, head],
      source: "git:pull_request-range",
      allowEmpty: true,
    })
  }

  if (eventPayload?.before && eventPayload?.after && !/^0+$/u.test(eventPayload.before)) {
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", eventPayload.before, eventPayload.after],
      source: "git:push",
      allowEmpty: true,
    })
  }

  if (process.env.GITHUB_BASE_REF && process.env.GITHUB_SHA) {
    attempts.push({
      args: ["diff", "--name-only", "--diff-filter=ACMRT", `origin/${process.env.GITHUB_BASE_REF}...${process.env.GITHUB_SHA}`],
      source: "git:github-base-ref",
      allowEmpty: true,
    })
  }

  attempts.push({
    args: ["diff", "--name-only", "--diff-filter=ACMRT", "HEAD"],
    source: "git:working-tree",
  })
  attempts.push({
    args: ["diff", "--name-only", "--diff-filter=ACMRT", "HEAD~1", "HEAD"],
    source: "git:head-parent",
    allowEmpty: true,
  })
  attempts.push({
    args: ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", "--diff-filter=ACMRT", "HEAD"],
    source: "git:head-tree",
    allowEmpty: true,
  })
  attempts.push({
    args: ["show", "--name-only", "--pretty=format:", "--diff-filter=ACMRT", "HEAD"],
    source: "git:head",
    allowEmpty: true,
  })

  for (const attempt of attempts) {
    try {
      const result = await gitChangedFiles(projectRoot, attempt.args, attempt.source)
      if (attempt.allowEmpty || result.files.length > 0) {
        return result
      }
    } catch {
      // Try the next available source. Shallow CI checkouts often do not have the base ref locally.
    }
  }

  return {
    files: [],
    source: "git",
    status: "unavailable",
  }
}

async function resolveChangedFiles(projectRoot, options, config) {
  const explicitFiles = splitList(options.changedFiles || config.changedFiles || process.env.LIGHTHOUSE_CHANGED_FILES)
  if (explicitFiles.length > 0) {
    return {
      files: explicitFiles,
      source: "input",
      status: "ok",
    }
  }

  return inferChangedFilesFromGit(projectRoot, options)
}

function changedRouteEntries(routeEntries, changedFiles, projectRoot) {
  const entriesByPath = new Map(routeEntries.map((entry) => [entry.filePath, entry]))
  const matches = new Map()

  for (const changedFile of changedFiles) {
    const relative = toProjectRelativePath(projectRoot, changedFile)
    if (!relative) continue

    const changedPath = path.resolve(projectRoot, relative)
    const directEntry = entriesByPath.get(changedPath)
    if (directEntry) {
      matches.set(directEntry.filePath, directEntry)
      continue
    }

    const changedName = stripPageExtension(path.basename(changedPath))
    const changedDir = path.dirname(changedPath)

    for (const entry of routeEntries) {
      if (entry.kind === "app") {
        if (isSameOrDescendant(entry.routeRoot, changedPath)) {
          matches.set(entry.filePath, entry)
          continue
        }

        if (APP_SUBTREE_FILES.has(changedName) && isSameOrDescendant(changedDir, entry.routeRoot)) {
          matches.set(entry.filePath, entry)
        }
        continue
      }

      if (isSameOrDescendant(entry.routeRoot, changedPath)) {
        matches.set(entry.filePath, entry)
      }
    }
  }

  return Array.from(matches.values())
}

export async function generateRouteManifest(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const profile = options.profile === "mobile" ? "mobile" : "desktop"
  const { config, filePath: configFile } = await loadRouteConfig(projectRoot, options.configPath)
  const changedRoutesOnly = booleanOption(
    options.changedRoutesOnly,
    options.onlyChangedRoutes,
    config.changedRoutesOnly,
    config.onlyChangedRoutes,
  )

  const cliRoutes = normalizeConfiguredRoutes(options.routes || [])
  const routesFileRoutes = normalizeConfiguredRoutes(await loadRoutesFile(projectRoot, options.routesFile))
  const explicitRoutes = [...cliRoutes, ...routesFileRoutes]

  const appDirs = splitList(options.appDirs).length > 0 ? splitList(options.appDirs) : splitList(config.appDirs || DEFAULT_APP_DIRS)
  const pagesDirs = splitList(options.pagesDirs).length > 0
    ? splitList(options.pagesDirs)
    : splitList(config.pagesDirs || DEFAULT_PAGES_DIRS)
  const discover = explicitRoutes.length === 0 && config.discover !== false
  const routeEntries = discover || changedRoutesOnly ? await discoverNextRouteEntries(projectRoot, appDirs, pagesDirs) : []

  const discoveredRoutes = discover ? routeEntries.map((entry) => entry.route) : []
  const staticRoutes = discoveredRoutes.filter((route) => !isDynamicRoute(route))
  const dynamicRoutes = discoveredRoutes.filter(isDynamicRoute)
  const dynamicResult = dynamicSamplesForRoutes(dynamicRoutes, options.sampledRoutes, config)
  const configuredRoutes = explicitRoutes.length > 0 ? explicitRoutes : routesForProfile(config, profile)

  const changedFilesResult = changedRoutesOnly
    ? await resolveChangedFiles(projectRoot, options, config)
    : { files: [], source: "disabled", status: "disabled" }
  const changedEntries = changedRoutesOnly
    ? changedRouteEntries(routeEntries, changedFilesResult.files, projectRoot)
    : []
  const changedDiscoveredRoutes = changedEntries.map((entry) => entry.route)
  const changedStaticRoutes = changedDiscoveredRoutes.filter((route) => !isDynamicRoute(route))
  const changedDynamicRoutes = changedDiscoveredRoutes.filter(isDynamicRoute)
  const changedDynamicResult = dynamicSamplesForRoutes(changedDynamicRoutes, options.sampledRoutes, config)

  const includeSitemap = Boolean(options.includeSitemap || config.includeSitemap)
  const sitemapResult = includeSitemap
    ? await readSitemapRoutes(options.baseUrl || config.baseUrl || "http://127.0.0.1:3100")
    : { routes: [], status: "disabled" }

  const failOnUnresolvedDynamicRoutes = Boolean(
    options.failOnUnresolvedDynamicRoutes || config.failOnUnresolvedDynamicRoutes,
  )
  const unresolvedDynamicRoutes = changedRoutesOnly ? changedDynamicResult.unresolved : dynamicResult.unresolved

  if (unresolvedDynamicRoutes.length > 0 && failOnUnresolvedDynamicRoutes) {
    throw new Error(`Unresolved dynamic routes: ${unresolvedDynamicRoutes.join(", ")}`)
  }

  const manifestRouteSet = new Set([
    ...configuredRoutes,
    ...staticRoutes,
    ...dynamicResult.samples,
    ...sitemapResult.routes,
  ])

  const changedRouteSet = new Set([
    ...changedStaticRoutes,
    ...changedDynamicResult.samples,
  ])
  const routeSet = changedRoutesOnly
    ? new Set(Array.from(changedRouteSet).filter((route) => manifestRouteSet.has(route)))
    : manifestRouteSet

  if (!changedRoutesOnly && routeSet.size === 0) {
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
      unresolvedDynamicRoutes,
      sitemapRoutes: sitemapResult.routes.length,
      sitemapStatus: sitemapResult.status,
      changedRoutesOnly,
      changedFiles: changedFilesResult.files.length,
      changedFilesSource: changedFilesResult.source,
      changedFilesStatus: changedFilesResult.status,
      changedStaticRoutes: changedStaticRoutes.length,
      changedDynamicRoutes: changedDynamicRoutes.length,
      changedDynamicSampleRoutes: changedDynamicResult.samples.length,
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
