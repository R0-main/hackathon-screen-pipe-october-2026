// Captures d'écran du front pour valider la direction artistique sans poste local.
// Lancé par .github/workflows/captures.yml contre un serveur en mode démo (BRAIN_DEMO=1) pendant que
// `npm run simulate` fait travailler des agents.
// Usage : node apps/web/scripts/captures.mjs [url] [dossier]

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "")
const out = process.argv[3] ?? "docs/captures"
await mkdir(out, { recursive: true })

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

// Chromium complet en headless, WebGL logiciel (SwiftShader) pour le cerveau 3D.
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

/** Contexte connecté en mode démo. Le cookie est réécrit sans l'attribut Secure : le serveur tourne en http. */
async function session(userId, viewport = DESKTOP, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: "fr-FR", timezoneId: "Europe/Paris", ...extra })
  const res = await ctx.request.post(`${base}/api/session/demo`, { data: { userId } })
  if (!res.ok()) throw new Error(`connexion démo ${res.status()} : ${await res.text()}`)
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
  log(ok ? "cerveau 3D affiché" : "cerveau 3D non détecté (secours 2D ?)")
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
log("admin :", admin.name, "| membre :", member.name)

// 1. Connexion
{
  const ctx = await browser.newContext({ viewport: DESKTOP, locale: "fr-FR" })
  const page = await ctx.newPage()
  await page.goto(`${base}/login`)
  await settle(page)
  await shot(page, "01-connexion")
  await ctx.close()
}

// 2. Dashboard admin : cerveau 3D, activité en direct, tiroir, question, pages admin
{
  const ctx = await session(admin.id)
  const page = await ctx.newPage()
  page.on("pageerror", (e) => log("erreur page :", e.message))
  await page.goto(base)
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
    await shot(page, "03-dashboard-en-direct")
  } else log("aucune activité d'agent captée")
  await shot(page, "04-dashboard-page-entiere", { fullPage: true })

  if (brain3d) {
    await page.locator(".brain-label").first().click({ force: true })
    await page.waitForSelector('[role="dialog"]')
    await page.waitForTimeout(800)
    await shot(page, "05-zone")
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
  }

  const q = page.getByLabel("Question au cerveau")
  await q.fill("comment on déploie en production ?")
  await q.press("Enter")
  await page.waitForTimeout(2500)
  await shot(page, "06-question")

  await page.goto(`${base}/admin`)
  await settle(page)
  await shot(page, "07-equipe-acces", { fullPage: true })
  await page.goto(`${base}/onboarding`)
  await settle(page)
  await shot(page, "08-onboarding")
  await page.goto(`${base}/people/${member.id}`)
  await settle(page)
  await shot(page, "09-passation", { fullPage: true })
  await ctx.close()
}

// 3. Membre : zones restreintes
{
  const ctx = await session(member.id)
  const page = await ctx.newPage()
  await page.goto(base)
  await settle(page)
  await waitBrain(page)
  await page.waitForTimeout(1500)
  await shot(page, "10-dashboard-membre")
  await ctx.close()
}

// 4. Mobile
{
  const ctx = await session(admin.id, MOBILE, { deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(base)
  await settle(page)
  await waitBrain(page)
  await page.waitForTimeout(1500)
  await shot(page, "11-mobile")
  await shot(page, "12-mobile-page-entiere", { fullPage: true })
  await ctx.close()
}

await browser.close()
log("terminé")
