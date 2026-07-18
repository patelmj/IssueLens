import { PagePlaceholder } from "../../components/page-placeholder";

export default function PlanPage() {
  return (
    <PagePlaceholder
      title="Plan"
      hint="Board, matrix, and dependencies"
      emptyTitle="No plan to show yet"
      emptyBody="The kanban board, priority matrix, and dependency map light up here once issues are synced."
    />
  );
}
