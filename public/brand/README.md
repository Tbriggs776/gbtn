# Growth by the Numbers — Brand Assets (TMB Inc skin)

The original Growth by the Numbers trendline mark, re-skinned in the Tyler M Briggs Inc
visual system. Drop these into the website.

## Palette
| Token    | Hex      | Use                                   |
|----------|----------|---------------------------------------|
| Navy     | #11294A  | Primary dark / backgrounds / mark bg  |
| Navy 2   | #16335B  | Headings on light                     |
| Crimson  | #9E2335  | Accent — rules, emphasis (sparingly)  |
| Rose     | #C98A92  | Muted accent on dark                  |
| Cream    | #F6F2EA  | Paper / light surface / mark on dark  |
| Cream 2  | #FBF8F2  | Alt surface                           |
| Stone    | #C0B7A6  | Taupe — dividers, captions            |
| Ink      | #1B1D24  | Body text                             |

## Type (Google Fonts)
- **Oswald** — display, labels, the wordmark. Uppercase, letter-spaced. Weights 300–700.
- **Spectral** — body & editorial (incl. italic). Weights 400–600.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&family=Spectral:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap" rel="stylesheet">
```

## File map
```
logo/
  mark-cream-navy.(svg|png 512/1024)     primary — cream tile, navy arrow
  mark-navy-cream.(svg|png 512/1024)     reversed — navy tile, cream arrow
  mark-cream-crimson.(svg|png 512/1024)  accent — cream tile, crimson arrow
  mark-navy-line / cream-line / crimson-line  line-only knockouts (transparent)
favicon/
  favicon.svg, favicon-16/32/48.png
  apple-touch-icon-180.png, icon-192.png, icon-512.png, maskable-512.png
avatar/
  avatar-navy-400/800/1024.png           navy tile, cream arrow (primary)
  avatar-cream-400/800.png               cream tile, navy arrow
lockup/
  lockup-horizontal-light/dark.png, lockup-horizontal-on-navy.png
  lockup-stacked-light/dark.png
  wordmark-navy.png, wordmark-cream.png
social/
  linkedin-banner-1584x396.png           LinkedIn / YouTube cover
  og-card-1200x630.png                   Open Graph / share card
```
SVGs are the scalable masters; PNGs are exported at the sizes noted. Line-only marks
and all lockups are transparent.

## Favicon / head snippet
```html
<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/favicon/apple-touch-icon-180.png">
<meta property="og:image" content="/social/og-card-1200x630.png">
```

## Notes
- The mark geometry is identical to the original GBTN trendline — only color & type changed.
- Navy is primary; reserve crimson for accents (one per view).
- The wordmark is always set in Oswald, uppercase, letter-spaced (~0.12–0.14em).
- Keyline: the thin inset border on the tiles is part of the mark at large sizes; it's
  dropped automatically on the small favicons for legibility.
