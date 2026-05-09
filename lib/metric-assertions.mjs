import fs from "node:fs/promises"
import path from "node:path"
import { splitList } from "./routes.mjs"

function hasFiniteNumericValue(audit) {
  return typeof audit?.numericValue === "number" && Number.isFinite(audit.numericValue)
}

function aggregateValues(values, aggregationMethod) {
  if (aggregationMethod === "median") {
    const sorted = values.slice().sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) return sorted[middle]
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return aggregationMethod === "pessimistic"
    ? Math.max(...values)
    : Math.min(...values)
}

async function resolveReportFiles(projectRoot, options) {
  const explicitReportFiles = splitList(options.reportFiles || [])
  if (explicitReportFiles.length > 0) {
    return explicitReportFiles.map((filePath) => path.resolve(projectRoot, filePath))
  }

  const reportDir = path.resolve(projectRoot, options.reportDir || ".lighthouseci")
  const entries = await fs.readdir(reportDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })

  return entries
    .filter((entry) => entry.isFile() && /^lhr-.*\.json$/u.test(entry.name))
    .map((entry) => path.join(reportDir, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

export async function assertMetricThreshold(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const auditId = String(options.auditId || "").trim()
  if (!auditId) {
    throw new Error("auditId is required")
  }

  const maxNumericValue = Number(options.maxNumericValue)
  if (!Number.isFinite(maxNumericValue)) {
    throw new Error("maxNumericValue must be a finite number")
  }

  const aggregationMethod = options.aggregationMethod === "pessimistic" || options.aggregationMethod === "median"
    ? options.aggregationMethod
    : "optimistic"
  const reportFiles = await resolveReportFiles(projectRoot, options)
  const valuesByUrl = new Map()
  const skippedReports = []

  for (const reportFile of reportFiles) {
    const parsed = JSON.parse(await fs.readFile(reportFile, "utf8"))
    const audit = parsed?.audits?.[auditId]
    if (!hasFiniteNumericValue(audit)) {
      skippedReports.push({
        reportFile,
        reason: audit?.scoreDisplayMode || "missing-audit",
      })
      continue
    }

    const url = String(parsed.finalUrl || parsed.requestedUrl || reportFile)
    const values = valuesByUrl.get(url) || []
    values.push(audit.numericValue)
    valuesByUrl.set(url, values)
  }

  const results = Array.from(valuesByUrl.entries())
    .map(([url, values]) => ({
      url,
      values,
      actual: aggregateValues(values, aggregationMethod),
    }))
    .sort((left, right) => left.url.localeCompare(right.url))

  const failures = results.filter((result) => result.actual > maxNumericValue)
  const status = results.length === 0 ? "skipped" : failures.length > 0 ? "failed" : "passed"

  return {
    auditId,
    aggregationMethod,
    maxNumericValue,
    reportCount: reportFiles.length,
    evaluatedCount: results.length,
    skippedCount: skippedReports.length,
    failures,
    results,
    skippedReports,
    status,
  }
}
