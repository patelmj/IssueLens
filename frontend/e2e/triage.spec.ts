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

async function stub(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (r: Route) => r.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/triage\/inbox/, (r: Route) => r.fulfill({ json: inbox }));
  await page.route(/\/api\/backend\/issues\/1\/suggestion\/push$/, (r: Route) =>
    r.fulfill({ json: { ...suggestion, status: "pushed" } }),
  );
  await page.route(/\/api\/backend\/issues\/1\/suggestion$/, (r: Route) => {
    if (r.request().method() === "PATCH") {
      const parsed = JSON.parse(r.request().postData() ?? "{}");
      return r.fulfill({ json: { ...suggestion, ...parsed, edited: !!parsed.proposed_body } });
    }
    return r.fulfill({ json: suggestion }); // POST generate
  });
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

test("approve & push marks the suggestion pushed", async ({ page }) => {
  await stub(page);
  await page.goto("/triage");
  await expect(async () => {
    await page.getByRole("button", { name: "Suggest fixes" }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
  await page.getByTestId("approve-push").click();
  await expect(page.getByTestId("suggestion-drawer")).toContainText("pushed");
});

test.fixme(
  "editing a section body saves a per-section edit",
  // enabled in Task 9: the old whole-body "Save edits" textarea is gone;
  // Task 9 adds per-section edit controls on SectionBlock that this will target.
  async ({ page }) => {
    await stub(page);
    await page.goto("/triage");
    await expect(async () => {
      await page.getByRole("button", { name: "Suggest fixes" }).click();
      await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
    }).toPass();
    await page.getByTestId("section-block-repro_steps").getByRole("button", { name: "Edit" }).click();
    await page.getByRole("textbox", { name: "Edit section" }).fill("1. Log in\n2. Refresh\n");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("section-chip-repro_steps")).toContainText("edited");
  },
);
