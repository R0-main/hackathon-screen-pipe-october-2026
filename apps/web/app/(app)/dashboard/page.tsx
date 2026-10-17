import { BrainView } from "@/components/BrainView"

export const dynamic = "force-dynamic"

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // ?welcome=1: we come from the link opened by `brain.mjs setup`, right after the workstation install.
  const welcome = (await searchParams).welcome === "1"
  return <BrainView welcome={welcome} />
}
