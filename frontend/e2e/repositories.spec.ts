import { expect, test } from "@playwright/test";

test("repositories page renders its content region", async ({ page }) => {
  await page.goto("/repositories");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Repositories");
  await expect(page.getByTestId("repositories-content")).toBeVisible();
});
