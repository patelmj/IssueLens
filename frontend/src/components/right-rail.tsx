"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const SLOT_ID = "right-rail-slot";

const RailContext = createContext<{
  active: boolean;
  setActive: (value: boolean) => void;
} | null>(null);

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  return (
    <RailContext.Provider value={{ active, setActive }}>
      {children}
    </RailContext.Provider>
  );
}

/** Rendered by the app shell. Shows `fallback` until a page mounts a <RightRail>. */
export function RightRailSlot({ fallback }: { fallback: ReactNode }) {
  const rail = useContext(RailContext);
  return (
    <>
      <div id={SLOT_ID} className="overflow-x-clip" />
      {rail?.active ? null : fallback}
    </>
  );
}

/** Rendered by a page; portals its children into the shell's right rail. */
export function RightRail({ children }: { children: ReactNode }) {
  const rail = useContext(RailContext);
  const setActive = rail?.setActive;
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget(document.getElementById(SLOT_ID));
    setActive?.(true);
    return () => setActive?.(false);
  }, [setActive]);
  return target ? createPortal(children, target) : null;
}
