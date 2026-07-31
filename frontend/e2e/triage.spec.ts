import { expect, test, type Page, type Route } from "@playwright/test";

const inbox = {
  items: [
    {
      id: 1,
      number: 182,
      title: "Auth fails after refresh",
      repo_full_name: "patelmj/mehova",
      issue_type: "bug",
      component: "auth",
      readiness_score: 42,
      missing: [
        { id: "repro_steps", label: "Reproduction steps" },
        { id: "environment", label: "Environment or version" },
      ],
      suggestion_status: null,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];

const suggestion = {
  issue_id: 1,
  status: "draft",
  base_body: "Auth fails.",
  proposed_body: "Auth fails.\n\n## Reproduction Steps\n1. \n",
  missing_requirements: [{ id: "repro_steps", label: "Reproduction steps" }],
  edited: false,
  sections: [
    {
      requirement_id: "repro_steps",
      heading: "Reproduction Steps",
      body_md: "1. \n",
      origin: "scaffold",
      model: null,
      edited: false,
      removed: false,
      stale: false,
    },
  ],
  drafted_at: "2026-07-24T00:00:00Z",
  pushed_at: null,
};

/**
 * Stateful stub: push/PATCH move `status`, and the inbox reports it back the
 * way the real backend does — so assertions about what the row shows after a
 * terminal action never race a stale refetch. `patches` records every status
 * PATCH, which is how the tests prove that dismissing the drawer is not a
 * reject.
 */
async function stub(page: Page, patches: unknown[] = []) {
  let status: string | null = null;

  await page.route(/\/api\/backend\/repositories$/, (r: Route) => r.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/triage\/inbox/, (r: Route) =>
    r.fulfill({
      json: {
        ...inbox,
        items: inbox.items.map((i) => ({ ...i, suggestion_status: status })),
      },
    }),
  );
  await page.route(/\/api\/backend\/issues\/1\/suggestion\/push$/, (r: Route) => {
    status = "pushed";
    return r.fulfill({ json: { ...suggestion, status: "pushed" } });
  });
  await page.route(/\/api\/backend\/issues\/1\/suggestion\/sections\/[^/]+$/, (r: Route) => {
    const rid = r.request().url().match(/sections\/([^/]+)$/)?.[1];
    const parsed = JSON.parse(r.request().postData() ?? "{}");
    const sections = suggestion.sections.map((s) =>
      s.requirement_id === rid
        ? {
            ...s,
            ...(parsed.body_md !== undefined ? { body_md: parsed.body_md, edited: true } : {}),
            ...(parsed.removed !== undefined ? { removed: parsed.removed } : {}),
          }
        : s,
    );
    return r.fulfill({ json: { ...suggestion, sections } });
  });
  await page.route(/\/api\/backend\/issues\/1\/suggestion$/, (r: Route) => {
    if (r.request().method() === "PATCH") {
      const parsed = JSON.parse(r.request().postData() ?? "{}");
      patches.push(parsed);
      if (parsed.status) status = parsed.status;
      return r.fulfill({ json: { ...suggestion, ...parsed, edited: !!parsed.proposed_body } });
    }
    return r.fulfill({ json: suggestion }); // POST generate
  });
}

/** Open the drawer for the single inbox row. */
async function openDrawer(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: /Suggest fixes|View suggestion/ }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
}

test("inbox shows the needs-detail row with missing chips", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(page.getByTestId("triage-row")).toBeVisible();
  await expect(page.getByTestId("missing-chips")).toContainText("Reproduction steps");
  await expect(page.getByTestId("missing-chips")).toContainText("Environment");
});

test("suggest fixes opens the side-by-side suggestion panes", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  const suggest = page.getByRole("button", { name: "Suggest fixes" });
  await expect(async () => {
    await suggest.click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await expect(page.getByTestId("suggestion-panes")).toBeVisible();
  await expect(page.getByTestId("section-block-repro_steps")).toBeVisible();
  await expect(page.getByTestId("gap-marker-repro_steps")).toBeVisible();
  await expect(page.getByTestId("section-chip-repro_steps")).toHaveText(/EMPTY SCAFFOLD|AI DRAFT/);
});

test("reject discards the suggestion and closes the drawer", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(async () => {
    await page.getByRole("button", { name: "Suggest fixes" }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
});

test("approve & push closes the drawer and the row reports pushed", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByTestId("approve-push").click();
  // the item is resolved — the drawer gets out of the way and the inbox carries
  // the outcome
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
  await expect(page.getByTestId("row-status")).toHaveText("pushed");
});

test("save as suggestion keeps the drawer open and confirms", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByRole("button", { name: "Save as suggestion" }).click();
  await expect(page.getByTestId("saved-confirmation")).toBeVisible();
  // still editable — saving is not a terminal action
  await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  await expect(page.getByTestId("row-status")).toHaveText("suggested");
});

test("the × closes the drawer without rejecting", async ({ page }) => {
  const patches: unknown[] = [];
  await stub(page, patches);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
  // dismissing must not touch the suggestion's status
  expect(patches).toEqual([]);
  await expect(page.getByTestId("row-status")).toBeHidden();
});

test("Done closes the drawer without rejecting", async ({ page }) => {
  const patches: unknown[] = [];
  await stub(page, patches);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByTestId("drawer-done").click();
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
  expect(patches).toEqual([]);
});

test("Escape closes the drawer without rejecting", async ({ page }) => {
  const patches: unknown[] = [];
  await stub(page, patches);
  await page.goto("/triage");
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
  expect(patches).toEqual([]);
});

test("Escape inside a section editor cancels the editor, not the drawer", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("edit-repro_steps").click();
  await expect(page.getByTestId("section-editor-repro_steps")).toBeVisible();

  await page.getByTestId("section-editor-repro_steps").press("Escape");
  await expect(page.getByTestId("section-editor-repro_steps")).toBeHidden();
  // the drawer survives — Escape is scoped to the innermost open thing
  await expect(page.getByTestId("suggestion-drawer")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suggestion-drawer")).toBeHidden();
});

test("Escape inside the steer popover dismisses only the popover", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await openDrawer(page);
  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("steer-repro_steps").click();
  await expect(page.getByTestId("steer-popover-repro_steps")).toBeVisible();

  await page.getByLabel("Steer Reproduction Steps").press("Escape");
  await expect(page.getByTestId("steer-popover-repro_steps")).toBeHidden();
  await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
});

test("editing a section body saves a per-section edit", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(async () => {
    await page.getByRole("button", { name: "Suggest fixes" }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("edit-repro_steps").click();
  await page.getByTestId("section-editor-repro_steps").fill("1. Log in\n2. Refresh\n");
  await page.getByRole("button", { name: "Save section" }).click();
  await expect(page.getByTestId("section-block-repro_steps")).toContainText("edited");
});
