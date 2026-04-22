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
    includeOutput: true,
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

test("createPrCommentBody omits captured output by default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lighthouse-governance-"))
  const lhciDir = path.join(tempDir, ".lighthouseci")
  await fs.mkdir(lhciDir)
  await fs.writeFile(path.join(lhciDir, "lhci-output.log"), "SECRET_TOKEN=should-not-be-posted\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-exit-code.txt"), "0\n", "utf8")

  const body = await createPrCommentBody({
    workingDirectory: tempDir,
    commitSha: "1234567890abcdef",
    routeCount: "1",
    profile: "desktop",
  })

  assert.match(body, /Status: `passed`/u)
  assert.match(body, /output is omitted/u)
  assert.doesNotMatch(body, /SECRET_TOKEN/u)
  assert.doesNotMatch(body, /````diff/u)
})

test("createPrCommentBody uses a longer fence than captured backticks", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lighthouse-governance-"))
  const lhciDir = path.join(tempDir, ".lighthouseci")
  await fs.mkdir(lhciDir)
  await fs.writeFile(path.join(lhciDir, "lhci-output.log"), "````\ninjected markdown\n", "utf8")
  await fs.writeFile(path.join(lhciDir, "lhci-exit-code.txt"), "1\n", "utf8")

  const body = await createPrCommentBody({
    workingDirectory: tempDir,
    includeOutput: true,
  })

  assert.match(body, /`````diff/u)
  assert.match(body, / ````/u)
})
