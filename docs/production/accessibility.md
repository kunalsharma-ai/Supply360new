# Accessibility report (Phase 8)

Target: WCAG 2.2 AA.

## Automated

The browser checks (`apps/web/e2e/smoke.mjs`, run in CI on a fresh stack) run axe-core with the `wcag2a`, `wcag2aa`
and `wcag22aa` rule sets on 36 page states: sign-in, users, command centre, audit, settings, security, projects,
audience finder, audience filter, allocation, quota management, segments, MADP integration, project detail, workflow
automation, invitation engine, survey router, reminder engine, scheduling engine, participation tracker,
reconciliation, live fieldwork, IR, LOI and quality intelligence, rewards, recontact, reinvite, SampTrek integration,
webhook log, redirects, SampIntel integration, delivery intelligence, audience intelligence, Copilot and reports.
A serious or critical violation fails the run. Result on 2026-11-26: 0 serious or critical issues on all 36 states.

## Keyboard

- The command palette opens with Ctrl/⌘+K and navigates with arrows and Enter (checked in the browser run).
- Dialogs, menus and drawers come from Radix primitives: focus is trapped while open and returns on close.
- Every icon-only button has an accessible name (axe `button-name`).

## Visual

- axe's `color-contrast` rule passes on every checked state. Where text sits on a blurred glass panel axe cannot
  always compute the background and reports it for manual review rather than as a pass, so a manual
  contrast check is on the list below.
- Motion respects `prefers-reduced-motion` (`globals.css`).

## Not yet done

- A manual screen reader pass (NVDA on Windows, VoiceOver on macOS) on the sign-in, invitations and live fieldwork
  flows.
- A manual contrast check of text on glass panels.
- 200% zoom and 320 px reflow review on data-dense tables.
