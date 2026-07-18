import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="flex items-center gap-3 border-b border-(--color-border) px-5 py-2.5">
      <div className="flex items-center gap-1.5 font-semibold">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-(--color-primary)" />
        IssueLens
      </div>
      <span className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-(--color-text-muted)">
        No repository connected
      </span>
      <div className="grow" />
      <button
        type="button"
        disabled
        title="Command palette — coming soon"
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text-muted)"
      >
        ⌘K
      </button>
      <ThemeToggle />
    </header>
  );
}
