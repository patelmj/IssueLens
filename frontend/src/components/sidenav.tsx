"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_ITEMS = [
  {
    group: "Workspace",
    items: [
      { label: "Overview", href: "/" },
      { label: "Triage", href: "/triage" },
      { label: "Plan", href: "/plan" },
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

export function Sidenav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 py-1">
      {NAV_ITEMS.map(({ group, items }) => (
        <div key={group}>
          <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
            {group}
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map(({ label, href }) => {
              const active = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center justify-between rounded-lg px-3 py-1.5 transition-all duration-150 ${
                      active
                        ? "bg-(--accent-tint) font-medium text-(--color-primary)"
                        : "text-(--color-text-muted) hover:bg-(--accent-tint) hover:text-(--color-text)"
                    }`}
                  >
                    <span>{label}</span>
                    <span className="rounded-full border border-(--color-border) px-1.5 text-[10px] text-(--color-text-muted)">
                      –
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
