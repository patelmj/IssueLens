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
