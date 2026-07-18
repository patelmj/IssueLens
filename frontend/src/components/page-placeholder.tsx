export function PagePlaceholder({
  title,
  hint,
  emptyTitle,
  emptyBody,
}: {
  title: string;
  hint: string;
  emptyTitle: string;
  emptyBody: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        <span className="text-(--color-text-muted)">{hint}</span>
      </div>
      <div className="flex flex-col items-center gap-1.5 rounded-[14px] border border-(--color-border) bg-(--color-surface) px-6 py-16 text-center shadow-(--shadow-card)">
        <div className="text-sm font-medium">{emptyTitle}</div>
        <div className="max-w-md text-(--color-text-muted)">{emptyBody}</div>
      </div>
    </div>
  );
}
