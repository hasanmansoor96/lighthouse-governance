import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createPrCommentBody, formatLhciOutputForGitHub, PR_COMMENT_MARKER, stripAnsi } from "../lib/pr-comment.mjs"

test("stripAnsi removes terminal color codes from LHCI output", () => {
  assert.equal(stripAnsi("\u001B[31mfailed\u001B[0m"), "failed")
})

test("formatLhciOutputForGitHub maps LHCI result lines to diff colors", () => {
  const output = formatLhciOutputForGitHub(`✘ categories.performance failure for minScore assertion
      expected: >=0.85
         found: 0.84
✅ Configuration file found
Assertion failed. Exiting with status code 1.`)

  assert.match(output, /^-✘ categories\.performance failure/u)
  assert.match(output, /^\+      expected: >=0\.85/mu)
  assert.match(output, /^-         found: 0\.84/mu)
  assert.match(output, /^\+✅ Configuration file found/mu)
  assert.match(output, /^-Assertion failed\. Exiting with status code 1\./mu)
})

test("createPrCommentBody includes run metadata and captured Lighthouse output", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lighthouse-governance-"))
  const lhciDir = path.join(tempDir, ".lighthouseci")
  await fs.mkdir(lhciDir)
  await fs.writeFile(path.join(lhciDir, "lhci-output.log"), "\u001B[32mdone running Lighthouse!\u001B[0m\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-exit-code.txt"), "1\n", "utf8")

  const body = await createPrCommentBody({
    workingDirectory: tempDir,
    commitSha: "1234567890abcdef",
    routeCount: "20",
    profile: "desktop",
    workflowUrl: "https://github.com/example/repo/actions/runs/1",
  })

  assert.match(body, new RegExp(PR_COMMENT_MARKER, "u"))
  assert.match(body, /Commit: `1234567890abcdef`/u)
  assert.match(body, /Status: `failed`/u)
  assert.match(body, /Routes audited: `20`/u)
  assert.match(body, /Profile: `desktop`/u)
  assert.match(body, /````diff/u)
  assert.match(body, /done running Lighthouse!/u)
  assert.doesNotMatch(body, /\u001B/u)
})

test("createPrCommentBody renders separate sections for multi-profile runs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lighthouse-governance-multi-"))
  const lhciDir = path.join(tempDir, ".lighthouseci")
  await fs.mkdir(lhciDir)

  await fs.writeFile(path.join(lhciDir, "lhci-output-desktop.log"), "desktop output\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-exit-code-desktop.txt"), "0\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-output-mobile.log"), "mobile output\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-exit-code-mobile.txt"), "1\n", "utf8")
  await fs.writeFile(
    path.join(lhciDir, "profile-results.json"),
    `${JSON.stringify(
      {
        results: [
          {
            profile: "desktop",
            routeCount: 12,
            outputPath: ".lighthouseci/lhci-output-desktop.log",
            exitCodePath: ".lighthouseci/lhci-exit-code-desktop.txt",
          },
          {
            profile: "mobile",
            routeCount: 8,
            outputPath: ".lighthouseci/lhci-output-mobile.log",
            exitCodePath: ".lighthouseci/lhci-exit-code-mobile.txt",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const body = await createPrCommentBody({
    workingDirectory: tempDir,
    commitSha: "abcdef123456",
    profileResultsPath: ".lighthouseci/profile-results.json",
    workflowUrl: "https://github.com/example/repo/actions/runs/2",
  })

  assert.match(body, /Commit: `abcdef123456`/u)
  assert.match(body, /Status: `failed`/u)
  assert.match(body, /Profiles: `desktop, mobile`/u)
  assert.match(body, /Routes audited: `desktop: 12, mobile: 8`/u)
  assert.match(body, /### Desktop/u)
  assert.match(body, /### Mobile/u)
  assert.match(body, /desktop output/u)
  assert.match(body, /mobile output/u)
})
