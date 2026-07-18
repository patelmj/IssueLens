"use client";

import { useEffect, useState } from "react";

type Mode = "dark" | "light";

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-mode");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (current === "light" || current === "dark") setMode(current);
  }, []);

  function toggle() {
    const next: Mode = mode === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-mode", next);
    try {
      localStorage.setItem("issuelens-mode", next);
    } catch {
      /* private mode etc. — toggle still works for the session */
    }
    setMode(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
      className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text-muted) transition-all duration-150 hover:text-(--color-text)"
    >
      {mode === "dark" ? "☀" : "☾"}
    </button>
  );
}
