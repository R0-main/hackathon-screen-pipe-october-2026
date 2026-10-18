import { formatBytes, type DocumentRef } from "@brain/core"
import { PaperclipIcon } from "./ui"

/** Where a document opens: the file itself (shown by the browser for a PDF or a text, downloaded otherwise). */
export function documentHref(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}?download=1`
}

/** The documents a knowledge item comes with: each one opens in a new tab. */
export function DocumentLinks({ documents, className = "" }: { documents?: DocumentRef[]; className?: string }) {
  if (!documents?.length) return null
  return (
    <ul className={`flex flex-wrap gap-1.5 text-[12px] ${className}`} aria-label="Documents">
      {documents.map((d) => (
        <li key={d.id}>
          <a href={documentHref(d.id)} target="_blank" rel="noopener" className="chip hover:border-line-strong" title={`Open ${d.name}`}>
            <PaperclipIcon size={13} aria-hidden />
            <span className="max-w-[28ch] truncate">{d.name}</span>
            <span className="tabular-nums text-trace">{formatBytes(d.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
