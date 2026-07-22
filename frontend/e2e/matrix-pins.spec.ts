import { expect, test, type Page, type Route } from "@playwright/test";

const item = (issue_id: number, number: number, over: Partial<Record<string, unknown>> = {}) => ({
  issue_id,
  number,
  title: `Issue ${number}`,
  urgency: 70 + issue_id,
  importance: 60 + issue_id,
  factors: [],
  issue_type: "bug",
  component: null,
  readiness_score: null,
  labels: [],
  assignees: [],
  estimate: 2,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

/** Two pinned issues (#42, #43) + one unpinned (#44); DELETE releases per-issue. */
async function stubPinnedMatrix(page: Page, released: number[]) {
  const pins = new Map<number, { u: number; i: number }>([
    [1, { u: 90, i: 90 }],
    [2, { u: 20, i: 85 }],
  ]);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) => {
    const items = [
      item(1, 42, {
        pinned: pins.has(1),
        pinned_urgency: pins.get(1)?.u ?? null,
        pinned_importance: pins.get(1)?.i ?? null,
      }),
      item(2, 43, {
        pinned: pins.has(2),
        pinned_urgency: pins.get(2)?.u ?? null,
        pinned_importance: pins.get(2)?.i ?? null,
      }),
      item(3, 44),
    ];
    return route.fulfill({ json: { items, total: 3, scored: 3, unscored: 0 } });
  });
  await page.route(/\/api\/backend\/issues\/(\d+)\/pin$/, (route: Route) => {
    const id = Number(route.request().url().match(/issues\/(\d+)\/pin/)![1]);
    if (route.request().method() === "DELETE") {
      released.push(id);
      pins.delete(id);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
}

test("queue rows mark pinned issues and release inline", async ({ page }) => {
  const released: number[] = [];
  await stubPinnedMatrix(page, released);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("qrow-release-42")).toBeVisible();
  await expect(page.getByTestId("qrow-release-44")).not.toBeVisible();

  await page.getByTestId("qrow-release-42").click();
  await expect.poll(() => released).toEqual([1]);
  await expect(page.getByTestId("qrow-release-42")).not.toBeVisible();
  await expect(page.getByTestId("pin-badge-42")).not.toBeVisible();
  // releasing does not select the row — check the exact class token, not a
  // substring match: the unselected state's own class is
  // "hover:bg-(--accent-tint)", which contains "bg-(--accent-tint)" as a
  // substring, so an unanchored regex would false-positive here.
  const rowClasses = (await page.getByTestId("qrow-42").getAttribute("class")) ?? "";
  expect(rowClasses.split(/\s+/)).not.toContain("bg-(--accent-tint)");
});
