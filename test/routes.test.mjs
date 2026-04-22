import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { generateRouteManifest } from "../lib/routes.mjs"

const execFileAsync = promisify(execFile)

async function touch(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, "export default function Page() { return null }\n", "utf8")
}

async function git(projectRoot, args) {
  await execFileAsync("git", args, { cwd: projectRoot })
}

test("discovers static routes and uses configured dynamic samples", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-"))

  await touch(path.join(projectRoot, "app/(general)/page.tsx"))
  await touch(path.join(projectRoot, "app/(general)/blog/page.tsx"))
  await touch(path.join(projectRoot, "app/(general)/blog/[slug]/page.tsx"))
  await touch(path.join(projectRoot, "app/admin/page.tsx"))
  await touch(path.join(projectRoot, "pages/about.tsx"))
  await touch(path.join(projectRoot, "pages/api/health.ts"))

  await fs.writeFile(
    path.join(projectRoot, ".lighthouse-governance.json"),
    `${JSON.stringify(
      {
        routes: ["/configured"],
        dynamicRoutes: {
          "/blog/[slug]": ["/blog/first-post"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const manifest = await generateRouteManifest({ projectRoot, includeSitemap: false })

  assert.deepEqual(manifest.routes, ["/", "/about", "/blog", "/blog/first-post", "/configured"])
  assert.equal(manifest.routeCount, 5)
  assert.equal(manifest.sources.discoveredStaticRoutes, 4)
  assert.deepEqual(manifest.sources.unresolvedDynamicRoutes, [])
})

test("explicit routes override discovery", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-explicit-"))
  await touch(path.join(projectRoot, "app/page.tsx"))

  const manifest = await generateRouteManifest({
    projectRoot,
    routes: ["/one", "/two"],
    includeSitemap: false,
  })

  assert.deepEqual(manifest.routes, ["/one", "/two"])
  assert.equal(manifest.sources.discoveredStaticRoutes, 0)
})

test("changed-routes-only audits changed static routes and dynamic samples", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-changed-"))

  await touch(path.join(projectRoot, "app/page.tsx"))
  await touch(path.join(projectRoot, "app/blog/page.tsx"))
  await touch(path.join(projectRoot, "app/blog/[slug]/page.tsx"))
  await touch(path.join(projectRoot, "app/about/page.tsx"))

  await fs.writeFile(
    path.join(projectRoot, ".lighthouse-governance.json"),
    `${JSON.stringify(
      {
        dynamicRoutes: {
          "/blog/[slug]": ["/blog/first-post"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const manifest = await generateRouteManifest({
    projectRoot,
    changedRoutesOnly: true,
    changedFiles: ["app/blog/page.tsx", "app/blog/[slug]/page.tsx"],
    includeSitemap: false,
  })

  assert.deepEqual(manifest.routes, ["/blog", "/blog/first-post"])
  assert.equal(manifest.routeCount, 2)
  assert.equal(manifest.sources.changedRoutesOnly, true)
  assert.equal(manifest.sources.changedFiles, 2)
  assert.equal(manifest.sources.changedStaticRoutes, 1)
  assert.equal(manifest.sources.changedDynamicRoutes, 1)
})

test("changed-routes-only returns an empty manifest when no route changed", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-unchanged-"))
  await touch(path.join(projectRoot, "app/page.tsx"))

  const manifest = await generateRouteManifest({
    projectRoot,
    changedRoutesOnly: true,
    changedFiles: ["README.md"],
    includeSitemap: false,
  })

  assert.deepEqual(manifest.routes, [])
  assert.equal(manifest.routeCount, 0)
  assert.equal(manifest.sources.changedRoutesOnly, true)
})

test("changed-routes-only prefers dirty working-tree route files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-dirty-"))

  await git(projectRoot, ["init"])
  await git(projectRoot, ["config", "user.email", "test@example.com"])
  await git(projectRoot, ["config", "user.name", "Lighthouse Governance Test"])

  await touch(path.join(projectRoot, "app/page.tsx"))
  await touch(path.join(projectRoot, "app/maps/gta-6/page.tsx"))
  await git(projectRoot, ["add", "."])
  await git(projectRoot, ["commit", "-m", "initial routes"])

  await fs.writeFile(
    path.join(projectRoot, "app/maps/gta-6/page.tsx"),
    "export default function Page() { return <main /> }\n",
    "utf8",
  )

  const manifest = await generateRouteManifest({
    projectRoot,
    changedRoutesOnly: true,
    includeSitemap: false,
  })

  assert.deepEqual(manifest.routes, ["/maps/gta-6"])
  assert.equal(manifest.sources.changedFilesSource, "git:working-tree")
})

test("JavaScript route config is disabled unless explicitly allowed", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-js-config-"))
  const markerPath = path.join(projectRoot, "executed.txt")

  await fs.writeFile(
    path.join(projectRoot, "lighthouse-governance.config.mjs"),
    `import fs from "node:fs"
fs.writeFileSync(new URL("./executed.txt", import.meta.url), "yes")
export default { routes: ["/trusted"] }
`,
    "utf8",
  )

  await assert.rejects(
    () => generateRouteManifest({
      projectRoot,
      configPath: "lighthouse-governance.config.mjs",
      includeSitemap: false,
    }),
    /JavaScript route config is disabled/u,
  )
  await assert.rejects(() => fs.access(markerPath), /ENOENT/u)

  const manifest = await generateRouteManifest({
    projectRoot,
    configPath: "lighthouse-governance.config.mjs",
    allowJsConfig: true,
    includeSitemap: false,
  })

  assert.deepEqual(manifest.routes, ["/trusted"])
  assert.equal(await fs.readFile(markerPath, "utf8"), "yes")
})

test("absolute audit URLs are restricted to base origin or allowed hosts", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lg-routes-external-"))

  await assert.rejects(
    () => generateRouteManifest({
      projectRoot,
      routes: ["http://169.254.169.254/latest/meta-data"],
      baseUrl: "http://127.0.0.1:3100",
      includeSitemap: false,
    }),
    /External audit URLs are not allowed/u,
  )

  const sameOrigin = await generateRouteManifest({
    projectRoot,
    routes: ["https://app.example.test/docs"],
    baseUrl: "https://app.example.test",
    includeSitemap: false,
  })
  assert.deepEqual(sameOrigin.routes, ["https://app.example.test/docs"])

  const allowedHost = await generateRouteManifest({
    projectRoot,
    routes: ["https://docs.example.test/start"],
    baseUrl: "https://app.example.test",
    allowedUrlHosts: "docs.example.test",
    includeSitemap: false,
  })
  assert.deepEqual(allowedHost.routes, ["https://docs.example.test/start"])
})
