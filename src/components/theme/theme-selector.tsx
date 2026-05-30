'use client';

import { themes, cycleTheme } from '@/lib/theme';
import { useTheme } from './theme-provider';

/**
 * Compact theme-cycle button.
 *
 * Displays the current theme icon + name (e.g. "Daylight") and cycles
 * to the next theme on click: daylight -> midnight -> tome -> daylight.
 *
 * Reads/writes the app-wide theme via ThemeProvider context, so it can be
 * dropped anywhere (navbar, session header, etc.) without wiring props.
 */
export function ThemeSelector() {
  const { theme: currentTheme, setTheme } = useTheme();
  const theme = themes[currentTheme];
  const ThemeIcon = theme.icon;

  const handleClick = () => {
    setTheme(cycleTheme(currentTheme));
  };

  return (
    <button
      onClick={handleClick}
      title={`Current: ${theme.name} — Click to switch theme`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        fontWeight: 600,
        padding: '5px 10px',
        borderRadius: '4px',
        border: '1px solid var(--sp-border-strong)',
        backgroundColor: 'var(--sp-bg-surface)',
        color: 'var(--sp-fg-2)',
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      <ThemeIcon size={14} />
      {theme.name}
    </button>
  );
}
