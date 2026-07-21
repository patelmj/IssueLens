import { Suspense } from "react";
import { BoardClient } from "./board-client";

export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <BoardClient />
    </Suspense>
  );
}
