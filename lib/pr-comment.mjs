import fs from "node:fs/promises"
import path from "node:path"

export const PR_COMMENT_MARKER = "<!-- lighthouse-governance-pr-comment -->"

const DEFAULT_MAX_OUTPUT_CHARS = 58000
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "")
}

function stripUnsafeControlChars(value) {
  return String(value ?? "").replace(UNSAFE_CONTROL_PATTERN, "")
}

function sanitizeOutput(value) {
  return stripUnsafeControlChars(stripAnsi(value))
}

function diffPrefixForLine(line) {
  const trimmed = line.trimStart()

  if (
    trimmed.startsWith("✘") ||
    trimmed.startsWith("×") ||
    trimmed.startsWith("x ") ||
    /^found:\s+/iu.test(trimmed) ||
    /\bfailure\b/iu.test(trimmed) ||
    /\bfailed\b/iu.test(trimmed) ||
    /\bcommand failed\b/iu.test(trimmed)
  ) {
    return "-"
  }

  if (
    trimmed.startsWith("✔") ||
    trimmed.startsWith("✓") ||
    trimmed.startsWith("✅") ||
    /^expected:\s+/iu.test(trimmed) ||
    /\bpassed\b/iu.test(trimmed) ||
    /\bsuccess\b/iu.test(trimmed)
  ) {
    return "+"
  }

  return " "
}

export function formatLhciOutputForGitHub(value) {
  return sanitizeOutput(value)
    .split("\n")
    .map((line) => `${diffPrefixForLine(line)}${line}`)
    .join("\n")
}

function codeFenceFor(value) {
  const longestBacktickRun = Math.max(0, ...Array.from(String(value).matchAll(/`+/gu), (match) => match[0].length))
  return "`".repeat(Math.max(4, longestBacktickRun + 1))
}

function truncateMiddle(value, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  if (value.length <= maxChars) return value

  const marker = "\n\n... output truncated ...\n\n"
  const keep = Math.max(maxChars - marker.length, 0)
  const headLength = Math.ceil(keep * 0.55)
  const tailLength = Math.floor(keep * 0.45)
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return ""
    throw error
  }
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim()
  if (status === "0" || status.toLowerCase() === "passed") return "passed"
  if (status) return "failed"
  return "completed"
}

export async function createPrCommentBody(options = {}) {
  const workingDirectory = path.resolve(options.workingDirectory || process.cwd())
  const outputPath = options.outputPath || path.join(workingDirectory, ".lighthouseci", "lhci-output.log")
  const exitCodePath = options.exitCodePath || path.join(workingDirectory, ".lighthouseci", "lhci-exit-code.txt")
  const includeOutput = options.includeOutput === true

  const exitCode = await readTextIfExists(exitCodePath)
  const output = includeOutput
    ? truncateMiddle(
        formatLhciOutputForGitHub(await readTextIfExists(outputPath)).trimEnd() ||
          " (No Lighthouse CI output was captured.)",
        Number(options.maxOutputChars) || DEFAULT_MAX_OUTPUT_CHARS,
      )
    : ""

  const commitSha = String(options.commitSha || "unknown")
  const status = normalizeStatus(exitCode)
  const routeCount = String(options.routeCount || "unknown")
  const profile = String(options.profile || "unknown")
  const workflowUrl = String(options.workflowUrl || "")

  const metadata = [
    `Commit: \`${commitSha}\``,
    `Status: \`${status}\``,
    `Routes audited: \`${routeCount}\``,
    `Profile: \`${profile}\``,
  ]

  if (workflowUrl) {
    metadata.push(`Workflow run: [view run](${workflowUrl})`)
  }

  const outputSection = includeOutput
    ? `<details open>
<summary>Lighthouse CI output</summary>

${codeFenceFor(output)}diff
${output}
${codeFenceFor(output)}

</details>`
    : "Lighthouse CI output is omitted from this PR comment by default. Check the workflow logs, or set `pr-comment-include-output: \"true\"` for trusted workflows."

  return `${PR_COMMENT_MARKER}
## Lighthouse Governance

${metadata.join("\n")}

${outputSection}
`
}
