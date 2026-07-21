import { Suspense } from "react";
import { TriageClient } from "./triage-client";

export default function TriagePage() {
  return (
    <Suspense fallback={null}>
      <TriageClient />
    </Suspense>
  );
}
