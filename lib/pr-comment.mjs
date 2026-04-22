import fs from "node:fs/promises"
import path from "node:path"

export const PR_COMMENT_MARKER = "<!-- lighthouse-governance-pr-comment -->"

const DEFAULT_MAX_OUTPUT_CHARS = 58000
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "")
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

  const rawOutput = await readTextIfExists(outputPath)
  const exitCode = await readTextIfExists(exitCodePath)
  const output = truncateMiddle(
    stripAnsi(rawOutput).trimEnd() || "(No Lighthouse CI output was captured.)",
    Number(options.maxOutputChars) || DEFAULT_MAX_OUTPUT_CHARS,
  )

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

  return `${PR_COMMENT_MARKER}
## Lighthouse Governance

${metadata.join("\n")}

<details open>
<summary>Lighthouse CI output</summary>

\`\`\`\`text
${output}
\`\`\`\`

</details>
`
}
