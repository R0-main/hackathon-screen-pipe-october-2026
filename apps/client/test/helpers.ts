import { mkdtempSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function tempDir(prefix = "brain-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export type Recorded = { method: string; url: string; headers: IncomingMessage["headers"]; body: unknown }

/** Small test HTTP server: records the requests and answers through `handler`. */
export async function mockServer(
  handler: (req: Recorded) => { status?: number; body?: unknown } | undefined,
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void>; server: Server }> {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      let body: unknown = raw
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        // plain text
      }
      const rec: Recorded = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body }
      requests.push(rec)
      const out = handler(rec) ?? { status: 404, body: { error: "not found" } }
      res.writeHead(out.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify("body" in out ? out.body : {}))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

export const TEST_ZONES = [
  { id: "dev", name: "Dev", description: "Code", color: "#000", position: 0, readable: true, keywords: ["code", "deploy", "deployer", "production", "migration", "supabase", "api", "bug"] },
  { id: "finance", name: "Finance", description: "Invoices", color: "#000", position: 1, readable: false, keywords: ["invoice", "vat", "closing", "finance"] },
]
