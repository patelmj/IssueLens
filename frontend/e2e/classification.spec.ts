import { expect, test } from "@playwright/test";

const row = (over: Partial<Record<string, unknown>>) => ({
  id: 1,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  number: 42,
  title: "Fix token refresh",
  state: "open",
  author_login: "patelmj",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["patelmj"],
  milestone_title: null,
  comments_count: 3,
  gh_created_at: "2026-07-01T00:00:00Z",
  gh_updated_at: "2026-07-17T10:00:00Z",
  gh_closed_at: null,
  issue_type: "bug",
  component: "auth",
  classification_confidence: 0.9,
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({
      id: 2,
      number: 43,
      title: "Redis rate limiting",
      issue_type: null,
      component: null,
      classification_confidence: null,
    }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

const facets = {
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["patelmj"],
  components: ["auth", "sync"],
};

test("type and component columns render with muted unclassified state", async ({
  page,
}) => {
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: page1 }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  const classifiedRow = page.getByRole("row").filter({ hasText: "Fix token refresh" });
  await expect(classifiedRow.getByTestId("type-cell")).toHaveText("bug");
  await expect(classifiedRow.getByTestId("component-cell")).toHaveText("auth");

  const unclassifiedRow = page
    .getByRole("row")
    .filter({ hasText: "Redis rate limiting" });
  await expect(unclassifiedRow.getByTestId("type-cell")).toHaveText("—");
  await expect(unclassifiedRow.getByTestId("component-cell")).toHaveText("—");
});

test("type and component filters round-trip to API and URL", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByLabel("Type", { exact: true }).selectOption("bug");
  await expect(page).toHaveURL(/type=bug/);
  await expect
    .poll(() => requested.some((u) => u.includes("type=bug")))
    .toBe(true);

  await page.getByLabel("Component", { exact: true }).selectOption("auth");
  await expect(page).toHaveURL(/component=auth/);
  await expect
    .poll(() => requested.some((u) => u.includes("component=auth")))
    .toBe(true);
});
