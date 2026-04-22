#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { assertBestPractices } from "../lib/best-practices.mjs"
import { createLhciConfigSource, writeLhciConfig } from "../lib/lhci-config.mjs"
import { splitList, writeRouteManifest } from "../lib/routes.mjs"

function usage() {
  return `Usage:
  lighthouse-governance routes [options]
  lighthouse-governance config [options]
  lighthouse-governance best-practices [options]

Commands:
  routes          Generate .lighthouseci/routes.json from configured routes and/or project route discovery.
  config          Generate .lighthouseci/lighthouserc.cjs with threshold assertions.
  best-practices  Fail on non-allowlisted Best Practices audit failures in Lighthouse reports.
`
}

function parseArgs(argv) {
  const options = { _: [] }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }

    if (!arg.startsWith("--")) {
      options._.push(arg)
      continue
    }

    const raw = arg.slice(2)
    const equalsIndex = raw.indexOf("=")
    const rawKey = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : raw.slice(equalsIndex + 1)
    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())

    if (inlineValue !== undefined) {
      options[key] = inlineValue
      continue
    }

    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      options[key] = true
      continue
    }

    options[key] = next
    i += 1
  }

  return options
}

function toRoutes(value) {
  return splitList(value)
}

function booleanOption(...values) {
  return values.some((value) => value === true || value === "true")
}

async function runRoutes(options) {
  const result = await writeRouteManifest({
    projectRoot: options.projectRoot,
    output: options.output,
    baseUrl: options.baseUrl,
    profile: options.profile,
    routes: toRoutes(options.routes),
    routesFile: options.routesFile,
    configPath: options.config,
    appDirs: options.appDir,
    pagesDirs: options.pagesDir,
    includeSitemap: options.includeSitemap === true || options.includeSitemap === "true",
    failOnUnresolvedDynamicRoutes:
      options.failOnUnresolvedDynamicRoutes === true || options.failOnUnresolvedDynamicRoutes === "true",
    changedRoutesOnly: booleanOption(options.changedRoutesOnly, options.onlyChangedRoutes),
    changedFiles: options.changedFiles,
    changedBase: options.changedBase || options.changedBaseRef,
    changedHead: options.changedHead || options.changedHeadRef,
  })

  if (options.stdout) {
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
    return
  }

  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  console.log(`[lighthouse-governance] wrote ${result.manifest.routeCount} routes to ${path.relative(projectRoot, result.output)}`)
  if (result.manifest.sources.unresolvedDynamicRoutes.length > 0) {
    console.warn("[lighthouse-governance] unresolved dynamic routes were skipped:")
    for (const route of result.manifest.sources.unresolvedDynamicRoutes) {
      console.warn(`  - ${route}`)
    }
  }
}

async function runConfig(options) {
  const configOptions = {
    projectRoot: options.projectRoot,
    output: options.output,
    baseUrl: options.baseUrl,
    profile: options.profile,
    routesFile: options.routesFile,
    numberOfRuns: options.numberOfRuns,
    startServerCommand: options.startServerCommand,
    startServerReadyPattern: options.startServerReadyPattern,
    startServerReadyTimeout: options.startServerReadyTimeout,
    uploadTarget: options.uploadTarget,
    performanceMinScore: options.performanceMinScore,
    accessibilityMinScore: options.accessibilityMinScore,
    bestPracticesMinScore: options.bestPracticesMinScore,
    seoMinScore: options.seoMinScore,
    lcpMaxMs: options.lcpMaxMs,
    tbtMaxMs: options.tbtMaxMs,
    clsMax: options.clsMax,
    errorsInConsoleMinScore: options.errorsInConsoleMinScore,
  }

  if (options.stdout) {
    process.stdout.write(createLhciConfigSource(configOptions))
    return
  }

  const { output } = await writeLhciConfig(configOptions)
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  console.log(`[lighthouse-governance] wrote LHCI config to ${path.relative(projectRoot, output)}`)
}

async function runBestPractices(options) {
  const result = await assertBestPractices({
    projectRoot: options.projectRoot,
    reportDir: options.reportDir,
    allowlist: options.allowlist,
  })

  if (result.actionableFailures.length > 0) {
    console.error("[lighthouse-governance] Best Practices allowlist check failed")
    for (const failure of result.actionableFailures) {
      const detail = failure.displayValue || failure.title
      console.error(` - ${failure.route} -> ${failure.id} (score=${failure.score}) ${detail}`)
    }
    process.exit(1)
  }

  console.log("[lighthouse-governance] Best Practices allowlist check passed")
  console.log(`[lighthouse-governance] reports scanned: ${result.reportCount}`)
  console.log(`[lighthouse-governance] allowlisted failures observed: ${result.allowlistedFailures.length}`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const options = parseArgs(rest)

  if (!command || command === "--help" || command === "-h" || options.help) {
    process.stdout.write(usage())
    return
  }

  if (command === "routes") {
    await runRoutes(options)
    return
  }

  if (command === "config") {
    await runConfig(options)
    return
  }

  if (command === "best-practices") {
    await runBestPractices(options)
    return
  }

  console.error(`Unknown command: ${command}`)
  process.stderr.write(usage())
  process.exit(1)
}

main().catch((error) => {
  console.error("[lighthouse-governance] failed")
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
