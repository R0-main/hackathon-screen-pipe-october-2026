// A one-page PDF of text lines, without any dependency: the demo company's documents (and the tests'). Helvetica in
// WinAnsi encoding, so the €, — and accented letters of the demo come out as is, and pdf.js reads the text back.

export type PdfLine = { text: string; size?: number; bold?: boolean }

/** WinAnsi codes of the characters outside Latin-1 that the demo uses. */
const WIN_ANSI: Record<string, number> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 }

function pdfString(s: string): string {
  let out = ""
  for (const ch of s) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0) ?? 63
    const c = code < 256 ? code : 63
    out += c === 0x28 || c === 0x29 || c === 0x5c ? `\\${String.fromCharCode(c)}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, "0")}` : String.fromCharCode(c)
  }
  return `(${out})`
}

export function simplePdf(lines: (PdfLine | string)[], opts: { title?: string } = {}): Buffer {
  let y = 790
  const ops: string[] = ["BT"]
  for (const l of lines.map((x) => (typeof x === "string" ? { text: x } : x))) {
    const size = l.size ?? 11
    y -= Math.round(size * 1.5)
    if (y < 50) break
    if (l.text) ops.push(`/${l.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 56 ${y} Tm ${pdfString(l.text)} Tj`)
  }
  ops.push("ET")
  const stream = ops.join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title ${pdfString(opts.title ?? "")} /Producer (NOS Brainer demo) >>`,
  ]
  let pdf = "%PDF-1.4\n%âãÏÓ\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  // Every character is below 256: one byte each, and the offsets above are byte offsets.
  return Buffer.from(pdf, "latin1")
}
