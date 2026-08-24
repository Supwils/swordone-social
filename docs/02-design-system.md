---
title: Design System — 纸本日志 × 侘寂
status: stable
last-updated: 2026-04-21
owner: round-5
---

# Design System

> **Implemented in Round 5.** Tokens live in `client/src/styles/tokens.css`.
> Primitives live in `client/src/components/primitives/`. Layout in
> `client/src/components/layout/`. Never hardcode hex/px/rem in components —
> pull from tokens. Grep for `#[0-9a-f]{3,8}` in `client/src/**` outside
> `tokens.css` must return zero hits.

_Paper journal meets wabi-sabi_ — warmth, restraint, imperfection accepted. Every token below exists in CSS variables; do not hardcode values in components.

## Principles

1. **Silence over noise.** Default state of every surface is quiet. Color, motion, and weight are earned, not sprinkled.
2. **Reading first.** Posts and conversations are prose. Typography, line-length, and rhythm dominate; chrome recedes.
3. **One accent.** Tea-brown. Used for active states and the rare call-to-action. Not for decoration.
4. **Hairlines over shadows.** Layers are separated by 1px muted borders, not drop shadows. Depth is implied, not announced.
5. **Slow, short motion.** Transitions 120–200ms, ease-out. No bounce, no spring. No loading spinners if a skeleton will do.

## Color tokens

All colors are defined as CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark). No hex in components.

### Light (default)

```css
:root {
  /* Surfaces */
  --color-bg:              #FAF7F2;   /* page canvas, warm off-white */
  --color-surface:         #FFFFFF;   /* cards, dialogs */
  --color-surface-muted:   #F4EFE7;   /* inset blocks, input bg */

  /* Text */
  --color-text:            #2B2723;   /* ink */
  --color-text-muted:      #7A7268;   /* meta, captions */
  --color-text-subtle:     #A89F92;   /* timestamps, hints */
  --color-text-inverse:    #FAF7F2;

  /* Lines */
  --color-border:          #E8E0D4;   /* hairline */
  --color-border-strong:   #D4C9B6;

  /* Accent (used sparingly) */
  --color-accent:          #8B6F47;   /* tea brown */
  --color-accent-hover:    #75593A;
  --color-accent-soft:     #E8DDC9;   /* tint for selection bg */

  /* Semantic (all low-saturation) */
  --color-success:         #6B8E4E;
  --color-warning:         #B8860B;
  --color-danger:          #A0453A;
  --color-info:            #557B8C;

  /* Feedback tints (backgrounds for alerts) */
  --color-success-soft:    #E6EEDF;
  --color-warning-soft:    #F3EBD3;
  --color-danger-soft:     #F0D8D4;
  --color-info-soft:       #DDE5EA;

  /* Focus ring */
  --color-focus:           #8B6F47;
}
```

### Dark

```css
[data-theme="dark"] {
  --color-bg:              #1A1917;
  --color-surface:         #232220;
  --color-surface-muted:   #2C2A27;

  --color-text:            #EDE7DB;
  --color-text-muted:      #A8A094;
  --color-text-subtle:     #786F62;
  --color-text-inverse:    #1A1917;

  --color-border:          #35322D;
  --color-border-strong:   #4A453E;

  --color-accent:          #C9A96E;
  --color-accent-hover:    #D9BC84;
  --color-accent-soft:     #3A3226;

  --color-success:         #8AAE6C;
  --color-warning:         #D4A93A;
  --color-danger:          #C56A5E;
  --color-info:            #7CA3B5;

  --color-success-soft:    #2A3424;
  --color-warning-soft:    #3A3220;
  --color-danger-soft:     #3A2624;
  --color-info-soft:       #243238;

  --color-focus:           #C9A96E;
}
```

## Typography

Two font families plus a mono for code. Loaded from Google Fonts (or self-hosted in prod).

```css
:root {
  --font-serif: "Cormorant Garamond", "Noto Serif SC", Georgia, serif;
  --font-sans:  "Inter", "Noto Sans SC", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono:  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
```

### Type scale

Modular scale, base 16px, ratio 1.25 (major third). Use semantic names in components, not raw sizes.

| Token | Size | Line-height | Family | Use |
|---|---|---|---|---|
| `--text-display` | 2.441rem (39px) | 1.15 | serif, 500 | Hero/landing headlines only |
| `--text-h1` | 1.953rem (31px) | 1.2 | serif, 500 | Page title |
| `--text-h2` | 1.563rem (25px) | 1.3 | serif, 500 | Section heading |
| `--text-h3` | 1.25rem (20px) | 1.35 | sans, 600 | Subsection |
| `--text-body` | 1rem (16px) | 1.6 | sans, 400 | Default prose, posts |
| `--text-small` | 0.875rem (14px) | 1.5 | sans, 400 | Meta, descriptions |
| `--text-caption` | 0.75rem (12px) | 1.4 | sans, 500 | Labels, timestamps |

Feed post body uses serif (`--font-serif`) at 17px to deliberately slow reading — it should feel like a journal, not a tweet.

## Spacing scale

Base 4px. Use tokens only.

```css
:root {
  --space-0: 0;
  --space-1: 0.25rem;   /*  4px */
  --space-2: 0.5rem;    /*  8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.5rem;    /* 24px */
  --space-6: 2rem;      /* 32px */
  --space-7: 3rem;      /* 48px */
  --space-8: 4rem;      /* 64px */
  --space-9: 6rem;      /* 96px */
}
```

## Radii

Subtle, consistent. No fully-rounded pills except for avatar masks.

```css
:root {
  --radius-sm: 4px;
  --radius-md: 6px;   /* default for cards, buttons, inputs */
  --radius-lg: 10px;  /* dialogs, large surfaces */
  --radius-full: 9999px;
}
```

## Borders

1px hairlines everywhere. Use `--color-border` for dividers, `--color-border-strong` when contrast matters.

## Shadows

Almost never. Reserved for floating elements (cmdk, popover, dialog).

```css
:root {
  --shadow-sm: 0 1px 2px rgba(30, 26, 22, 0.04);
  --shadow-md: 0 4px 12px rgba(30, 26, 22, 0.06), 0 1px 3px rgba(30, 26, 22, 0.04);
  --shadow-lg: 0 12px 32px rgba(30, 26, 22, 0.10), 0 2px 6px rgba(30, 26, 22, 0.04);
}
```

## Motion

```css
:root {
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur-fast:   120ms;
  --dur-base:   180ms;
  --dur-slow:   280ms;
}
```

Rules:
- Color and opacity transitions: `--dur-fast`.
- Layout shifts (dialog open, sheet slide): `--dur-base` to `--dur-slow`.
- No bounce, no overshoot, no parallax.
- Respect `prefers-reduced-motion: reduce` — strip transitions, keep only opacity fades.

## Focus state

Visible, not ugly. 2px outline offset, accent color.

```css
*:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

## Layout

- **Feed column**: `max-width: 680px`, centered, horizontal padding `--space-5`.
- **Feed layouts** (`FeedLayout`, persisted in `swil.ui`): `list` is the 680px
  reading column, virtualized; `grid` (folio) puts two compact cards in view;
  `immersive` scatters the page into a wall of tilted cards read one at a time
  in an overlay. All three share `FeedStream`, so a route opts in by rendering
  it — never by branching on the layout itself.
- **App shell**: left sidebar 240px (collapsible to 64px icon rail), main, optional right rail 280px for contextual panels.
- **Mobile breakpoint**: 720px. Below, sidebar becomes a bottom tab bar (3–4 items max).

## Component primitives (inventory)

To be implemented in `client/src/components/primitives/`. Each has light/dark variants via tokens, no hardcoded values.

- `Button` — variants: `primary` (accent), `ghost` (text+hover), `subtle` (border only), `danger`. Sizes: `sm`, `md`.
- `Input`, `Textarea` — 1px border, on-focus accent border, no box-shadow.
- `Card` — surface bg, 1px border, `--radius-md`, optional hover lift (`--shadow-sm`).
- `Avatar` — 32/40/64px, full-round. Fallback = initial on `--color-surface-muted`.
- `Dialog`, `Sheet`, `Popover` — backdrop `rgba(0,0,0,0.35)`, dialog `--shadow-lg`.
- `Toast` — bottom-right stack, 1px border, semantic tint bg, auto-dismiss 4s.
- `Skeleton` — `--color-surface-muted` with shimmer via linear-gradient animation.
- `Tag` — inline pill, `--color-surface-muted` bg, `--text-caption`.
- `EmptyState` — centered, serif heading, 1 sentence, optional CTA. Never show raw "No data."

## Iconography

[Phosphor Icons](https://phosphoricons.com/) at `regular` weight, 18/20/24px. Consistent, thin, feels handmade enough to fit the aesthetic.

## Imagery

- Post images: stored on S3 (no on-the-fly transforms); slight `saturate(0.92)` filter on display to tame stock-photo vibrance. Intrinsic `width`/`height` are stored and used to reserve layout (no CLS).
- Seed data: use Unsplash Source URLs (`https://source.unsplash.com/...`) for predictable placeholder variety.

## Accessibility baseline

- Color contrast: every text/bg pair hits WCAG AA (4.5:1). Verified for both themes. Tea-brown accent on off-white hits 4.8:1.
- All interactive elements focusable, with visible focus ring.
- Icons that are the only label get `aria-label`.
- Forms: every input has a `<label>`. Errors announced via `aria-live`.
- Respects `prefers-color-scheme` initially; user override persists to `localStorage`.

## What NOT to do

- ❌ Gradients on backgrounds or buttons.
- ❌ Box shadows on cards by default.
- ❌ Emoji in UI chrome (fine in user content).
- ❌ Multiple accent colors.
- ❌ Rounded-xl (pill-ish) corners on non-avatar elements.
- ❌ Colored icons. Icons inherit `currentColor`.
- ❌ Animated gradients, parallax, auto-playing video backgrounds.
- ❌ Red-badge unread counts on tabs. Use a small dot instead.
