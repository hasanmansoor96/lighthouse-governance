import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { generateRouteManifest } from "../lib/routes.mjs"

async function touch(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, "export default function Page() { return null }\n", "utf8")
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
