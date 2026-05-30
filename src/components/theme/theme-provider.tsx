'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import {
  type Theme,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isValidTheme,
} from '@/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * App-wide theme provider.
 *
 * Persists the chosen theme in localStorage and reflects it on the
 * `<html data-theme="...">` attribute so the CSS-variable tokens in
 * globals.css apply to the entire app on every route.
 *
 * The initial attribute is set server-side in layout.tsx (plus a small inline
 * script that reads localStorage before paint to avoid a flash), so this
 * provider only needs to keep React state in sync after hydration.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  // Sync from localStorage on mount (the pre-paint inline script already
  // applied the attribute; this aligns React state with it).
  useEffect(() => {
    const stored =
      typeof window !== 'undefined'
        ? localStorage.getItem(THEME_STORAGE_KEY)
        : null;
    if (stored && isValidTheme(stored)) {
      setThemeState(stored);
    }
  }, []);

  // Reflect theme changes onto the document and persist them. The pre-paint
  // inline script in layout.tsx already applied the correct attribute, so we
  // skip the first run — otherwise we'd briefly overwrite it with DEFAULT_THEME
  // before the localStorage sync above re-renders with the real value (flash).
  const skipFirstReflect = useRef(true);
  useEffect(() => {
    if (skipFirstReflect.current) {
      skipFirstReflect.current = false;
      return;
    }
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    if (typeof window !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Access the current app theme and a setter. Must be used within ThemeProvider.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
