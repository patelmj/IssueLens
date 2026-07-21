import { expect, test, type Page, type Route } from "@playwright/test";

const COLUMN_KEYS = [
  "needs_detail", "ready", "in_progress", "review", "blocked", "done",
] as const;

const card = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  component: "auth",
  issue_type: "bug",
  priority_band: "dofirst",
  readiness_pct: 80,
  estimate: 3,
  assignees: ["patelmj"],
  gh_updated_at: "2026-07-20T00:00:00Z",
  warning: null,
  placed: false,
  ...over,
});

const CARDS = [
  card(),
  card({
    issue_id: 2, number: 43, title: "Docs typo", component: null,
    issue_type: "docs", priority_band: null, readiness_pct: 40, assignees: [],
    warning: "Acceptance criteria",
  }),
  card({ issue_id: 3, number: 44, title: "Shipped thing", assignees: [] }),
];

const BASE_COLUMN: Record<number, string> = { 1: "in_progress", 2: "needs_detail", 3: "done" };

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

/**
 * Stateful stub: PUT/DELETE mutate `placements`, GET regroups from it —
 * mirrors the real backend so post-mutation refetches never race assertions.
 */
function buildPayload(placements: Record<number, string>) {
  const columns = COLUMN_KEYS.map((key) => ({
    key,
    cards: CARDS.filter(
      (c) => (placements[c.issue_id as number] ?? BASE_COLUMN[c.issue_id as number]) === key,
    ).map((c) => ({ ...c, placed: (c.issue_id as number) in placements })),
  }));
  return { columns, total: CARDS.length };
}

async function stubBoard(
  page: Page,
  calls?: { puts: { issueId: number; body: unknown }[]; deletes: number[] },
) {
  const placements: Record<number, string> = {};
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/kanban$/, (route: Route) =>
    route.fulfill({ json: buildPayload(placements) }),
  );
  await page.route(/\/api\/backend\/issues\/(\d+)\/workflow$/, (route: Route) => {
    const issueId = Number(route.request().url().match(/issues\/(\d+)\/workflow/)![1]);
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { column: string };
      calls?.puts.push({ issueId, body });
      placements[issueId] = body.column;
      return route.fulfill({ json: { issue_id: issueId, column: body.column, placed: true } });
    }
    calls?.deletes.push(issueId);
    delete placements[issueId];
    return route.fulfill({ status: 204, body: "" });
  });
}

test("board renders all six columns with derived cards", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board");
  for (const key of COLUMN_KEYS) {
    await expect(page.getByTestId(`col-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId("col-in_progress")).toContainText("#42");
  await expect(page.getByTestId("col-needs_detail")).toContainText("#43");
  await expect(page.getByTestId("col-done")).toContainText("#44");
  // empty columns stay visible (muted, never hidden)
  await expect(page.getByTestId("col-ready")).toContainText("Ready");
  await expect(page.getByTestId("card-warning-43")).toContainText("Acceptance criteria");
});

test("plan tabs and sidebar navigate to the board", async ({ page }) => {
  await stubBoard(page);
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").getByRole("link", { name: "Board" }).click();
  await expect(page.getByTestId("board-content")).toBeVisible();
});
