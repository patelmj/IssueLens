import { expect, test, type Page, type Route } from "@playwright/test";

type View = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  position: number;
  created_at: string;
};

const initialViews: View[] = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    position: 0,
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    position: 1,
    created_at: "2026-07-20T00:00:00Z",
  },
  {
    id: 3,
    name: "By assignee",
    view_kind: "board",
    repository_id: 500,
    filters: { lane_by: "assignee", types: ["bug"], readiness: null },
    position: 2,
    created_at: "2026-07-22T00:00:00Z",
  },
  {
    id: 4,
    name: "Readiness gaps",
    view_kind: "table",
    repository_id: 600,
    filters: { type: "bug", max_readiness: "50", sort: "readiness", order: "asc" },
    position: 0,
    created_at: "2026-07-22T00:00:00Z",
  },
];

/** Stateful stub: PATCH/DELETE mutate the list the GET returns. */
async function stubViews(page: Page, calls: { patches: unknown[]; deletes: number[] }) {
  let views: View[] = structuredClone(initialViews);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({
      json: [
        { id: 500, full_name: "patelmj/mehova" },
        { id: 600, full_name: "patelmj/issuelens" },
      ],
    }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
  await page.route(/\/api\/backend\/views\/\d+$/, (route: Route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { name: string };
      calls.patches.push({ id, ...body });
      views = views.map((v) => (v.id === id ? { ...v, name: body.name } : v));
      return route.fulfill({ json: views.find((v) => v.id === id) });
    }
    calls.deletes.push(id);
    views = views.filter((v) => v.id !== id);
    return route.fulfill({ status: 204, body: "" });
  });
}

test("groups views by repo with kind badges, summaries, and open links", async ({
  page,
}) => {
  await stubViews(page, { patches: [], deletes: [] });
  await page.goto("/views");

  const mehova = page.getByTestId("views-repo-500");
  await expect(mehova).toContainText("patelmj/mehova");
  const row1 = page.getByTestId("view-row-1");
  await expect(row1).toContainText("Ready bugs");
  await expect(row1).toContainText("Bug · Ready (≥80)");
  await expect(row1).toContainText("Matrix");
  await expect(page.getByTestId("view-open-1")).toHaveAttribute(
    "href",
    "/plan/matrix?repo_id=500&types=bug&readiness=ready",
  );

  const row3 = page.getByTestId("view-row-3");
  await expect(row3).toContainText("Board");
  await expect(row3).toContainText("Laned by assignee · Bug");
  await expect(page.getByTestId("view-open-3")).toHaveAttribute(
    "href",
    "/plan/board?repo_id=500&types=bug&lane_by=assignee",
  );

  const issuelens = page.getByTestId("views-repo-600");
  await expect(issuelens).toContainText("patelmj/issuelens");
  const row4 = page.getByTestId("view-row-4");
  await expect(row4).toContainText("Table");
  await expect(row4).toContainText("Open · bug · readiness <50% · by readiness ↑");
  await expect(page.getByTestId("view-open-4")).toHaveAttribute(
    "href",
    "/plan?repo_id=600&type=bug&max_readiness=50&sort=readiness&order=asc",
  );
});

test("rename sends PATCH and updates the list", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  await page.goto("/views");
  await page.getByTestId("view-rename-1").click();
  await page.getByTestId("view-rename-input").fill("Bug backlog");
  await page.getByTestId("view-rename-save").click();
  await expect.poll(() => calls.patches.length).toBe(1);
  expect(calls.patches[0]).toEqual({ id: 1, name: "Bug backlog" });
  await expect(page.getByTestId("view-row-1")).toContainText("Bug backlog");
});

test("delete is two-step and removes the row", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  await page.goto("/views");
  await page.getByTestId("view-delete-1").click();
  await expect(page.getByTestId("view-delete-1")).toContainText("Confirm");
  await page.getByTestId("view-delete-1").click();
  await expect.poll(() => calls.deletes).toEqual([1]);
  await expect(page.getByTestId("view-row-1")).not.toBeVisible();
  await expect(page.getByTestId("view-row-2")).toBeVisible();
});

test("empty state keeps the original copy", async ({ page }) => {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/views");
  await expect(page.getByTestId("views-empty")).toContainText("No saved views yet");
});

test("rename cancel closes the form without a PATCH", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  await page.goto("/views");
  await page.getByTestId("view-rename-1").click();
  await expect(page.getByTestId("view-rename-input")).toBeVisible();
  await page.getByTestId("view-rename-cancel").click();
  await expect(page.getByTestId("view-rename-input")).not.toBeVisible();
  await expect(page.getByTestId("view-row-1")).toContainText("Ready bugs");
  expect(calls.patches.length).toBe(0);
});

test("stale action error clears when starting a new action", async ({ page }) => {
  const calls = { patches: [] as unknown[], deletes: [] as number[] };
  await stubViews(page, calls);
  // make PATCH fail once to plant an error banner
  await page.route(/\/api\/backend\/views\/1$/, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { detail: "boom" } })
      : route.fallback(),
  );
  await page.goto("/views");
  await page.getByTestId("view-rename-1").click();
  await page.getByTestId("view-rename-input").fill("Broken");
  await page.getByTestId("view-rename-save").click();
  await expect(page.getByTestId("views-action-error")).toContainText("boom");
  // arming a different action clears the stale banner
  await page.getByTestId("view-delete-2").click();
  await expect(page.getByTestId("views-action-error")).not.toBeVisible();
});
