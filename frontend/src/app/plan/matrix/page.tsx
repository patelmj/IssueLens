import { Suspense } from "react";
import { MatrixClient } from "./matrix-client";

export default function MatrixPage() {
  return (
    <Suspense fallback={null}>
      <MatrixClient />
    </Suspense>
  );
}
