import { Suspense } from "react";
import { AnalyzeClient } from "./analyze-client";

export default function AnalyzePage() {
  return (
    <Suspense fallback={null}>
      <AnalyzeClient />
    </Suspense>
  );
}
