import { quadrantOf, type PlottedItem } from "./matrix-types";

export const VIEW_W = 860;
export const VIEW_H = 560;
export const PLOT = { left: 52, right: 842, top: 18, bottom: 514 };
const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496

export function xOf(u: number): number {
  return PLOT.left + (u / 100) * PLOT_W;
}
export function yOf(i: number): number {
  return PLOT.bottom - (i / 100) * PLOT_H;
}
export function radiusOf(estimate: number): number {
  return 8 + estimate * 2.1;
}

export type Nudge = { dx: number; dy: number };

type Body = {
  id: number;
  x: number;
  y: number;
  r: number;
  fixed: boolean;
  originX: number;
  originY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Deterministic display-space collision relaxation. Returns per-issue pixel
 * offsets (viewBox units) that separate overlapping bubbles without letting
 * any center cross the midlines of its true quadrant or leave the plot rect.
 * Pinned bubbles are fixed obstacles and always get a zero offset. Pure:
 * same input ⇒ same output, regardless of input order.
 */
export function resolveCollisions(
  plotted: PlottedItem[],
  opts: { iterations?: number; padding?: number } = {},
): Map<number, Nudge> {
  const iterations = opts.iterations ?? 30;
  const padding = opts.padding ?? 2;
  const midX = xOf(50);
  const midY = yOf(50);

  const bodies: Body[] = [...plotted]
    .sort((a, b) => a.issue_id - b.issue_id)
    .map((p) => {
      const x = xOf(p.u);
      const y = yOf(p.i);
      const quadrant = quadrantOf(p);
      const right = quadrant === "dofirst" || quadrant === "delegate";
      const top = quadrant === "dofirst" || quadrant === "schedule";
      return {
        id: p.issue_id,
        x,
        y,
        r: radiusOf(p.estimate),
        fixed: p.pinned,
        originX: x,
        originY: y,
        minX: right ? midX : PLOT.left,
        maxX: right ? PLOT.right : midX,
        minY: top ? PLOT.top : midY,
        maxY: top ? midY : PLOT.bottom,
      };
    });

  for (let iter = 0; iter < iterations; iter++) {
    let movedAny = false;
    for (let a = 0; a < bodies.length; a++) {
      for (let b = a + 1; b < bodies.length; b++) {
        const bodyA = bodies[a];
        const bodyB = bodies[b];
        if (bodyA.fixed && bodyB.fixed) continue;
        const dx = bodyB.x - bodyA.x;
        const dy = bodyB.y - bodyA.y;
        const dist = Math.hypot(dx, dy);
        const target = bodyA.r + bodyB.r + padding;
        if (dist >= target) continue;

        let ux: number;
        let uy: number;
        if (dist > 1e-6) {
          ux = dx / dist;
          uy = dy / dist;
        } else {
          // exact stack: deterministic fan-out direction derived from the ids
          const angle = ((bodyA.id * 31 + bodyB.id * 17) % 360) * (Math.PI / 180);
          ux = Math.cos(angle);
          uy = Math.sin(angle);
        }

        const shortfall = target - dist;
        const moveA = bodyA.fixed ? 0 : bodyB.fixed ? shortfall : shortfall / 2;
        const moveB = bodyB.fixed ? 0 : bodyA.fixed ? shortfall : shortfall / 2;
        if (moveA > 0) {
          bodyA.x = clamp(bodyA.x - ux * moveA, bodyA.minX, bodyA.maxX);
          bodyA.y = clamp(bodyA.y - uy * moveA, bodyA.minY, bodyA.maxY);
          movedAny = true;
        }
        if (moveB > 0) {
          bodyB.x = clamp(bodyB.x + ux * moveB, bodyB.minX, bodyB.maxX);
          bodyB.y = clamp(bodyB.y + uy * moveB, bodyB.minY, bodyB.maxY);
          movedAny = true;
        }
      }
    }
    if (!movedAny) break;
  }

  const out = new Map<number, Nudge>();
  for (const body of bodies) {
    out.set(body.id, { dx: body.x - body.originX, dy: body.y - body.originY });
  }
  return out;
}
