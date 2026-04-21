import fs from "node:fs/promises"
import path from "node:path"

const DEFAULT_ALLOWLIST = ["third-party-cookies", "deprecations", "inspector-issues"]

function splitAllowlist(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ALLOWLIST
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

async function readLighthouseReports(reportDir) {
  const entries = await fs.readdir(reportDir, { withFileTypes: true })
  const reports = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    if (entry.name === "routes.json" || entry.name === "routes.mobile.json") continue

    const filePath = path.join(reportDir, entry.name)
    const raw = await fs.readFile(filePath, "utf8")

    try {
      const data = JSON.parse(raw)
      if (data && typeof data === "object" && data.audits && data.categories?.["best-practices"]) {
        reports.push({ filePath, report: data })
      }
    } catch {
      // Ignore non-report JSON files.
    }
  }

  return reports
}

function isFailingAudit(auditRef, audit) {
  if (!auditRef || !audit) return false
  if (auditRef.weight <= 0) return false
  if (audit.scoreDisplayMode === "notApplicable" || audit.scoreDisplayMode === "manual") return false
  if (typeof audit.score !== "number") return false
  return audit.score < 0.9
}

export async function assertBestPractices(options = {}) {
  const reportDir = path.resolve(options.projectRoot || process.cwd(), options.reportDir || ".lighthouseci")
  const allowlist = new Set(splitAllowlist(options.allowlist))
  const reports = await readLighthouseReports(reportDir)

  if (reports.length === 0) {
    throw new Error(`No Lighthouse report JSON files found in ${reportDir}`)
  }

  const actionableFailures = []
  const allowlistedFailures = []

  for (const { report, filePath } of reports) {
    const route = report.finalUrl || report.requestedUrl || filePath
    const category = report.categories?.["best-practices"]
    const auditRefs = Array.isArray(category?.auditRefs) ? category.auditRefs : []

    for (const auditRef of auditRefs) {
      const audit = report.audits?.[auditRef.id]
      if (!isFailingAudit(auditRef, audit)) continue

      const failure = {
        route,
        id: auditRef.id,
        title: audit.title || auditRef.id,
        displayValue: audit.displayValue || "",
        score: audit.score,
      }

      if (allowlist.has(auditRef.id)) {
        allowlistedFailures.push(failure)
      } else {
        actionableFailures.push(failure)
      }
    }
  }

  return {
    reportCount: reports.length,
    actionableFailures,
    allowlistedFailures,
  }
}
