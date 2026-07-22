import { expect, test, type Page, type Route } from "@playwright/test";

const factor = (over: Partial<Record<string, unknown>> = {}) => ({
  axis: "urgency",
  sign: "+",
  text: "Priority P0 set",
  source: "signal",
  weight: 30,
  ...over,
});

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [
    factor(),
    factor({ axis: "importance", text: "Customer reports login broken", source: "llm", weight: 0 }),
  ],
  issue_type: "bug",
  component: "auth",
  readiness_score: 80,
  labels: [],
  assignees: [],
  estimate: 3,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

const payload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", factors: [factor({ sign: "-", text: "No milestone (urgency uncertain)" })] }),
    item({ issue_id: 3, number: 44, title: "Awaiting analysis", urgency: null, importance: null, factors: [] }),
  ],
  total: 3,
  scored: 2,
  unscored: 1,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

/**
 * Stateful stub: the PUT/DELETE handlers mutate `pinned`, and the GET reflects it —
 * mirrors the real backend so the post-mutation refetch (invalidateQueries) never
 * races the assertions.
 */
async function stubMatrix(page: Page, calls?: { pins: unknown[]; releases: number }) {
  let pinned: { u: number; i: number } | null = null;
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) => {
    const items = payload.items.map((it) =>
      it.issue_id === 1
        ? {
            ...it,
            pinned: pinned != null,
            pinned_urgency: pinned?.u ?? null,
            pinned_importance: pinned?.i ?? null,
          }
        : it,
    );
    return route.fulfill({ json: { ...payload, items } });
  });
  await page.route(/\/api\/backend\/issues\/\d+\/pin$/, (route: Route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { urgency: number; importance: number };
      calls?.pins.push(body);
      pinned = { u: body.urgency, i: body.importance };
      return route.fulfill({
        json: {
          issue_id: 1,
          pinned: true,
          pinned_urgency: body.urgency,
          pinned_importance: body.importance,
        },
      });
    }
    if (calls) calls.releases += 1;
    pinned = null;
    return route.fulfill({ status: 204, body: "" });
  });
}

test("matrix renders bubbles, queue groups, and unscored chip", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("unscored-chip")).toContainText("1 issue awaiting scores");
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
  await expect(page.getByTestId("qgroup-reconsider")).toContainText("#43");
  await expect(page.getByTestId("execution-queue")).toBeVisible();
});

test("plan tabs navigate between table and matrix", async ({ page }) => {
  await stubMatrix(page);
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.goto("/plan/matrix");
  await page.getByTestId("plan-tabs").getByRole("link", { name: "Table" }).click();
  await expect(page.getByTestId("plan-content")).toBeVisible();
});

test("dragging a bubble pins it: PUT sent, ring + toast shown, queue reflows", async ({ page }) => {
  const calls = { pins: [] as unknown[], releases: 0 };
  await stubMatrix(page, calls);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 250, startY + 200, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => calls.pins.length).toBe(1);
  const sent = calls.pins[0] as { urgency: number; importance: number };
  expect(sent.urgency).toBeLessThan(80);
  expect(sent.importance).toBeLessThan(70);
  await expect(page.getByTestId("pin-badge-42")).toBeVisible();
  await expect(page.getByTestId("pin-toast")).toBeVisible();
  // pinned issue moved out of Do First — the quadrant group is empty and
  // unmounted entirely (execution-queue.tsx renders `null` for empty groups),
  // so assert absence via toBeVisible() rather than toContainText(), which
  // requires the locator to resolve to an element before it can inspect text.
  await expect(page.getByTestId("qgroup-dofirst")).not.toBeVisible();
});

test("release to AI restores computed placement", async ({ page }) => {
  const calls = { pins: [] as unknown[], releases: 0 };
  await stubMatrix(page, calls);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 250, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("pin-badge-42")).toBeVisible();

  // drag auto-selects the just-pinned bubble → toast appears immediately
  await expect(page.getByTestId("pin-toast")).toBeVisible();
  await page.getByTestId("release-pin").click();
  await expect.poll(() => calls.releases).toBe(1);
  await expect(page.getByTestId("pin-error")).not.toBeVisible();
  await expect(page.getByTestId("pin-badge-42")).not.toBeVisible();
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
});

test("queue row click selects; bubble hover shows explainability with AI tag", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-43").click();
  await expect(page.getByTestId("qrow-43")).toHaveClass(/bg-\(--accent-tint\)/);

  await page.getByTestId("bubble-42").hover();
  await expect(page.getByTestId("hover-card")).toBeVisible();
  await expect(page.getByTestId("hover-factors")).toContainText("Priority P0 set");
  await expect(page.getByTestId("hover-factors")).toContainText("Customer reports login broken");
  await expect(page.getByTestId("hover-card")).toContainText("AI");
});

test("reduced motion renders bubbles immediately at full size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  const box = (await page.getByTestId("bubble-42").boundingBox())!;
  // radiusOf(3) = 14.3 → diameter ≈ 28.6 in viewBox units; even after viewport
  // scaling the rendered bubble must be far larger than a mid-animation sliver
  expect(box.width).toBeGreaterThan(10);
});
