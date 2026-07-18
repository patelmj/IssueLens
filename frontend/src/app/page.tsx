import { PagePlaceholder } from "../components/page-placeholder";

export default function OverviewPage() {
  return (
    <PagePlaceholder
      title="Overview"
      hint="Your issue landscape at a glance"
      emptyTitle="Connect a repository to begin"
      emptyBody="Once a repository is connected, this page shows readiness, triage load, and delivery signals across your issues."
    />
  );
}
