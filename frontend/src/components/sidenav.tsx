"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { filtersToSearch, parseFilters } from "../lib/matrix-filters";
import { fetchViews, savedViewHref, VIEWS_KEY } from "../lib/views";

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

const childLink = (active: boolean) =>
  `flex items-center rounded-lg py-1.5 pl-7 transition-all duration-150 ${
    active
      ? "bg-(--accent-tint) font-medium text-(--color-primary)"
      : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
  }`;

export function Sidenav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoParam = searchParams.get("repo_id");
  const canonicalSearch = filtersToSearch(
    repoParam ? Number(repoParam) : null,
    parseFilters(searchParams),
  );
  const currentUrl = canonicalSearch ? `${pathname}?${canonicalSearch}` : pathname;

  const { data: views } = useQuery({
    queryKey: VIEWS_KEY,
    queryFn: fetchViews,
    retry: false,
    staleTime: 30_000,
  });
  const matrixViews = (views ?? []).filter((view) => view.view_kind === "matrix");

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
                  {href === "/views" && matrixViews.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {matrixViews.map((view) => {
                        const viewHref = savedViewHref(view);
                        return (
                          <li key={view.id}>
                            <Link
                              href={viewHref}
                              data-testid={`saved-view-link-${view.id}`}
                              className={childLink(currentUrl === viewHref)}
                            >
                              {view.name}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
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
