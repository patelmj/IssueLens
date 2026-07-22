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
];

/** Stateful stub: PUT /views/order mutates the list the GET returns. */
async function stubReorder(page: Page, orderCalls: unknown[], putStatus = 200) {
  let views: View[] = structuredClone(initialViews);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
  await page.route(/\/api\/backend\/views\/order$/, (route: Route) => {
    const body = route.request().postDataJSON() as {
      repository_id: number;
      ordered_ids: number[];
    };
    orderCalls.push(body);
    if (putStatus !== 200) {
      return route.fulfill({ status: putStatus, json: { detail: "boom" } });
    }
    views = body.ordered_ids
      .map((id, index) => {
        const view = views.find((v) => v.id === id)!;
        return { ...view, position: index };
      })
      .concat(views.filter((v) => v.repository_id !== body.repository_id));
    return route.fulfill({ json: views });
  });
}

async function dragRow(page: Page, fromId: number, toId: number) {
  const handle = page.getByTestId(`view-drag-${fromId}`);
  const target = page.getByTestId(`view-row-${toId}`);
  const hb = (await handle.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("drag reorders within the repo group and persists across reload", async ({
  page,
}) => {
  const orderCalls: unknown[] = [];
  await stubReorder(page, orderCalls);
  await page.goto("/views");
  await expect(page.getByTestId("view-row-1")).toBeVisible();

  await dragRow(page, 1, 2);
  await expect.poll(() => orderCalls.length).toBe(1);
  expect(orderCalls[0]).toEqual({ repository_id: 500, ordered_ids: [2, 1] });

  const rows = page.locator("[data-view-row]");
  await expect(rows.first()).toContainText("Docs pile");

  await page.reload();
  await expect(page.locator("[data-view-row]").first()).toContainText("Docs pile");
});

test("failed reorder rolls back and shows an inline error", async ({ page }) => {
  const orderCalls: unknown[] = [];
  await stubReorder(page, orderCalls, 500);
  await page.goto("/views");
  await expect(page.getByTestId("view-row-1")).toBeVisible();

  await dragRow(page, 1, 2);
  await expect.poll(() => orderCalls.length).toBe(1);
  await expect(page.getByTestId("views-action-error")).toContainText("boom");
  await expect(page.locator("[data-view-row]").first()).toContainText("Ready bugs");
});
