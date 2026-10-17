# Front-end art direction

That of screenpipe.com (monochrome "bone", phosphor reserved to the action in progress), pushed toward even
more emptiness. The rules below apply to all of `apps/web`. They are coded in
`app/globals.css` (`@theme` tokens, `.panel`, `.btn`, `.input`, `.chip`, `.inset` classes) and in
`components/ui.tsx` (zone dots, icons, errors).

## Colors

| Role | Value | Use |
| --- | --- | --- |
| bone | `#f6f6f3` | page background |
| surface | `#ffffff` | panels, fields, tags |
| ink | `#0a0a0a` | text, lines, primary button |
| signal | `#333333` | primary button hover |
| trace | `#78786f` | secondary text |
| line / line-strong | `#e2e2dc` / `#c6c6bf` | 1 px lines, field borders |
| phosphor | `#c7ff3e` | **only** a zone an agent is touching live, the "live" indicator, the ripples |
| danger | `#b42318` | error text, next to the action |

- Text never carries color. A zone is identified by an 8 px dot (`<ZoneTag>`), always
  together with its name.
- Zone colors come from `ZONE_PALETTE` (`components/ui.tsx`), a fixed-order categorical palette
  checked for color blindness on a light background; the same list is in `packages/core/src/zones.ts` for the seed.
  Old neon colors still in the database are remapped by `zoneColor()`.
- No gradient, no shadow at rest, no blur, no glow.

## Typography

- Space Grotesk for everything, IBM Plex Mono only for a token or code (`.mono`).
- Sentence case everywhere, no letter-spaced capitals, no label above a title.
- Numbers in `tabular-nums`. Titles in `text-balance`, paragraphs in `text-pretty` (the CSS default).
- No emoji, no exclamation mark, no "A · B · C", no arrow stuck to a link.

## Shapes

- Radii: 8 px panels, 6 px controls and inner blocks, 4 px tags, 0 for the 3D canvas.
- A panel = white + 1 px line. Inside, a secondary block = `.inset` (one step of tone, no line).
- Primary button: ink background, white text. Only one per view. Secondary button: white, strong line.
- Icons: inline SVG from `ui.tsx`, 1.5 stroke, 16 px, `aria-hidden`. An icon button carries an `aria-label`.

## Motion

- Transform and opacity only, 200 ms at most, `ease-out` on entry, `prefers-reduced-motion` respected.
- The 3D brain rotates slowly on its own when left alone; it stops off screen and under
  `prefers-reduced-motion`.

## 3D brain (`components/Brain3D.tsx`)

- Beads = knowledge (ink), grouped by zone on a shell; zone center = colored bead ringed
  with ink; thin lines to the center; arcs between zones that share entities.
- Active zone: phosphor on its beads and its center, phosphor ripple, white bubble with the label.
- Labels = real HTML buttons projected onto the scene (keyboard and screen reader), drag to rotate,
  wheel, pinch or buttons to zoom. Without WebGL: `BrainViz` (2D, same monochrome).

## Layout (`components/AppShell.tsx`)

- Sidebar on the left (bone background, 1 px line): the brain, its pages (live agents, status, knowledge,
  tasks, automations), configuration for admins (team and access, onboarding), then "view as",
  my context and sign-out. Below 768 px, it opens with the menu button.
- A section with sub-pages (Team and access: org chart, access per zone, requests, zones; one address each under
  `/admin`) unfolds when you are in it, without a chevron: a 1 px thread aligned with the icon, the sub-pages in
  secondary text, and an ink bar that slides along the thread to the current page (200 ms). No tabs at the top
  of the page.
- On the right, the page. The window never scrolls: the brain fills all the space (the wheel zooms), the other
  pages scroll within their column.
- The live state (SSE stream, lit zones) lives in the layout (`components/BrainLive.tsx`): it survives navigation.

## Public home page (`/`)

Addresses: `/` the home page (for everyone), `/create` company creation, `/demo` the demo entrance
(choosing a Fournil account, demo mode only), `/login` token sign-in, `/dashboard` the brain and,
next to it, the other signed-in pages. The old French addresses (`/accueil`, `/creer`, …) redirect permanently.

Same world, at the scale of a page (`components/landing`, "Home page" block of `globals.css`).

- Large, tight Space Grotesk titles (`.landing-display`, `.landing-h2`), lots of emptiness, a text column on the left.
- The brain (`ScrollBrain`) reuses the geometry of `Brain3D` (`brain-geometry.ts`) and adds a shell of wavy contour
  rings and a bone fog for depth. No shadow, no glow.
- Motion: an exception to the 200 ms rule, reserved to this page (`components/landing/motion/setup.ts`).
  - The brain scene is pinned over 7 screens and follows the scroll (GSAP ScrollTrigger, Lenis smooth scrolling):
    the brain goes full screen and rotates, the knowledge settles, the zones get named, three agents
    light up their zone in phosphor.
  - Then each section fills one screen, content centered, and holds: it stays aligned with the screen
    for 0.6 screen of scroll (`data-hold` to make it longer: 1.4 for "The raw data stays on the computer"). Let go
    very close to a chapter or a section, the scroll snaps to it gently.
  - All section animations follow the scroll: they move forward when you scroll down, stop when you
    stop, replay backwards when you scroll up. Titles go from pale to ink word by word; the
    "Where Fournil stands" panel fills and the prompt types itself during the hold; the privacy diagram (`PrivacyFlow`)
    waits for its section to be snapped before playing.
  - An ink thread runs down along the sections, with a bead that fills at each section.
  - Only the entrance of the first screen plays on load (the title's words, then the rest), and the brain's slow
    idle rotation runs on its own.
  - Magnetic buttons (mouse only): they slide toward the pointer, come back with a slight bounce and
    sink in on click.
- After "The raw data stays on the computer", two offer sections (`components/landing/Offer.tsx`): "Your place, or
  ours" (self-hosted, open code, or our cloud) then pricing (`#pricing`, "Pricing" link in the header),
  with a monthly or yearly choice. Front end only: indicative prices, no payment wired; the cloud buttons lead
  to `/create` (or to the demo when creation is closed). Their cards (`data-reveal="cards"`) are in place before
  the section's hold, so you can compare as soon as you arrive. A single primary button: the Team plan.
- `prefers-reduced-motion`: no pinning, hold or smooth scrolling, brain still and assembled, chapters
  read one after the other, every section in its final state.
- Phosphor stays reserved to the zones an agent queries (here, the demo's three agents).

## Create your company (`/create`, `components/CreateCompany.tsx`)

- One question per screen, like a blank page: large title (`.create-title`), frameless field underlined
  by a line that thickens on focus (`.create-input`), "Continue" or Enter, a discreet "Back".
- A 1 px line under the header moves forward step by step. Entry of each screen: 8 px and opacity, 200 ms.
- On the right (≥ 1024 px), the brain builds itself in the dashboard's language: a center, one bead per chosen zone,
  the people around it, filled once their computer is connected. The colors are the ones the server will assign.
- After creation: the prompt for one's own computer (`PromptActions`, shared with the home page), the "live" indicator
  that lights up when the computer connects, then one prompt per invited colleague.
