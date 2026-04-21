import assert from "node:assert/strict"
import test from "node:test"
import { createLhciConfigSource } from "../lib/lhci-config.mjs"

test("generated LHCI config contains threshold assertions and runtime env hooks", () => {
  const source = createLhciConfigSource({
    baseUrl: "http://127.0.0.1:3100",
    routesFile: ".lighthouseci/routes.json",
    performanceMinScore: "0.8",
    bestPracticesMinScore: "0.9",
  })

  assert.match(source, /LIGHTHOUSE_PERFORMANCE_MIN_SCORE/u)
  assert.match(source, /categories:best-practices/u)
  assert.match(source, /LHCI_START_SERVER_COMMAND/u)
  assert.match(source, /temporary-public-storage/u)
})
