import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export const FONT_SIZES = [13, 14, 16, 18] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export type Appearance = {
  theme: ThemeMode;
  font: FontSize;
};

export const STORAGE_KEY = 'clash-manager.appearance.v1';
export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', font: 14 };

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const preview = new URLSearchParams(window.location.search);
const previewing = preview.has('preview-theme');
const listeners = new Set<() => void>();

function isTheme(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isFont(value: unknown): value is FontSize {
  return FONT_SIZES.includes(value as FontSize);
}

function read(): Appearance {
  const previewTheme = preview.get('preview-theme');
  const previewFont = Number(preview.get('preview-font'));
  if (previewTheme === 'light' || previewTheme === 'dark')
    return {
      theme: previewTheme,
      font: isFont(previewFont) ? previewFont : DEFAULT_APPEARANCE.font,
    };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Appearance>;
    return {
      theme: isTheme(stored.theme) ? stored.theme : DEFAULT_APPEARANCE.theme,
      font: isFont(stored.font) ? stored.font : DEFAULT_APPEARANCE.font,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let current = read();

function resolvedTheme(theme: ThemeMode) {
  if (theme === 'system') return darkQuery.matches ? 'dark' : 'light';
  return theme;
}

function apply() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(current.theme);
  root.dataset.font = String(current.font);
}

function notify() {
  for (const listener of listeners) listener();
}

function update(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  apply();
  if (!previewing) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* 偏好保存失败时保留本次会话内的外观。 */
    }
  }
  notify();
}

export function initializeAppearance() {
  apply();
  darkQuery.addEventListener('change', () => {
    if (current.theme !== 'system') return;
    apply();
    notify();
  });
}

export function getAppearance() {
  return current;
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

export function setTheme(theme: ThemeMode) {
  update({ theme });
}

export function setFont(font: FontSize) {
  update({ font });
}
