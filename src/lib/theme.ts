// App-wide theme system.
// 3 themes matching the StoryScribe design system:
// - Daylight: clean light (default production look)
// - Midnight: dark UI
// - Tome: parchment/ancient book feel
//
// CSS variables for each theme live under the `[data-theme="..."]` selectors
// in globals.css. The `data-theme` attribute is set on <html> so the theme
// applies to the entire app (navbar, page chrome, and all routes).
import { Sun, Moon, BookOpen } from 'lucide-react';

export type Theme = 'daylight' | 'midnight' | 'tome';

export interface ThemeConfig {
  name: string;
  icon: typeof Sun;
  description: string;
}

export const themes: Record<Theme, ThemeConfig> = {
  daylight: {
    name: 'Daylight',
    icon: Sun,
    description: 'Clean light theme — the default production look',
  },
  midnight: {
    name: 'Midnight',
    icon: Moon,
    description: 'Dark UI with warm manuscript glow',
  },
  tome: {
    name: 'Ancient Tome',
    icon: BookOpen,
    description: 'Parchment canvas, burnt-sienna primary, gold accents',
  },
};

export const themeOrder: Theme[] = ['daylight', 'midnight', 'tome'];

export const DEFAULT_THEME: Theme = 'daylight';

// localStorage key. Kept as 'session-theme' for backwards compatibility with
// users who already picked a theme on the session page before it went app-wide.
export const THEME_STORAGE_KEY = 'session-theme';

export function getTheme(theme: Theme): ThemeConfig {
  return themes[theme];
}

export function cycleTheme(currentTheme: Theme): Theme {
  const currentIndex = themeOrder.indexOf(currentTheme);
  return themeOrder[(currentIndex + 1) % themeOrder.length];
}

export function isValidTheme(value: string): value is Theme {
  return themeOrder.includes(value as Theme);
}
