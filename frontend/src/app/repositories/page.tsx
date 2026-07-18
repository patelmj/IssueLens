import { PagePlaceholder } from "../../components/page-placeholder";

export default function RepositoriesPage() {
  return (
    <PagePlaceholder
      title="Repositories"
      hint="Connected sources"
      emptyTitle="No repositories connected"
      emptyBody="Connecting GitHub repositories is coming in the next milestone — synced repos and their status will be managed here."
    />
  );
}
