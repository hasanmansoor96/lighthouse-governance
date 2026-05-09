import fs from "node:fs/promises"
import path from "node:path"

export const PR_COMMENT_MARKER = "<!-- lighthouse-governance-pr-comment -->"

const DEFAULT_MAX_OUTPUT_CHARS = 58000
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "")
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
  return stripAnsi(value)
    .split("\n")
    .map((line) => `${diffPrefixForLine(line)}${line}`)
    .join("\n")
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

async function readJsonIfExists(filePath) {
  const raw = await readTextIfExists(filePath)
  if (!raw) return null

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim()
  if (status === "0" || status.toLowerCase() === "passed") return "passed"
  if (status) return "failed"
  return "completed"
}

function resolvePathFromWorkingDirectory(workingDirectory, filePath) {
  if (!filePath) return ""
  return path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath)
}

function profileTitle(profile) {
  const value = String(profile || "unknown")
  return value.charAt(0).toUpperCase() + value.slice(1)
}

async function loadProfileResultSections(workingDirectory, results, maxOutputChars) {
  const outputCharsPerResult = results.length > 1
    ? Math.max(Math.floor(maxOutputChars / results.length), 12000)
    : maxOutputChars

  const sections = []
  for (const result of results) {
    const outputPath = resolvePathFromWorkingDirectory(workingDirectory, result.outputPath)
    const exitCodePath = resolvePathFromWorkingDirectory(workingDirectory, result.exitCodePath)
    const rawOutput = await readTextIfExists(outputPath)
    const exitCode = await readTextIfExists(exitCodePath)

    sections.push({
      profile: String(result.profile || "unknown"),
      routeCount: String(result.routeCount ?? "unknown"),
      status: normalizeStatus(exitCode),
      output: truncateMiddle(
        formatLhciOutputForGitHub(rawOutput).trimEnd() || " (No Lighthouse CI output was captured.)",
        outputCharsPerResult,
      ),
    })
  }

  return sections
}

export async function createPrCommentBody(options = {}) {
  const workingDirectory = path.resolve(options.workingDirectory || process.cwd())
  const maxOutputChars = Number(options.maxOutputChars) || DEFAULT_MAX_OUTPUT_CHARS
  const commitSha = String(options.commitSha || "unknown")
  const workflowUrl = String(options.workflowUrl || "")
  const profileResultsPath = resolvePathFromWorkingDirectory(
    workingDirectory,
    options.profileResultsPath || path.join(".lighthouseci", "profile-results.json"),
  )
  const profileResults = await readJsonIfExists(profileResultsPath)

  if (profileResults && Array.isArray(profileResults.results) && profileResults.results.length > 0) {
    const sections = await loadProfileResultSections(workingDirectory, profileResults.results, maxOutputChars)
    const status = sections.some((section) => section.status === "failed")
      ? "failed"
      : sections.every((section) => section.status === "passed")
        ? "passed"
        : "completed"
    const profiles = sections.map((section) => section.profile).join(", ")
    const routeCounts = sections.map((section) => `${section.profile}: ${section.routeCount}`).join(", ")

    const metadata = [
      `Commit: \`${commitSha}\``,
      `Status: \`${status}\``,
      `Profiles: \`${profiles}\``,
      `Routes audited: \`${routeCounts}\``,
    ]

    if (workflowUrl) {
      metadata.push(`Workflow run: [view run](${workflowUrl})`)
    }

    const details = sections.map((section) => `### ${profileTitle(section.profile)}
Status: \`${section.status}\`
Routes audited: \`${section.routeCount}\`

<details open>
<summary>${profileTitle(section.profile)} Lighthouse CI output</summary>

\`\`\`\`diff
${section.output}
\`\`\`\`

</details>`).join("\n\n")

    return `${PR_COMMENT_MARKER}
## Lighthouse Governance

${metadata.join("\n")}

${details}
`
  }

  const outputPath = resolvePathFromWorkingDirectory(
    workingDirectory,
    options.outputPath || path.join(".lighthouseci", "lhci-output.log"),
  )
  const exitCodePath = resolvePathFromWorkingDirectory(
    workingDirectory,
    options.exitCodePath || path.join(".lighthouseci", "lhci-exit-code.txt"),
  )
  const rawOutput = await readTextIfExists(outputPath)
  const exitCode = await readTextIfExists(exitCodePath)
  const output = truncateMiddle(
    formatLhciOutputForGitHub(rawOutput).trimEnd() || " (No Lighthouse CI output was captured.)",
    maxOutputChars,
  )
  const status = normalizeStatus(exitCode)
  const routeCount = String(options.routeCount || "unknown")
  const profile = String(options.profile || "unknown")

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

\`\`\`\`diff
${output}
\`\`\`\`

</details>
`
}
