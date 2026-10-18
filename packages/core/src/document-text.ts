// Text of a document, to search it, show it to agents and check it before it leaves the computer (secrets, personal
// data). Office and OpenDocument files are zip archives of XML: read here without any dependency. PDF needs pdf.js:
// the brain passes its reader (`pdf`), the computer's client does without (the brain checks the PDF on arrival).
// Node only (node:zlib): imported as "@brain/core/document-text", never from the dashboard's browser code.

import { inflateRawSync } from "node:zlib"
import { DOCUMENT_TEXT_MAX, cleanDocumentText, documentFormat } from "./documents"

/** Safeguards against a zip bomb: uncompressed size per file read and in total. */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_ROWS = 5000

/**
 * Files of a zip archive whose name `want` accepts, uncompressed. Stored (0) and deflate (8) only, which is
 * what Office and LibreOffice write. Null if the archive cannot be read.
 */
export function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> | null {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > buf.length) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8")
    p += 46 + nameLen + extraLen + commentLen
    if (!want(name) || size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES) continue
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + compressed)
    try {
      const raw = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }) : null
      if (!raw) continue
      total += raw.length
      out.set(name, raw)
    } catch {
      // damaged entry: the others are still read
    }
  }
  return out
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const byNumber = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0)

/** Word: the runs of text (<w:t>) only, not the field codes; paragraphs and table cells keep their breaks. */
function docxText(files: Map<string, Buffer>): string {
  const xml = files.get("word/document.xml")?.toString("utf8") ?? ""
  let out = ""
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1])
    else if (m[0] === "<w:tab/>" || m[0] === "</w:tc>") out += "\t"
    else out += "\n"
  }
  return out
}

/** Excel: each sheet as rows of tab-separated cells, under its name. */
function xlsxText(files: Map<string, Buffer>): string {
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""),
  )
  // Sheet names, through the workbook's relations (sheet3.xml is not always the third tab).
  const rels = new Map<string, string>()
  for (const m of (files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1]
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && target) rels.set(id, `xl/${target.replace(/^\/?(?:xl\/)?/, "")}`)
  }
  const names = new Map<string, string>()
  for (const m of (files.get("xl/workbook.xml")?.toString("utf8") ?? "").matchAll(/<sheet\b[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1]
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1]
    if (name !== undefined && rid && rels.has(rid)) names.set(rels.get(rid)!, decodeXml(name))
  }
  const sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber)
  const ordered = [...names.keys()].filter((n) => files.has(n))
  const parts: string[] = []
  let rows = 0
  for (const file of [...ordered, ...sheets.filter((s) => !names.has(s))]) {
    const xml = files.get(file)!.toString("utf8")
    const lines: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rows > MAX_ROWS) break
      const cells: string[] = []
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = c[1].match(/\bt="([^"]+)"/)?.[1]
        const body = c[2] ?? ""
        const v = body.match(/<v>([^<]*)<\/v>/)?.[1]
        if (type === "s" && v !== undefined) cells.push(shared[Number(v)] ?? "")
        else if (type === "inlineStr") cells.push([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""))
        else if (type === "b" && v !== undefined) cells.push(v === "1" ? "TRUE" : "FALSE")
        else cells.push(v !== undefined ? decodeXml(v) : "")
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      if (cells.length) lines.push(cells.join("\t"))
    }
    if (lines.length) parts.push(`## ${names.get(file) ?? `Sheet ${file.match(/(\d+)\.xml$/)?.[1] ?? ""}`.trim()}\n${lines.join("\n")}`)
    if (rows > MAX_ROWS) break
  }
  return parts.join("\n\n")
}

/** PowerPoint: the text of each slide (<a:t>), in order. */
function pptxText(files: Map<string, Buffer>): string {
  const slides = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber)
  return slides
    .map((file, n) => {
      const xml = files.get(file)!.toString("utf8")
      let text = ""
      for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>|<a:br\/>/g)) text += m[1] !== undefined ? decodeXml(m[1]) : "\n"
      return text.trim() ? `## Slide ${n + 1}\n${text.trim()}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

/** OpenDocument (LibreOffice): content.xml only has the content as text nodes; tags only mark the breaks. */
function odfText(files: Map<string, Buffer>): string {
  const xml = (files.get("content.xml")?.toString("utf8") ?? "").replace(/<office:automatic-styles>[\s\S]*?<\/office:automatic-styles>/g, "")
  return decodeXml(
    xml
      .replace(/<\/text:p>(\s*<\/table:table-cell>)/g, "$1")
      .replace(/<text:s\b[^>]*\/>/g, " ")
      .replace(/<text:tab\/>|<\/table:table-cell>/g, "\t")
      .replace(/<text:line-break\/>|<\/text:p>|<\/text:h>|<\/table:table-row>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
}

/** UTF-8 text (CSV, Markdown, text); null for a binary file under a text extension. */
export function plainText(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null
  return buf.toString("utf8").replace(/^﻿/, "")
}

export type PdfReader = (bytes: Uint8Array) => Promise<{ text: string; pages?: number }>

export type ExtractedText = {
  /** Null when it could not be read here (PDF without a reader, damaged file, binary under a text extension). */
  text: string | null
  pages?: number
}

/** The document's text, cleaned and bounded (DOCUMENT_TEXT_MAX). */
export async function extractDocumentText(buf: Buffer, name: string, opts: { pdf?: PdfReader } = {}): Promise<ExtractedText> {
  const format = documentFormat(name)
  if (!format) return { text: null }
  const done = (text: string | null, pages?: number): ExtractedText => ({
    text: text === null ? null : cleanDocumentText(text).slice(0, DOCUMENT_TEXT_MAX),
    ...(pages ? { pages } : {}),
  })
  try {
    if (format.reader === "plain") return done(plainText(buf))
    if (format.reader === "pdf") {
      if (!opts.pdf || buf.subarray(0, 1024).indexOf("%PDF-") < 0) return { text: null }
      const r = await opts.pdf(new Uint8Array(buf))
      return done(r.text, r.pages)
    }
    const files = unzip(buf, (n) => /^(?:word\/document\.xml|xl\/(?:sharedStrings|workbook)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(n))
    if (!files) return { text: null }
    if (format.ext === "docx") return done(docxText(files))
    if (format.ext === "xlsx") return done(xlsxText(files))
    if (format.ext === "pptx") return done(pptxText(files), [...files.keys()].filter((n) => n.startsWith("ppt/slides/")).length)
    return done(odfText(files))
  } catch {
    return { text: null }
  }
}
