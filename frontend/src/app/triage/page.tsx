import { PagePlaceholder } from "../../components/page-placeholder";

export default function TriagePage() {
  return (
    <PagePlaceholder
      title="Triage"
      hint="Issues that need attention first"
      emptyTitle="Nothing to triage yet"
      emptyBody="After your first sync, new and incomplete issues land here with readiness scores and suggested next steps."
    />
  );
}
