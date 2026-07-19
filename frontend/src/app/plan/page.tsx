import { Suspense } from "react";
import { PlanClient } from "./plan-client";

export default function PlanPage() {
  return (
    <Suspense fallback={null}>
      <PlanClient />
    </Suspense>
  );
}
