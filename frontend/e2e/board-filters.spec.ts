import { expect, test, type Page, type Route } from "@playwright/test";
import { waitForHydration } from "./helpers/hydration";

const card = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  component: "auth",
  issue_type: "bug",
  priority_band: "dofirst",
  readiness_pct: 80,
  estimate: 3,
  assignees: ["alice"],
  gh_updated_at: "2026-07-20T00:00:00Z",
  warning: null,
  placed: false,
  ...over,
});

const payload = {
  columns: [
    { key: "needs_detail", cards: [] },
    {
      key: "ready",
      cards: [
        card(),
        card({
          issue_id: 2,
          number: 43,
          title: "Docs typo",
          issue_type: "docs",
          readiness_pct: 30,
          component: "docs",
          assignees: [],
        }),
      ],
    },
    { key: "in_progress", cards: [] },
    { key: "review", cards: [] },
    { key: "blocked", cards: [] },
    { key: "done", cards: [] },
  ],
  total: 2,
};

async function stubBoard(page: Page, posts: unknown[] = []) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/kanban$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        json: {
          id: 1,
          position: 0,
          created_at: "2026-07-22T00:00:00Z",
          ...(route.request().postDataJSON() as object),
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("type chip filters cards and shows the shown-count", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board?repo_id=500");
  await expect(page.getByTestId("card-42")).toBeVisible();
  await expect(page.getByTestId("card-43")).toBeVisible();

  await page.getByTestId("type-chip").click();
  await page.getByTestId("type-panel").getByLabel("Bug").check();
  await expect(page).toHaveURL(/types=bug/);
  await expect(page.getByTestId("card-42")).toBeVisible();
  await expect(page.getByTestId("card-43")).not.toBeVisible();
  await expect(page.getByTestId("board-filter-count")).toHaveText("1 of 2 shown");
});

test("lane_by round-trips through the URL", async ({ page }) => {
  await stubBoard(page);
  await page.goto("/plan/board?repo_id=500");
  await waitForHydration(page, "lane-by");
  await page.getByTestId("lane-by").getByRole("button", { name: "Assignee" }).click();
  await expect(page).toHaveURL(/lane_by=assignee/);
  await expect(page.getByTestId("swimlane-alice")).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId("lane-by").getByRole("button", { name: "Assignee" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("swimlane-alice")).toBeVisible();
});

test("save is disabled at defaults, posts board snapshot when active", async ({
  page,
}) => {
  const posts: unknown[] = [];
  await stubBoard(page, posts);
  await page.goto("/plan/board?repo_id=500");
  await expect(page.getByTestId("save-view")).toBeDisabled();

  await page.goto("/plan/board?repo_id=500&types=bug&lane_by=assignee");
  await expect(page.getByTestId("save-view")).toBeEnabled();
  await waitForHydration(page, "save-view");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Bug lanes");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Bug lanes",
    view_kind: "board",
    repository_id: 500,
    filters: { lane_by: "assignee", types: ["bug"], readiness: null },
  });
});
