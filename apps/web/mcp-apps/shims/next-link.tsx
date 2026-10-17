// next/link in the MCP App: no router in the host's iframe, a link opens the brain's page in the browser (ui/open-link).

import type { AnchorHTMLAttributes, Ref } from "react"
import { openBrainPage } from "../links"

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement>; prefetch?: boolean }

export default function Link({ href, onClick, prefetch: _prefetch, ...rest }: Props) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        openBrainPage(href)
      }}
    />
  )
}
