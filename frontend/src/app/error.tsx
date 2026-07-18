"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[14px] border border-(--color-border) bg-(--color-surface) px-6 py-16 text-center shadow-(--shadow-card)">
      <div className="text-sm font-medium">Something went wrong</div>
      <div className="max-w-md text-(--color-text-muted)">
        {error.message || "An unexpected error occurred."}
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-(--color-primary) transition-all duration-150 hover:bg-(--accent-tint)"
      >
        Try again
      </button>
    </div>
  );
}
