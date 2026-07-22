"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { getJson } from "../lib/api";
import { boardFiltersToSearch, parseBoardFilters } from "../lib/board-filters";
import { filtersToSearch, parseFilters } from "../lib/matrix-filters";
import { parseTableFilters, tableFiltersToSearch } from "../lib/table-filters";
import {
  fetchViews,
  savedViewHref,
  savedViewKindLabel,
  VIEWS_KEY,
  type SavedView,
} from "../lib/views";

export const NAV_ITEMS = [
  {
    group: "Workspace",
    items: [
      { label: "Overview", href: "/" },
      { label: "Triage", href: "/triage" },
      {
        label: "Plan",
        href: "/plan",
        children: [
          { label: "Table", href: "/plan" },
          { label: "Matrix", href: "/plan/matrix" },
          { label: "Board", href: "/plan/board" },
        ],
      },
      { label: "Analyze", href: "/analyze" },
    ],
  },
  {
    group: "Library",
    items: [
      { label: "Saved Views", href: "/views" },
      { label: "Repositories", href: "/repositories" },
    ],
  },
];

type Repo = { id: number; full_name: string };

const childLink = (active: boolean) =>
  `flex items-center rounded-lg py-1.5 pl-7 transition-all duration-150 ${
    active
      ? "bg-(--accent-tint) font-medium text-(--color-primary)"
      : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
  }`;

function SavedViewLink({ view, currentUrl }: { view: SavedView; currentUrl: string }) {
  const viewHref = savedViewHref(view);
  const kindInitial = (
    <span className="w-3.5 shrink-0 text-[10px] font-semibold text-(--color-text-muted)">
      {savedViewKindLabel(view)[0]?.toUpperCase() ?? "?"}
    </span>
  );
  if (viewHref == null) {
    return (
      <span className={`${childLink(false)} cursor-default gap-1.5`}>
        {kindInitial}
        <span className="truncate">{view.name}</span>
      </span>
    );
  }
  return (
    <Link
      href={viewHref}
      data-testid={`saved-view-link-${view.id}`}
      className={`${childLink(currentUrl === viewHref)} gap-1.5`}
    >
      {kindInitial}
      <span className="truncate">{view.name}</span>
    </Link>
  );
}

export function Sidenav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoParam = searchParams.get("repo_id");
  const repoId = repoParam ? Number(repoParam) : null;
  // Canonical search for the *current* surface, so hand-ordered URLs still
  // highlight the matching saved view.
  const canonicalSearch =
    pathname === "/plan/matrix"
      ? filtersToSearch(repoId, parseFilters(searchParams))
      : pathname === "/plan"
        ? tableFiltersToSearch(repoId, parseTableFilters(searchParams))
        : pathname === "/plan/board"
          ? boardFiltersToSearch(repoId, parseBoardFilters(searchParams))
          : "";
  const currentUrl = canonicalSearch ? `${pathname}?${canonicalSearch}` : pathname;

  const { data: views } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
    retry: false,
    staleTime: 30_000,
  });
  const { data: repos } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => getJson<Repo[]>("/api/backend/repositories"),
    retry: false,
    staleTime: 30_000,
  });

  const allViews = views ?? [];
  const matchedRepoIds = new Set((repos ?? []).map((repo) => repo.id));
  const unmatchedViews = allViews.filter(
    (view) => view.repository_id == null || !matchedRepoIds.has(view.repository_id),
  );
  // Repo groups in API repo order; views with no matching repo trail ungrouped;
  // flat fallback while repos are unavailable.
  const groups: { label: string | null; views: SavedView[] }[] = repos
    ? [
        ...repos
          .map((repo) => ({
            label: repo.full_name.split("/")[1] ?? repo.full_name,
            views: allViews.filter((view) => view.repository_id === repo.id),
          }))
          .filter((group) => group.views.length > 0),
        ...(unmatchedViews.length ? [{ label: null, views: unmatchedViews }] : []),
      ]
    : allViews.length
      ? [{ label: null, views: allViews }]
      : [];

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 py-1">
      {NAV_ITEMS.map(({ group, items }) => (
        <div key={group}>
          <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
            {group}
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map(({ label, href, children }) => {
              const active = pathname === href;
              const sectionActive =
                !active && !!children && pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center justify-between rounded-lg px-3 py-1.5 transition-all duration-150 ${
                      active
                        ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                        : sectionActive
                          ? "bg-(--accent-tint) text-(--color-text-muted) hover:text-(--color-text)"
                          : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)"
                      data-testid={href === "/views" ? "views-count" : undefined}
                    >
                      {href === "/views" && views ? views.length : "–"}
                    </span>
                  </Link>
                  {children ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {children.map((child) => (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            aria-current={pathname === child.href ? "page" : undefined}
                            className={childLink(pathname === child.href)}
                          >
                            {child.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {href === "/views" && groups.length > 0 ? (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {groups.map((viewGroup) => (
                        <div key={viewGroup.label ?? "all"}>
                          {viewGroup.label ? (
                            <div className="pt-1 pb-0.5 pl-7 text-[10px] font-medium text-(--color-text-muted)">
                              {viewGroup.label}
                            </div>
                          ) : null}
                          <ul className="flex flex-col gap-0.5">
                            {viewGroup.views.map((view) => (
                              <li key={view.id}>
                                <SavedViewLink view={view} currentUrl={currentUrl} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
