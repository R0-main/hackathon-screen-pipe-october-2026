---
version: 1
slug: "apps-web-app-page-tsx"
primary_target: "apps/web/app/page.tsx"
related_targets: ["apps/web/components/landing"]
---

# Public front page

Scope: `/` for a signed-out visitor (the dashboard stays on `/` once signed in). Mode: Persuade.

- Audience: leaders of SMBs and startups, the Screenpipe hackathon jury.
- Action: "Open the demo" (to `/login`, one-click sign-in in demo mode; "Sign in" otherwise).
- Proof: Butine's brain (fictional company making connected scales for beehives, 34 knowledge items, 6 zones), the real install prompt, the demo's real automation suggestion. No made-up customers or numbers.
- Constraints: DESIGN.md (bone, ink, phosphor only when an agent touches a zone, beads and lines, Space Grotesk). Concept set by the brief: the brain, which goes full screen and rotates as soon as you scroll, then the page moves on.

## Direction contract

THESIS: The page is the brain; scrolling is reading it. It refuses the SaaS template (title, screenshot, three feature cards, logos).

OWN-WORLD: Bone background, ink text, 1 px lines, ink beads linked by threads, zone dots from ZONE_PALETTE, phosphor only when an agent queries a zone. Large tight Space Grotesk titles, mono only for the install prompt.

STORY: The visitor sees a living brain. On scroll, it takes the whole screen and rotates: knowledge arrives from the computers and settles on it, the zones appear, agents come to it for context and the zones light up. Then the brain steps back: what the CEO sees, the install in one message, privacy, hosting and pricing, and you open the demo.

FIRST VIEWPORT: Full-frame canvas. Brain on the right, about 70% of the height. Thin bar at the top: name on the left, "Pricing", "Sign in" and the primary button on the right. Title at the bottom left on three lines, from 44 to 104 px, a one-sentence subtitle, the primary button and a "See how it works" link.

FORM: Pinned scene in three chapters driven by the scroll (form set by the brief, 1st on the list). Signature interaction: the brain moves forward until it fills the screen while making a half turn, the scattered beads converge on the shell, then the zones light up one by one. seed: none (direction set by the brief, no draw)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
