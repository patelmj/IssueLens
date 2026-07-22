import { expect, test } from "@playwright/test";
import {
  PLOT,
  radiusOf,
  resolveCollisions,
  xOf,
  yOf,
} from "../src/app/plan/matrix/matrix-layout";
import type { PlottedItem } from "../src/app/plan/matrix/matrix-types";

const item = (over: Partial<PlottedItem>): PlottedItem => ({
  issue_id: 1,
  number: 1,
  title: "t",
  urgency: 75,
  importance: 75,
  factors: [],
  issue_type: "bug",
  component: null,
  readiness_score: null,
  labels: [],
  assignees: [],
  estimate: 2,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: null,
  model: null,
  u: 75,
  i: 75,
  ...over,
});

const at = (id: number, u: number, i: number, over: Partial<PlottedItem> = {}) =>
  item({ issue_id: id, number: id, u, i, urgency: u, importance: i, ...over });

const nudgedCenter = (items: PlottedItem[], id: number) => {
  const nudge = resolveCollisions(items).get(id)!;
  const it = items.find((x) => x.issue_id === id)!;
  return { x: xOf(it.u) + nudge.dx, y: yOf(it.i) + nudge.dy };
};

test("far-apart bubbles get zero nudge", () => {
  const items = [at(1, 20, 20), at(2, 80, 80)];
  const nudges = resolveCollisions(items);
  expect(nudges.get(1)).toEqual({ dx: 0, dy: 0 });
  expect(nudges.get(2)).toEqual({ dx: 0, dy: 0 });
});

test("identical-score bubbles separate to non-overlapping centers", () => {
  const items = [at(1, 75, 75), at(2, 75, 75)];
  const a = nudgedCenter(items, 1);
  const b = nudgedCenter(items, 2);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  expect(dist).toBeGreaterThanOrEqual(radiusOf(2) * 2 + 2 - 0.01);
});

test("deterministic: same input twice gives identical output", () => {
  const items = [at(1, 75, 75), at(2, 75, 75), at(3, 74.8, 75.2), at(4, 75.1, 74.9)];
  const first = [...resolveCollisions(items).entries()];
  const second = [...resolveCollisions(items).entries()];
  expect(second).toEqual(first);
});

test("input order does not change the result", () => {
  const items = [at(1, 75, 75), at(2, 75, 75), at(3, 74.8, 75.2)];
  const reversed = [...items].reverse();
  const a = resolveCollisions(items);
  const b = resolveCollisions(reversed);
  for (const id of [1, 2, 3]) expect(b.get(id)).toEqual(a.get(id));
});

test("pinned bubbles never move; neighbors flow around them", () => {
  const items = [
    at(1, 75, 75, { pinned: true, pinned_urgency: 75, pinned_importance: 75 }),
    at(2, 75, 75),
  ];
  const nudges = resolveCollisions(items);
  expect(nudges.get(1)).toEqual({ dx: 0, dy: 0 });
  const moved = nudges.get(2)!;
  expect(Math.hypot(moved.dx, moved.dy)).toBeGreaterThan(0);
});

test("nudged centers never cross the midlines of their true quadrant", () => {
  // tight cluster hugging the do-first inner corner (u,i just over 50)
  const items = [at(1, 51, 51), at(2, 51.2, 50.8), at(3, 50.6, 51.4), at(4, 51, 50.5)];
  const nudges = resolveCollisions(items);
  const midX = xOf(50);
  const midY = yOf(50);
  for (const it of items) {
    const n = nudges.get(it.issue_id)!;
    const x = xOf(it.u) + n.dx;
    const y = yOf(it.i) + n.dy;
    expect(x).toBeGreaterThanOrEqual(midX);
    expect(y).toBeLessThanOrEqual(midY); // higher importance = smaller y
    expect(x).toBeLessThanOrEqual(PLOT.right);
    expect(y).toBeGreaterThanOrEqual(PLOT.top);
  }
});

test("an exact stack of four fans out to four distinct positions", () => {
  const items = [at(1, 25, 75), at(2, 25, 75), at(3, 25, 75), at(4, 25, 75)];
  const nudges = resolveCollisions(items);
  const centers = items.map((it) => {
    const n = nudges.get(it.issue_id)!;
    return `${(xOf(it.u) + n.dx).toFixed(2)},${(yOf(it.i) + n.dy).toFixed(2)}`;
  });
  expect(new Set(centers).size).toBe(4);
});
