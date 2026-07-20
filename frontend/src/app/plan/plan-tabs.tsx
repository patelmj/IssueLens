"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Table", href: "/plan" },
  { label: "Matrix", href: "/plan/matrix" },
];

export function PlanTabs() {
  const pathname = usePathname();
  return (
    <div
      className="flex items-center gap-0.5 rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
      data-testid="plan-tabs"
    >
      {TABS.map(({ label, href }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className={`rounded-[7px] px-2.5 py-1 transition-all duration-150 ${
            pathname === href
              ? "bg-(--accent-tint) font-medium text-(--color-primary)"
              : "text-(--color-text-muted) hover:text-(--color-text)"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
