# 02-icons — Momentum icon library

The complete icon set for ONE by ai8ht, in the approved **Momentum** style. It contains **58 module icons**: the 16 approved icons from `unified/icons-animated/`, copied with their names unchanged, plus 42 new ones. It also has **39 utility icons**.

Open `index.html` to browse the set. Icons are grouped by portal and then by utility, and each portal has a 20px rail preview. The page has a light/dark/system toggle and a "Loop all" switch. Hover a tile to play its micro-animation.

## What's inside
| Path | Contents |
|---|---|
| `svg/<name>.svg` | 97 static icons. 24×24 viewBox, `fill="currentColor"`, second tone as `opacity=".42"` |
| `animated/<name>.svg` | 63 self-animating previews: all 58 module icons, plus the `bell`, `refresh`, `check`, `sun` and `moon` utilities. 2.8s loop, about 700ms of action, `cubic-bezier(.3,.7,.3,1)`, honours `prefers-reduced-motion`. The 16 approved files are byte-identical copies. |
| `sprite.svg` | `<symbol id="i-<name>">` for all 97 static icons, plus the `mgrad` gradient |
| `icon-map.json` | portal → nav label → icon name (8 portals / 10 roles), plus shared and utility maps |
| `manifest.json` | `{id, file, type, variants, roles, usage, source, motion}` for every icon |
| `index.html` | the gallery |
| `icons-light.png` / `icons-dark.png` | full gallery renders |
| `icons-zoom-modules-*.png` / `icons-zoom-utility-*.png` | 96px renders on the 24px grid, used for construction QA |

## Construction rules (shared by every icon)
- **24px grid**, live area 2–22px. Glyphs are solid, built from rounded polygons. Outer corner radius is 1.6–1.8 on large shapes, 1.1–1.4 on medium shapes and 0.4–0.9 on small details.
- **Diagonal cut**: containers (board, card, envelope, folder, doc, chip, calendar) have a chamfered top-right corner.
- **12° slant**: tiles, bars, steps, list rows and ground lines lean forward, using the same `T()` primitive as the approved set.
- **Two tones**: the primary shape is 100% and the second tone is **42%**. Details are cut out as holes (evenodd) with gaps of at least 1.2px, so they stay legible at 20px.
- **Active state**: fill is `url(#mgrad)` (indigo #2B1BB8 → #1E6BFF → cyan #18C8E8, diagonal) and the second tone rises to 55%.
- **Utility icons** use a 2.8-unit stroke-equivalent weight, matching the approved plus, check and chevron. They have fewer and larger holes and are tuned for 16–20px.
- Geometry comes from the same generator (`P`/`C`/`T` primitives) that produced the approved 16, so radii and weights match exactly.

## Usage
```html
<!-- inline file -->
<img src="svg/students.svg" width="20" height="20" alt="">
<!-- sprite (colour = currentColor) -->
<svg width="20" height="20" aria-hidden="true"><use href="sprite.svg#i-students"/></svg>
<!-- active nav item: gradient fill -->
<svg width="20" height="20"><use href="sprite.svg#i-students" fill="url(#mgrad)"/></svg>
```
- Sizes: 20px in the icon rail and mobile tabs, 24px in card headers and empty states, 16–20px for utility icons inline with text.
- Micro-animation: play it **once** on hover or tap (see `index.html` CSS: `.hov:hover .ai-<name> .p-*`). Loop only in demos. When reduced motion is on, show the static icon.
- React/Tailwind/Lucide: swap Lucide imports for an `<Icon name>` wrapper over the sprite. Size with `w-5 h-5` and colour with `text-*`.
- "Detail" pages reuse their parent's icon. Dashboard, Home and Overview all use `home`, as on the approved college-admin page.

## Naming notes
- `help` is the approved Help & FAQ module glyph. The utility "help" control is `help-small` (circle with ?), to sit alongside `settings-small` and `calendar-small`.
- `info` is a chamfered square, so it can't be confused with `help`.
- `evidence` (approved) is used for verified-evidence chips and records rather than a nav item.
- Approved unified pages used interim glyphs for **Staff** (`experience`) and **Placement** (`career`). They now have dedicated icons, `staff` and `placement`. Use those going forward.

## Do / don't
**Do:** colour with `currentColor` · use the gradient on one active item only · keep the 42% second tone · reuse parent icons for detail pages.
**Don't:** mix with Lucide outlines in one rail · recolour or flatten the second tone · add strokes or outlines · loop animations in product UI · use icons to imply a readiness score.
