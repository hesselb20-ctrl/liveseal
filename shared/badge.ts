// The badge: what the user actually sees. State is carried by shape, text and
// colour together, and announced to screen readers through a live region.

import type { Badge } from '../core/src/verify.ts';

const ICONS: Record<Badge['level'], string> = {
  // check in a circle, question mark in a triangle, cross in an octagon: three different outlines
  green: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  amber: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2 22.6 21H1.4z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9v5.5" stroke="#1b1300" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.3" fill="#1b1300"/></svg>',
  red: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 1.5h8.2l5.9 5.9v8.2l-5.9 5.9H7.9L2 15.6V7.4z" fill="currentColor"/><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
};

const WORD: Record<Badge['level'], string> = { green: 'Verified', amber: 'Not verified', red: 'Warning' };

export interface BadgeView {
  element: HTMLElement;
  update(badge: Badge): void;
}

/**
 * Creates a badge element. `compact` shows icon and title only (for small
 * video tiles); the detail sentence is still read out and shown on focus.
 */
export function createBadge(compact = false): BadgeView {
  const element = document.createElement('div');
  element.className = 'ls-badge' + (compact ? ' ls-badge-compact' : '');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.tabIndex = 0;
  const icon = document.createElement('span');
  icon.className = 'ls-badge-icon';
  const text = document.createElement('span');
  text.className = 'ls-badge-text';
  const title = document.createElement('strong');
  const detail = document.createElement('span');
  detail.className = 'ls-badge-detail';
  text.append(title, detail);
  element.append(icon, text);
  let last = '';
  return {
    element,
    update(badge) {
      const key = `${badge.level}|${badge.code}|${badge.title}|${badge.detail}|${badge.strong}`;
      if (key === last) return;
      last = key;
      element.dataset.level = badge.level;
      element.dataset.strong = String(badge.strong);
      // interrupt the screen reader only for warnings
      element.setAttribute('aria-live', badge.level === 'red' || badge.strong ? 'assertive' : 'polite');
      icon.innerHTML = ICONS[badge.level];
      title.textContent = badge.title;
      detail.textContent = badge.detail;
      element.title = `${WORD[badge.level]}. ${badge.detail}`;
    },
  };
}

/** Styles for the badge, for pages that do not load shared/ui.css (the extension injects this). */
export const BADGE_CSS = `
.ls-badge{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:14px;font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:rgba(22,24,28,.86);color:#fff;border:2px solid transparent;max-width:420px;box-sizing:border-box;backdrop-filter:blur(10px)}
.ls-badge-icon{flex:none;width:22px;height:22px;display:block}
.ls-badge-icon svg{width:22px;height:22px;display:block}
.ls-badge-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-badge strong{font-weight:650;letter-spacing:.01em}
.ls-badge-detail{font-weight:400;opacity:.92}
.ls-badge[data-level=green]{border-color:#00c08b}.ls-badge[data-level=green] .ls-badge-icon{color:#00a878}
.ls-badge[data-level=amber]{border-color:#f0b323}.ls-badge[data-level=amber] .ls-badge-icon{color:#f0b323}
.ls-badge[data-level=red]{border-color:#ff6a2b;background:rgba(74,18,0,.94)}.ls-badge[data-level=red] .ls-badge-icon{color:#e8551a}
.ls-badge[data-strong=true]{border-width:3px;box-shadow:0 0 0 3px rgba(255,255,255,.18)}
.ls-badge-compact{padding:6px 10px;border-radius:999px;align-items:center}
.ls-badge-compact .ls-badge-detail{display:none}
.ls-badge-compact:focus .ls-badge-detail,.ls-badge-compact:hover .ls-badge-detail,.ls-badge-compact[data-level=red] .ls-badge-detail,.ls-badge-compact[data-strong=true] .ls-badge-detail{display:block}
.ls-badge-compact[data-level=red],.ls-badge-compact[data-strong=true]{border-radius:14px;align-items:flex-start}
.ls-badge:focus-visible{outline:3px solid #7ab8ff;outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.ls-badge{transition:background-color .25s ease,border-color .25s ease}}
`;
