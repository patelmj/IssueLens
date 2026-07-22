import type { FullConfig } from "@playwright/test";

// Turbopack compiles routes on demand; without a warmup, parallel workers all
// hit cold routes at once and page.goto times out (issue #25). Fetching each
// route once serially compiles everything before workers start.
const ROUTES = [
  "/",
  "/analyze",
  "/plan",
  "/plan/board",
  "/plan/matrix",
  "/repositories",
  "/triage",
  "/views",
];

const WARMUP_TIMEOUT_MS = 60_000;

export default async function globalSetup(config: FullConfig) {
  const { baseURL } = config.projects[0].use;
  if (!baseURL) {
    throw new Error("warmup: baseURL missing from Playwright config");
  }
  for (const route of ROUTES) {
    const url = new URL(route, baseURL).toString();
    const started = Date.now();
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) break;
      } catch {
        // dev server not accepting connections yet; retry
      }
      if (Date.now() - started > WARMUP_TIMEOUT_MS) {
        throw new Error(`warmup: ${url} not ready after ${WARMUP_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
