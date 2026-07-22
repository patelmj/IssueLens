import { expect, test, type Page, type Route } from "@playwright/test";

async function stubTable(page: Page, posts: unknown[] = []) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route: Route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      return route.fulfill({
        status: 201,
        json: {
          id: 1,
          position: 0,
          created_at: "2026-07-22T00:00:00Z",
          ...(body as object),
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("save is disabled without a repo or without non-default state", async ({
  page,
}) => {
  await stubTable(page);
  await page.goto("/plan");
  await expect(page.getByTestId("save-view")).toBeDisabled();
  await page.goto("/plan?repo_id=500");
  await expect(page.getByTestId("save-view")).toBeDisabled();
  await page.goto("/plan?repo_id=500&type=bug");
  await expect(page.getByTestId("save-view")).toBeEnabled();
});

test("saving posts the full table snapshot including sort", async ({ page }) => {
  const posts: unknown[] = [];
  await stubTable(page, posts);
  await page.goto(
    "/plan?repo_id=500&type=bug&max_readiness=50&sort=readiness&order=asc",
  );
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Readiness gaps");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Readiness gaps",
    view_kind: "table",
    repository_id: 500,
    filters: {
      state: "open",
      label: null,
      assignee: null,
      q: null,
      type: "bug",
      component: null,
      max_readiness: "50",
      sort: "readiness",
      order: "asc",
    },
  });
});
