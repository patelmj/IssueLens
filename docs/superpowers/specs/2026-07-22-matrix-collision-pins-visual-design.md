# Matrix: collision handling, discoverable pin reset, visual refresh

**Date:** 2026-07-22
**Issues:** [#54](https://github.com/patelmj/IssueLens/issues/54) (bubble stacking),
[#53](https://github.com/patelmj/IssueLens/issues/53) (discoverable pin reset),
[#51](https://github.com/patelmj/IssueLens/issues/51) (chart visual refresh)
**Scope:** frontend only — no backend, scoring, or API changes. All decisions below were
validated visually in a brainstorm session (mockups preserved in
`.superpowers/brainstorm/2595-1784737288/content/`).

## 1. Collision handling (#54)

A deterministic render-time collision resolver. True scores are never modified; the nudge
is a display-space offset only.

### Module

New pure module `frontend/src/app/plan/matrix/matrix-layout.ts`:

```ts
export type Nudge = { dx: number; dy: number };

/** Deterministic display-space collision relaxation.
 *  Returns offsets (px, viewBox units) keyed by issue_id. */
export function resolveCollisions(
  plotted: PlottedItem[],
  opts?: { iterations?: number; padding?: number },
): Map<number, Nudge>;
```

- Circle geometry comes from the same `xOf` / `yOf` / `radiusOf` math the chart uses
  (import from a shared location; `matrix-chart.tsx` re-exports today — move the
  constants/helpers into `matrix-layout.ts` and have the chart import them, so the
  resolver has no React dependency).
- **Algorithm:** bounded iterative pairwise separation. Fixed `iterations` (default 30);
  each pass processes pairs in ascending `(issue_id_a, issue_id_b)` order. For an
  overlapping pair (center distance < rA + rB + `padding`, default padding 2), push each
  movable bubble apart along the center line by half the shortfall. Equal centers
  (distance 0) use a deterministic fallback direction derived from `issue_id` (e.g. angle
  = hash(id) mod 2π) so exact stacks fan out identically every render.
- **Invariants:**
  - A bubble's nudged **center** never crosses the u=50 / i=50 lines of its true
    quadrant, and never leaves the plot rect. Clamp after every displacement.
  - **Pinned bubbles get zero nudge** — they are fixed obstacles; movable bubbles flow
    around them.
  - Output is a pure function of input (no randomness, no time) — same items ⇒ same
    offsets.
  - When density exceeds available area, residual overlap is acceptable (clustering
    remains #35's scope).

### Chart integration

- `MatrixChart` computes `useMemo(() => resolveCollisions(plotted), [plotted])` and adds
  the offset to each bubble's rendered `cx/cy`.
- The bubble currently being dragged renders at the raw pointer position (no nudge), and
  drop coordinates (`onPin`) use pointer position exactly as today.
- Hover card and selection anchor at the **nudged** position (that's where the bubble
  visibly is); the values shown inside remain true scores.

## 2. Discoverable pin reset (#53)

### Queue rows (`execution-queue.tsx`)

- Replace the inert 📌 emoji with the accent pushpin icon (same glyph as the chart badge,
  inline SVG, `--color-primary` fill).
- On row hover/focus-within, a small **×** button appears beside the pin icon,
  `aria-label="Release #<number> to AI"`, `data-testid="qrow-release-<number>"`.
  Clicking it releases that pin (does not toggle row selection).
- `ExecutionQueue` gains `onRelease: (issueId: number) => void`, wired in
  `matrix-client.tsx` to the existing `releaseMutation`.

### Pinned-count chip (`matrix-client.tsx` control row)

- When the repo has ≥1 pinned issue (counted over **all** `data.items`, ignoring
  filters), show a chip after the filter chips: pushpin glyph + `N pinned`,
  `data-testid="pinned-chip"`.
- Click expands the chip inline to a confirm step: `Release all N?` with a confirm
  button (`data-testid="release-all-confirm"`) and an ✕ to collapse. Confirming fires
  `DELETE /issues/{id}/pin` for every pinned issue via one mutation
  (`Promise.all`), with a single optimistic update (all pins cleared) and a single
  rollback + error message on any failure, following the existing mutation shape.
- Chip is hidden at zero pins. The existing pin toast (select → "Release to AI") is
  unchanged.

## 3. Visual refresh (#51)

### Bubble treatment (choice D — soft fill, crisp edge)

- Bubble: `fill` = series color at **85% opacity**, `stroke` = same series color at
  full opacity, `strokeWidth` 1.5. The 2px surface-colored ring is removed.
- Label halo (`stroke` on the number text) slims from 2 to 1.5. The ink `#number` label
  stays on every bubble — this is the light-mode redundancy the dataviz validation
  requires (debt/task are sub-3:1); do not remove it.

### Pinned indicator (choice C — pushpin badge)

- The dashed pin ring is removed. Pinned bubbles instead get a badge on the NE shoulder
  (center at `bubble center + r·0.72·(+1,−1)`): circle r 5.5, fill `--color-primary`,
  stroke `--color-surface` width 1.2, containing a white pushpin glyph (rotated 45°:
  stem line + head dot, as validated in the mockup).
- `data-testid="pin-badge-<number>"` replaces `pin-ring-<number>`.
- Legend text: `size = effort · dashed ring = pinned` → `size = effort · 📌 = pinned`
  (rendered with the same SVG glyph, not the emoji).
- The `--pin-ring` token is deleted.

### Selected indicator (choice C — accent glow)

- The `r+9` accent circle is removed. Selected bubbles render a blurred accent ring
  *behind* the bubble: circle at `r+1`, `stroke: var(--color-primary)`, strokeWidth 5,
  opacity .35, `filter: feGaussianBlur stdDeviation 3.2` (single shared `<filter>` def).
- Selected + pinned compose: glow behind, badge on top.

### Chart surface (choice B — corner-fade gradient washes)

- Each quadrant's flat tint becomes an SVG `<radialGradient>` anchored at the quadrant's
  **outer corner** (radius 1.15 in object-bounding-box terms): stop 0 = quadrant color at
  **2.6×** the current tint alpha, stop 1 = fully transparent. Center of the chart ends
  at zero tint.
- New tokens in `globals.css` — `--quad-schedule-strong`, `--quad-dofirst-strong`,
  `--quad-delegate-strong`, `--quad-reconsider-strong` — holding the 2.6× rgba values
  per mode (light: base alpha .05 → .13; dark: .10 → .26). Existing `--quad-*` tokens
  are removed with the flat rects. Gradient stops reference the tokens via
  `stop-color="var(--quad-…-strong)"`.
- Midlines (u=50, i=50) become dashed `3 3`, still `--chart-grid`.
- Quadrant corner labels take their quadrant's color: new tokens
  `--quad-*-label` (quadrant color at .9 alpha per mode) replacing the muted gray.
  Uppercase/size/weight unchanged.

### Axes

- `Urgency →` stays as-is (bottom-right, muted).
- The horizontal `Importance ↑` at top-left is replaced by a **vertical** label along the
  y-axis: `Importance →`, `transform="translate(14, PLOT.bottom) rotate(-90)"`, same
  muted fill and size — visually symmetric with the x label.

### Entrance motion (choice B — ranked pop-in)

- On chart mount (initial load, repo switch): quadrant washes fade in (~0.5s), each
  bubble pops in — scale 0 → 1 with soft overshoot (`cubic-bezier(.34,1.56,.64,1)`,
  0.45s) — with `animation-delay = 200ms + rank·70ms`, where rank orders by `u+i`
  descending (Do First lands first). CSS-only: classes + keyframes in `globals.css`,
  per-bubble delay via inline `--d` custom property; `transform-box: fill-box;
  transform-origin: center`.
- Bubbles keyed by issue id — pin/select/filter re-renders do not replay the animation;
  newly appearing bubbles (filter change) animate in individually. Chart remounts on
  repo switch (keyed by `repoId`) to replay.
- Wrapped in `@media (prefers-reduced-motion: reduce)` → animations disabled.
- Dragging is unaffected (animation fills `both` and has finished by first interaction).

## 4. Files touched

| File | Change |
|---|---|
| `matrix-layout.ts` (new) | geometry constants + `resolveCollisions` |
| `matrix-chart.tsx` | import geometry, apply nudges, new bubble/pin/selection/surface/axis rendering, entrance classes |
| `matrix-client.tsx` | pinned chip + release-all mutation, `onRelease` wiring |
| `execution-queue.tsx` | pin icon + hover release button |
| `globals.css` | new quad tokens, drop `--pin-ring`, entrance keyframes |
| `matrix-types.ts` | unchanged (types suffice) |

## 5. Testing

- **Unit (`matrix-layout.test.ts`):** determinism (same input twice ⇒ identical output);
  no overlapping pair moves closer; nudged centers never cross their true quadrant
  midlines nor plot bounds; pinned items get zero offset; exact-stack fan-out is stable;
  iteration bound respected.
- **Component/e2e (Playwright CLI):** update every `pin-ring-*` reference to
  `pin-badge-*`; row hover shows release button and releasing unpins (row + chart
  agree); pinned chip appears/counts/confirms/releases all with optimistic update;
  dense-seed repo renders with no two same-quadrant bubbles at identical centers;
  reduced-motion path renders bubbles immediately.
- Full frontend test suite + lint before PR; live verification against the dev server
  per the run/verify workflow (watch for the orphaned :3005 listener gotcha).

## 6. Out of scope

- Clustering, zoom/pan, lasso multi-select — #35.
- Backend scoring precision/jitter (rejected for #54 in favor of render-time nudge).
- Any change to pin persistence APIs.
