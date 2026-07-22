import { expect, test, type Page, type Route } from "@playwright/test";

type View = {
  id: number;
  name: string;
  view_kind: string;
  repository_id: number | null;
  filters: unknown;
  created_at: string;
};

const initialViews: View[] = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    created_at: "2026-07-20T00:00:00Z",
  },
];

/** Stateful stub: PATCH/DELETE mutate the list the GET returns. */
async function stubViews(page: Page, calls: { patches: unknown[]; deletes: number[] }) {
  let views: View[] = structuredClone(initialViews);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
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

test("lists views with repo, summary, and open link", async ({ page }) => {
  await stubViews(page, { patches: [], deletes: [] });
  await page.goto("/views");
  const row = page.getByTestId("view-row-1");
  await expect(row).toContainText("Ready bugs");
  await expect(row).toContainText("patelmj/mehova");
  await expect(row).toContainText("Bug · Ready (≥80)");
  await expect(row).toContainText("Matrix");
  await expect(page.getByTestId("view-open-1")).toHaveAttribute(
    "href",
    "/plan/matrix?repo_id=500&types=bug&readiness=ready",
  );
  await expect(page.getByTestId("view-row-2")).toContainText("Docs pile");
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
