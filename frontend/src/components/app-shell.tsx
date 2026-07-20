import { Header } from "./header";
import { RightRailSlot } from "./right-rail";
import { Sidenav } from "./sidenav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="grid grow grid-cols-[216px_minmax(0,1fr)_330px] gap-5 p-5">
        <Sidenav />
        <main className="min-w-0">{children}</main>
        <aside>
          <RightRailSlot
            fallback={
              <div className="rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 text-(--color-text-muted) shadow-(--shadow-card)">
                <div className="pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
                  Context
                </div>
                Details about your selection will appear here once data is
                connected.
              </div>
            }
          />
        </aside>
      </div>
    </div>
  );
}
