// Builds the MCP App (mcp-apps/) into one self-contained HTML file: the views and the dashboard components they reuse
// (esbuild), the dashboard's styles (Tailwind). The host shows it in a sandboxed iframe that loads nothing from the
// brain, so everything is inlined; only the two Google fonts come from outside (declared in the resource's CSP).
// Run before `next dev` and `next build`; the MCP endpoint serves the result (lib/mcp-apps.ts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const src = join(web, "mcp-apps")
const MCP_APP_HTML = join(web, ".mcp-apps", "app.html")

const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600&display=swap"

async function main() {
  const started = Date.now()
  const js = await build({
    entryPoints: [join(src, "main.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    // The tsconfig keeps JSX for Next ("preserve"): here, React's runtime.
    jsx: "automatic",
    tsconfig: join(web, "tsconfig.json"),
    alias: { "next/link": join(src, "shims/next-link.tsx"), "next/navigation": join(src, "shims/next-navigation.ts") },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  })
  const css = await postcss([tailwind({ base: web, optimize: { minify: true } })]).process(readFileSync(join(src, "app.css"), "utf8"), {
    from: join(src, "app.css"),
  })
  // An inline script ends at the first "</script": the bundle must not contain one.
  const script = js.outputFiles[0].text.replace(/<\/(script)/gi, "<\\/$1")
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOS Brainer</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${css.css}</style>
</head>
<body>
<div id="root"></div>
<script>${script}</script>
</body>
</html>
`
  mkdirSync(dirname(MCP_APP_HTML), { recursive: true })
  writeFileSync(MCP_APP_HTML, html)
  console.log(`[mcp-apps] ${MCP_APP_HTML.slice(web.length + 1)}: ${Math.round(html.length / 1024)} KB in ${Date.now() - started} ms`)
}

main().catch((err) => {
  console.error("[mcp-apps]", err)
  process.exit(1)
})
