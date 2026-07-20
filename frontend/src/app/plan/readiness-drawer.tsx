"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

type Factor = {
  requirement: string;
  points: number;
  present: boolean;
  evidence: string | null;
};

type ReadinessBreakdown = {
  score: number;
  issue_type: string;
  scored_at: string;
  factors: Factor[];
};

export function ReadinessDrawer({ issueId }: { issueId: number }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["readiness", issueId],
    queryFn: () =>
      getJson<ReadinessBreakdown>(`/api/backend/issues/${issueId}/readiness`),
  });

  if (isPending) {
    return <div className="text-(--color-text-muted)">Loading readiness…</div>;
  }
  if (error) {
    return (
      <div className="text-(--color-text-muted)">
        Could not load the readiness breakdown.
      </div>
    );
  }

  const present = data.factors.filter((f) => f.present);
  const missing = data.factors.filter((f) => !f.present);

  return (
    <div className="flex flex-col gap-3" data-testid="readiness-drawer">
      <div className="text-sm font-semibold">
        Readiness {data.score}/100 · {data.issue_type}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ul className="flex flex-col gap-1" data-testid="readiness-present">
          {present.length === 0 ? (
            <li className="text-(--color-text-muted)">Nothing satisfied yet</li>
          ) : (
            present.map((f) => (
              <li key={f.requirement} className="text-(--type-feature)">
                + {f.requirement} ({f.points})
                {f.evidence ? (
                  <span className="text-(--color-text-muted)"> — {f.evidence}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
        <ul className="flex flex-col gap-1" data-testid="readiness-missing">
          {missing.length === 0 ? (
            <li className="text-(--color-text-muted)">Everything covered</li>
          ) : (
            missing.map((f) => (
              <li key={f.requirement} className="text-(--type-bug)">
                − {f.requirement} (0/{f.points})
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
