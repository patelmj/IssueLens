import { expect, test, type Page } from "@playwright/test";

const baseRepo = {
  private: false,
  last_synced_at: null,
  sync_status: "idle",
  sync_error: null,
};

/** Stateful stub shared by both endpoints: PATCH flips visibility, GETs reflect it. */
async function stubRepos(page: Page, state: { hiddenIds: Set<number> }) {
  const all = () => [
    { ...baseRepo, id: 500, full_name: "patelmj/IssueLens", open_issues_count: 12,
      visible: !state.hiddenIds.has(500) },
    { ...baseRepo, id: 501, full_name: "patelmj/second-repo", open_issues_count: 3,
      visible: !state.hiddenIds.has(501) },
  ];
  await page.route(/\/api\/backend\/repositories(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const json =
      url.searchParams.get("include_hidden") === "true"
        ? all()
        : all().filter((r) => r.visible);
    return route.fulfill({ json });
  });
  await page.route(/\/api\/backend\/repositories\/(\d+)$/, (route) => {
    const id = Number(route.request().url().match(/repositories\/(\d+)$/)![1]);
    const body = route.request().postDataJSON() as { visible: boolean };
    if (body.visible) state.hiddenIds.delete(id);
    else state.hiddenIds.add(id);
    return route.fulfill({ json: all().find((r) => r.id === id) });
  });
}

test("hiding a repo mutes the card and removes it from other views", async ({ page }) => {
  const state = { hiddenIds: new Set<number>() };
  await stubRepos(page, state);
  await page.route(/\/api\/backend\/stats\/overview/, (route) => {
    const visible = [
      { id: 500, full_name: "patelmj/IssueLens", open_issues_count: 12 },
      { id: 501, full_name: "patelmj/second-repo", open_issues_count: 3 },
    ].filter((r) => !state.hiddenIds.has(r.id));
    return route.fulfill({
      json: {
        connected_repos: visible.length,
        open_issues: visible.reduce((sum, r) => sum + r.open_issues_count, 0),
        last_synced_at: null,
        top_repos: [],
        activity: [],
      },
    });
  });

  await page.goto("/repositories");
  await expect(page.getByTestId("repo-card-501")).toBeVisible();
  await expect(page.getByTestId("hidden-pill-501")).toHaveCount(0);

  await page.getByTestId("visibility-toggle-501").click();
  await expect(page.getByTestId("hidden-pill-501")).toBeVisible();
  // card stays present (muted), never removed
  await expect(page.getByTestId("repo-card-501")).toBeVisible();
  await expect(page.getByTestId("visibility-toggle-501")).toHaveText("Show");

  // the plan table's repo select no longer offers the hidden repo
  await page.goto("/plan");
  await expect(page.getByLabel("Repository").locator("option")).toHaveText([
    "All repositories",
    "patelmj/IssueLens",
  ]);

  // the overview's connected-repos count reflects the reduced visible set
  // (only repo 500 remains visible after hiding 501)
  await page.goto("/");
  await expect(
    page.getByText("Connected repos").locator("xpath=following-sibling::div[1]"),
  ).toHaveText("1");
});

test("showing a hidden repo restores it", async ({ page }) => {
  const state = { hiddenIds: new Set<number>([501]) };
  await stubRepos(page, state);

  await page.goto("/repositories");
  await expect(page.getByTestId("hidden-pill-501")).toBeVisible();
  await page.getByTestId("visibility-toggle-501").click();
  await expect(page.getByTestId("hidden-pill-501")).toHaveCount(0);
  await expect(page.getByTestId("visibility-toggle-501")).toHaveText("Hide");
});

test("a stale repo_id URL for a hidden repo keeps working on matrix and table", async ({
  page,
}) => {
  const state = { hiddenIds: new Set<number>([501]) };
  await stubRepos(page, state);

  const matrixItem = {
    issue_id: 77,
    number: 77,
    title: "Hidden repo issue",
    urgency: 50,
    importance: 50,
    factors: [],
    issue_type: "bug",
    component: null,
    readiness_score: 60,
    labels: [],
    assignees: [],
    estimate: 3,
    pinned: false,
    pinned_urgency: null,
    pinned_importance: null,
    scored_at: "2026-07-20T00:00:00Z",
    model: "test-model",
  };
  await page.route(/\/api\/backend\/repositories\/501\/priority$/, (route) =>
    route.fulfill({
      json: { items: [matrixItem], total: 1, scored: 1, unscored: 0 },
    }),
  );

  await page.goto("/plan/matrix?repo_id=501");
  await expect(page.getByTestId("qrow-77")).toBeVisible();
  // the repo select's options don't include the hidden repo — only the visible one
  await expect(page.getByLabel("Repository").locator("option")).toHaveText([
    "patelmj/IssueLens",
  ]);

  const tableRow = {
    id: 77,
    repository_id: 501,
    repo_full_name: "patelmj/second-repo",
    number: 77,
    title: "Hidden repo issue",
    state: "open",
    author_login: "patelmj",
    labels: [{ name: "bug", color: "d73a4a" }],
    assignees: ["patelmj"],
    milestone_title: null,
    comments_count: 1,
    gh_created_at: "2026-07-01T00:00:00Z",
    gh_updated_at: "2026-07-17T10:00:00Z",
    gh_closed_at: null,
  };
  await page.route(/\/api\/backend\/issues\?.*repo_id=501.*$/, (route) =>
    route.fulfill({
      json: { items: [tableRow], total: 1, limit: 50, offset: 0 },
    }),
  );
  await page.route(/\/api\/backend\/issues\/facets(\?.*)?$/, (route) =>
    route.fulfill({ json: { labels: [], assignees: [], components: [] } }),
  );

  await page.goto("/plan?repo_id=501");
  await expect(page.getByText("Hidden repo issue")).toBeVisible();
});
