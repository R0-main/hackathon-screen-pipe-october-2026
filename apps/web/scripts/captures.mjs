// Front-end screenshots to review the art direction without a local machine.
// Run by .github/workflows/captures.yml against a server in demo mode (BRAIN_DEMO=1) while
// `npm run simulate` puts agents to work.
// Usage: node apps/web/scripts/captures.mjs [url] [folder]

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "")
const out = process.argv[3] ?? "docs/captures"
await mkdir(out, { recursive: true })

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

// Full Chromium headless, software WebGL (SwiftShader) for the 3D brain.
const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
})

function cookiesOf(res) {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => {
      const [pair] = h.value.split(";")
      const i = pair.indexOf("=")
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), url: base }
    })
    .filter((c) => c.name && c.value)
}

/** Signed-in context in demo mode. The cookie is rewritten without the Secure attribute: the server runs over http. */
async function session(userId, viewport = DESKTOP, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: "en-GB", timezoneId: "Europe/Paris", ...extra })
  const res = await ctx.request.post(`${base}/api/session/demo`, { data: { userId } })
  if (!res.ok()) throw new Error(`demo sign-in ${res.status()}: ${await res.text()}`)
  const cookies = cookiesOf(res)
  await ctx.clearCookies()
  await ctx.addCookies(cookies)
  return ctx
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}

async function waitBrain(page) {
  const ok = await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".brain-label")
        return Boolean(el) && getComputedStyle(el).visibility === "visible"
      },
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false)
  log(ok ? "3D brain displayed" : "3D brain not detected (2D fallback?)")
  return ok
}

async function shot(page, name, options = {}) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, ...options })
  log("capture", file)
}

const users = (await (await fetch(`${base}/api/session/demo`)).json()).users
const admin = users.find((u) => u.role === "admin") ?? users[0]
const member = users.find((u) => /jean/i.test(u.name)) ?? users.find((u) => u.role !== "admin") ?? users[0]
log("admin:", admin.name, "| member:", member.name)

// 1. Sign-in
{
  const ctx = await browser.newContext({ viewport: DESKTOP, locale: "en-GB" })
  const page = await ctx.newPage()
  await page.goto(`${base}/login`)
  await settle(page)
  await shot(page, "01-login")
  await ctx.close()
}

// 2. Admin dashboard: 3D brain, live activity, drawer, question, admin pages
{
  const ctx = await session(admin.id)
  const page = await ctx.newPage()
  page.on("pageerror", (e) => log("page error:", e.message))
  await page.goto(`${base}/dashboard`)
  await settle(page)
  const brain3d = await waitBrain(page)
  await page.waitForTimeout(1500)
  await shot(page, "02-dashboard")

  const live = await page
    .waitForSelector(".brain-label .bubble-in", { timeout: 90000 })
    .then(() => true)
    .catch(() => false)
  if (live) {
    await page.waitForTimeout(300)
    await shot(page, "03-dashboard-live")
  } else log("no agent activity caught")

  if (brain3d) {
    await page.locator(".brain-label").first().click({ force: true })
    await page.waitForSelector('[role="dialog"]')
    await page.waitForTimeout(800)
    await shot(page, "05-zone")
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
  }

  const q = page.getByLabel("Question for the brain")
  await q.fill("how do we deploy to production?")
  await q.press("Enter")
  await page.waitForTimeout(2500)
  await shot(page, "06-question")

  for (const [p, n] of [["/activity", "04-live-agents"], ["/status", "04b-status"], ["/knowledge", "04c-knowledge"], ["/tasks", "04d-tasks"]]) {
    await page.goto(`${base}${p}`)
    await settle(page)
    await shot(page, n)
  }

  await page.goto(`${base}/admin`)
  await settle(page)
  await shot(page, "07-team-access")
  await page.goto(`${base}/onboarding`)
  await settle(page)
  await shot(page, "08-onboarding")
  await page.goto(`${base}/people/${member.id}`)
  await settle(page)
  await shot(page, "09-handover")
  await ctx.close()
}

// 3. Member: restricted zones
{
  const ctx = await session(member.id)
  const page = await ctx.newPage()
  await page.goto(`${base}/dashboard`)
  await settle(page)
  await waitBrain(page)
  await page.waitForTimeout(1500)
  await shot(page, "10-dashboard-member")
  await ctx.close()
}

// 4. Mobile
{
  const ctx = await session(admin.id, MOBILE, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(`${base}/dashboard`)
  await settle(page)
  await waitBrain(page)
  await page.waitForTimeout(1500)
  await shot(page, "11-mobile")
  await page.getByLabel("Open menu").click()
  await page.waitForTimeout(400)
  await shot(page, "12-mobile-menu")
  await ctx.close()
}

await browser.close()
log("done")
