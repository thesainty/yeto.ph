import { useEffect, useLayoutEffect, useState } from "react";

type Theme = "light" | "dark";
const THEME_KEY = "tara-theme-v1";

/** A device preference, independent of account and demo storage. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#151922" : "#fffaf2");
  }, [theme]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== null) return;
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      setTheme(event.newValue === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* The current tab still switches when storage is unavailable. */ }
  }

  return { theme, toggleTheme };
}
