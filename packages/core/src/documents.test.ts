import { test } from "node:test"
import assert from "node:assert/strict"
import { deflateRawSync } from "node:zlib"
import { extractDocumentText, plainText, unzip } from "./document-text"
import { DocumentUploadSchema, documentBaseName, documentFormat, documentProblems, documentSummary, documentTitle, formatBytes } from "./documents"

/** A zip archive (deflate) of these files: enough to stand for an Office or LibreOffice file. */
function zip(files: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8")
    const data = deflateRawSync(raw)
    const n = Buffer.from(name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

test("formats, names and titles: only the file name, never its folders", () => {
  assert.equal(documentFormat("Revenus T3.PDF")?.label, "PDF")
  assert.equal(documentFormat("deploy.sh"), null)
  assert.equal(documentBaseName("/Users/jm/Downloads/revenus-T3.pdf"), "revenus-T3.pdf")
  assert.equal(documentBaseName("C:\\Users\\jm\\budget.xlsx"), "budget.xlsx")
  assert.equal(documentTitle("encore-revenue_Q3-2026.pdf"), "encore revenue Q3 2026")
  assert.equal(formatBytes(20_480), "20 KB")
  assert.equal(formatBytes(2.5 * 1024 * 1024), "2.5 MB")
  assert.ok(documentSummary("a ".repeat(500), 40).length <= 40)
})

test("Word, Excel, PowerPoint and OpenDocument: their text, without field codes", async () => {
  const docx = zip({
    "word/document.xml":
      '<w:document><w:body><w:p><w:r><w:t>Q3 revenue:</w:t></w:r><w:r><w:t xml:space="preserve"> €1.86M &amp; up 18%</w:t></w:r></w:p>' +
      "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>Gross margin</w:t></w:r><w:r><w:tab/><w:t>38%</w:t></w:r></w:p></w:body></w:document>",
  })
  assert.equal((await extractDocumentText(docx, "report.docx")).text, "Q3 revenue: €1.86M & up 18%\nGross margin\t38%")

  const xlsx = zip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>Month</t></si><si><t>Revenue</t></si><si><r><t>Ju</t></r><r><t>ly</t></r></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>590000</v></c><c r="C2" s="1"/></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3"><f>SUM(B2)</f><v>590000</v></c></row></sheetData></worksheet>',
  })
  assert.equal((await extractDocumentText(xlsx, "q3.xlsx")).text, "## Revenue\nMonth\tRevenue\nJuly\t590000\nTotal\t590000")

  const pptx = zip({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Outlook Q4</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Q3 review</a:t></a:r></a:p><a:p><a:r><a:t>Revenue up 18%</a:t></a:r></a:p></p:sld>",
  })
  const slides = await extractDocumentText(pptx, "board.pptx")
  assert.equal(slides.text, "## Slide 1\nQ3 review\nRevenue up 18%\n\n## Slide 2\nOutlook Q4")
  assert.equal(slides.pages, 2)

  const odt = zip({
    "content.xml":
      '<office:document-content><office:automatic-styles><style:style style:name="P1"/></office:automatic-styles><office:body><office:text>' +
      "<text:h>Price list</text:h><text:p>Refurbished<text:s/>iPhone 13: €389</text:p><table:table><table:table-row><table:table-cell><text:p>Grade A</text:p></table:table-cell><table:table-cell><text:p>€429</text:p></table:table-cell></table:table-row></table:table>" +
      "</office:text></office:body></office:document-content>",
  })
  assert.equal((await extractDocumentText(odt, "prices.odt")).text, "Price list\nRefurbished iPhone 13: €389\nGrade A\t€429")
})

test("damaged or misnamed files: no text rather than an error", async () => {
  assert.equal((await extractDocumentText(Buffer.from("not a zip"), "x.docx")).text, null)
  assert.equal(unzip(Buffer.from("PK\u0005\u0006"), () => true), null)
  assert.equal(plainText(Buffer.from([0x50, 0x00, 0x01])), null)
  assert.equal((await extractDocumentText(Buffer.from("%PDF-1.4"), "x.pdf")).text, null, "no PDF reader on the computer")
  const pdf = await extractDocumentText(Buffer.from("%PDF-1.4"), "x.pdf", { pdf: async () => ({ text: "Revenue  \n\n\n\nQ3", pages: 1 }) })
  assert.deepEqual(pdf, { text: "Revenue\n\nQ3", pages: 1 })
  assert.equal((await extractDocumentText(Buffer.from("\uFEFFa,b\n1,2\n"), "x.csv")).text, "a,b\n1,2")
})

test("what stays on the computer: secrets, personal papers, contact lists, personal content", () => {
  assert.deepEqual(documentProblems("q3.pdf", "Revenue €1.86M, gross margin 38%. Contact: finance@encore.example"), [])
  assert.match(documentProblems("access.md", `STRIPE_SECRET_KEY=${"sk"}_live_51HxAbCdEfGhIjKlMnOpQrStUv`)[0], /secret/)
  assert.match(documentProblems("payslip-sept.pdf", "Net salary")[0], /personal paper/)
  assert.match(documentProblems("Fiche de paie septembre.pdf", null)[0], /personal paper/)
  assert.match(documentProblems("passport.pdf", null)[0], /personal paper/)
  assert.deepEqual(documentProblems("résumé de la réunion.docx", "Decisions of the weekly meeting: ship on Tuesday."), [], "a French résumé is a summary")
  const contacts = Array.from({ length: 12 }, (_, n) => `client${n}@gmail.com`).join("\n")
  assert.match(documentProblems("clients.csv", contacts).join(" "), /contact list/)
  assert.match(documentProblems("card.txt", "Card 4111 1111 1111 1111 exp 12/27").join(" "), /sensitive personal data/)
  assert.match(documentProblems("notes.txt", "Appointment with my therapist on Monday, then my divorce lawyer.").join(" "), /personal/)
  assert.match(documentProblems("scan.pdf", null, { requireText: true })[0], /No readable text/)
  assert.deepEqual(documentProblems("scan.pdf", null), [])
  assert.match(documentProblems("run.sh", "echo")[0], /Format not accepted/)
})

test("upload schema: content or fingerprint, 3 MB at most", () => {
  assert.equal(DocumentUploadSchema.safeParse({ name: "a.pdf" }).success, false)
  assert.equal(DocumentUploadSchema.safeParse({ name: "a.pdf", sha256: "a".repeat(64) }).success, true)
  const ok = DocumentUploadSchema.parse({ name: "a.pdf", content: "JVBERi0=" })
  assert.deepEqual(ok.item_ids, [])
  assert.equal(ok.auto, false)
  assert.equal(DocumentUploadSchema.safeParse({ name: "a.pdf", content: "A".repeat(4_300_000) }).success, false)
})
