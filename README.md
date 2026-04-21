# Lighthouse Governance

Reusable Lighthouse CI governance for web projects. The action builds a project, generates a route manifest from discovered Next.js routes or configured routes, runs Lighthouse CI, and fails the workflow when configured thresholds fail.

## What It Does

- Discovers static routes from `app`, `src/app`, `pages`, and `src/pages`.
- Uses configured route samples for dynamic routes such as `/blog/[slug]`.
- Allows fully configured route lists through an action input, JSON file, or config file.
- Generates an LHCI config with score and metric thresholds.
- Fails GitHub Actions when LHCI assertions fail.
- Optionally enforces an actionable Best Practices allowlist.
- Uploads `.lighthouseci` reports as workflow artifacts.

## Use In A Project

After this repo is pushed to GitHub, add a workflow like this to a project:

```yaml
name: lighthouse-governance

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - uses: your-org/lighthouse-governance@v1
        with:
          package-manager: pnpm
          pnpm-version: "10"
          node-version: "20"
          start-server-command: pnpm start --hostname=127.0.0.1 --port=3100
          route-config-file: lighthouse-governance.config.json
          performance-min-score: "0.85"
          accessibility-min-score: "0.95"
          seo-min-score: "0.95"
          lcp-max-ms: "2500"
          tbt-max-ms: "200"
          cls-max: "0.1"
```

Replace `your-org/lighthouse-governance@v1` with the final owner, repo, and tag.

## Route Configuration

Create `lighthouse-governance.config.json` in the audited project when route discovery needs help:

```json
{
  "routes": ["/", "/blog", "/maps"],
  "desktopRoutes": ["/maps/gta-6-interactive-map"],
  "mobileRoutes": ["/maps/gta-6-interactive-map"],
  "dynamicRoutes": {
    "/blog/[game]": ["/blog/gta6", "/blog/gta5"],
    "/blog/[game]/[slug]": ["/blog/gta6/trailers"]
  },
  "excludePrefixes": ["/api", "/admin"],
  "excludeRoutes": ["/maps/editor"],
  "includeSitemap": false,
  "failOnUnresolvedDynamicRoutes": false
}
```

If the action input `routes` or `routes-file` is set, those configured routes are audited instead of route discovery.

The `examples/gta6map-lighthouse-governance.config.json` file preserves the current GTA6map desktop/mobile route seeds and dynamic `/blog/[game]` samples in the new reusable format.

## Local Commands

Generate routes:

```bash
node bin/lighthouse-governance.mjs routes --project-root /path/to/project --output .lighthouseci/routes.json
```

Generate LHCI config:

```bash
node bin/lighthouse-governance.mjs config --project-root /path/to/project --output .lighthouseci/lighthouserc.cjs
```

Run the Best Practices allowlist check after LHCI has produced reports:

```bash
node bin/lighthouse-governance.mjs best-practices --project-root /path/to/project --report-dir .lighthouseci
```

## Thresholds

The action exposes these inputs and mirrors them to the generated LHCI config:

- `performance-min-score`, default `0.85`
- `accessibility-min-score`, default `0.95`
- `best-practices-min-score`, default empty so it is disabled
- `seo-min-score`, default `0.95`
- `lcp-max-ms`, default `2500`
- `tbt-max-ms`, default `200`
- `cls-max`, default `0.1`
- `errors-in-console-min-score`, default `1`

Empty threshold inputs are skipped.
