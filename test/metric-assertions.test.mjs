import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { assertMetricThreshold } from "../lib/metric-assertions.mjs"

test("assertMetricThreshold passes when the aggregated numeric value is within threshold", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-metric-pass-"))
  const reportDir = path.join(projectRoot, ".lighthouseci")
  await fs.mkdir(reportDir)

  await fs.writeFile(
    path.join(reportDir, "lhr-1.json"),
    JSON.stringify({
      finalUrl: "https://example.com/",
      audits: {
        "interaction-to-next-paint": {
          numericValue: 180,
        },
      },
    }),
    "utf8",
  )
  await fs.writeFile(
    path.join(reportDir, "lhr-2.json"),
    JSON.stringify({
      finalUrl: "https://example.com/",
      audits: {
        "interaction-to-next-paint": {
          numericValue: 240,
        },
      },
    }),
    "utf8",
  )

  const result = await assertMetricThreshold({
    projectRoot,
    reportDir,
    auditId: "interaction-to-next-paint",
    maxNumericValue: 200,
  })

  assert.equal(result.status, "passed")
  assert.equal(result.failures.length, 0)
  assert.equal(result.results[0].actual, 180)
})

test("assertMetricThreshold skips reports that do not contain the audit", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-metric-skip-"))
  const reportDir = path.join(projectRoot, ".lighthouseci")
  await fs.mkdir(reportDir)

  await fs.writeFile(
    path.join(reportDir, "lhr-1.json"),
    JSON.stringify({
      finalUrl: "https://example.com/",
      audits: {},
    }),
    "utf8",
  )

  const result = await assertMetricThreshold({
    projectRoot,
    reportDir,
    auditId: "interaction-to-next-paint",
    maxNumericValue: 200,
  })

  assert.equal(result.status, "skipped")
  assert.equal(result.evaluatedCount, 0)
  assert.equal(result.skippedCount, 1)
})
