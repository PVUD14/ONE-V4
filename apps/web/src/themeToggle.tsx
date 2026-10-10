/**
 * The top-bar button that switches between the light and dark Momentum themes.
 *
 * It shows the theme you would switch to, so its label always says what pressing it does.
 * Until it is pressed the app follows the OS, and the button keeps up if the OS changes.
 */
import React, { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { chooseTheme, currentTheme, subscribeTheme, type ThemeChoice } from './themePreference.js';

export function ThemeToggle({ className = 'icon-button' }: { readonly className?: string }): React.ReactElement {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light' as const);
  const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Switch to dark theme' : 'Switch to light theme';
  return (
    <button className={`${className} theme-toggle`} type="button" aria-label={label} title={label}
      onClick={() => chooseTheme(next)}>
      {next === 'dark' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
    </button>
  );
}
