# Design System Baseline

V1 is a responsive English-language web product. The four portals share design primitives but may have different navigation and density.

## Principles

- mobile-browser usability is a first-class requirement;
- WCAG-aligned accessible semantics, keyboard navigation, focus states, labels, and contrast;
- consistent spacing, typography, form, table, status, empty/loading/error, confirmation, and notification patterns;
- no color-only status communication;
- destructive/high-risk administrative actions require explicit confirmation and clear consequence text;
- private/sensitive information must be visually distinguishable from organization-visible information where user understanding matters.

## Architecture

Use shared design tokens and reusable accessible components. Product-domain screens remain owned by their portal/domain feature packages. Do not create a universal mega-component library before repeated patterns exist.

## Internationalization

Even though V1 is English-only, user-facing strings should be externalizable/localizable; date/time/number formatting must use locale-aware utilities. Do not hard-code assumptions that prevent later Indian-language support.

## Core UX states

Every data-bearing view must define loading, empty, success, partial/degraded, permission-denied, validation, recoverable error, and terminal error states. AI unavailability is represented as a degraded capability, not a broken core portal.

## Security/privacy UX

Students must understand when data is self-declared, institution-verified, employer-reported, or platform-assessed. AI-proposed consequential actions require confirmation. Material employer opportunity-term changes must be clearly surfaced to affected applicants.