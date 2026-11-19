import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem('lumina.theme');
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}

/** The grade is chosen once on load (saved choice, else the system) or by the toggle. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    meta.forEach((m) => m.setAttribute('content', theme === 'dark' ? '#10181c' : '#f7f9fa'));
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('lumina.theme', next);
      } catch {
        /* private mode: the choice lasts for this visit */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

/** Read a CSS custom property, for canvases (charts) that cannot use var(). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
