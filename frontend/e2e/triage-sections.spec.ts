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

type Section = {
  requirement_id: string;
  heading: string;
  body_md: string;
  origin: "ai" | "scaffold";
  model: string | null;
  edited: boolean;
  removed: boolean;
  stale: boolean;
};

function baseSuggestion() {
  return {
    issue_id: 1,
    status: "draft",
    base_body: "Auth fails.",
    proposed_body: "Auth fails.\n\n## Reproduction Steps\n1. \n\n## Environment\n- OS: \n",
    missing_requirements: [
      { id: "repro_steps", label: "Reproduction steps" },
      { id: "environment", label: "Environment or version" },
    ],
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
      {
        requirement_id: "environment",
        heading: "Environment",
        body_md: "- OS: \n",
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
}

async function stub(page: Page) {
  let current = baseSuggestion();

  await page.route(/\/api\/backend\/repositories$/, (r: Route) => r.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/triage\/inbox/, (r: Route) => r.fulfill({ json: inbox }));
  await page.route(/\/api\/backend\/issues\/1\/suggestion\/push$/, (r: Route) =>
    r.fulfill({ json: { ...current, status: "pushed" } }),
  );

  await page.route(/\/api\/backend\/issues\/1\/suggestion\/sections\/[^/]+$/, (r: Route) => {
    const rid = r.request().url().match(/sections\/([^/]+)$/)?.[1];
    const parsed = JSON.parse(r.request().postData() ?? "{}") as {
      body_md?: string;
      removed?: boolean;
    };
    current = {
      ...current,
      sections: current.sections.map((s: Section) =>
        s.requirement_id === rid
          ? {
              ...s,
              ...(parsed.body_md !== undefined ? { body_md: parsed.body_md, edited: true } : {}),
              ...(parsed.removed !== undefined ? { removed: parsed.removed } : {}),
            }
          : s,
      ),
    };
    return r.fulfill({ json: current });
  });

  await page.route(/\/api\/backend\/issues\/1\/suggestion$/, (r: Route) => {
    if (r.request().method() === "PATCH") {
      const parsed = JSON.parse(r.request().postData() ?? "{}");
      current = { ...current, ...parsed, edited: !!parsed.proposed_body };
      return r.fulfill({ json: current });
    }
    current = baseSuggestion(); // POST generate
    return r.fulfill({ json: current });
  });
}

async function openDrawer(page: Page) {
  await page.goto("/triage");
  await expect(async () => {
    await page.getByRole("button", { name: "Suggest fixes" }).click();
    await expect(page.getByTestId("suggestion-drawer")).toBeVisible();
  }).toPass();
}

test("edit a section inline and save", async ({ page }) => {
  await stub(page);
  await openDrawer(page);

  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("edit-repro_steps").click();
  await page.getByTestId("section-editor-repro_steps").fill("1. my own steps");
  await page.getByRole("button", { name: "Save section" }).click();

  await expect(page.getByTestId("section-block-repro_steps")).toContainText("my own steps");
  await expect(page.getByTestId("section-block-repro_steps")).toContainText("edited");
});

test("remove then restore a section", async ({ page }) => {
  await stub(page);
  await openDrawer(page);

  await page.getByTestId("section-block-environment").hover();
  await page.getByTestId("remove-environment").click();
  await expect(page.getByTestId("section-block-environment")).toHaveCount(0);

  await page.getByTestId("restore-environment").click();
  await expect(page.getByTestId("section-block-environment")).toBeVisible();
});

test("steer popover redrafts via mocked endpoint", async ({ page }) => {
  await stub(page);

  await page.route("**/suggestion/sections/repro_steps/regenerate", async (route: Route) => {
    const current = baseSuggestion();
    const sections = current.sections.map((s: Section) =>
      s.requirement_id === "repro_steps"
        ? { ...s, body_md: "1. steered draft", origin: "ai", model: "mock", edited: false, stale: false }
        : s,
    );
    await route.fulfill({ json: { ...current, sections, drafted_at: "2026-07-24T00:00:00Z" } });
  });

  await openDrawer(page);

  await page.getByTestId("section-block-repro_steps").hover();
  await page.getByTestId("steer-repro_steps").click();
  await page.getByLabel("Steer Reproduction Steps").fill("mention Safari");
  await page.getByTestId("steer-submit-repro_steps").click();

  await expect(page.getByTestId("section-block-repro_steps")).toContainText("steered draft");
  await expect(page.getByTestId("section-chip-repro_steps")).toContainText("AI DRAFT");
  await expect(page.getByTestId("suggestion-footnote")).toContainText("drafted by mock");
});
