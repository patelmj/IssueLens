import type { Page } from "@playwright/test";

/**
 * Resolve once React has attached its props — and therefore its event handlers
 * — to the element carrying `testId`.
 *
 * Controls whose state derives purely from the URL ("Save view", the lane-by
 * toggles) are fully server-rendered, so Playwright's actionability checks go
 * green a few hundred ms before hydration lands. A click in that window hits
 * inert markup and is swallowed: no listener exists yet, and Playwright has no
 * reason to retry. React tags every hydrated host node with a
 * `__reactProps$<id>` key, which makes its presence a precise interactivity
 * gate.
 *
 * Only needed when the first interaction after a navigation targets a
 * server-rendered control. Tests that first wait on client-rendered content (a
 * board card, a table row) already imply hydration and need no gate.
 */
export async function waitForHydration(page: Page, testId: string) {
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((key) => key.startsWith("__reactProps$"));
    },
    testId,
  );
}
