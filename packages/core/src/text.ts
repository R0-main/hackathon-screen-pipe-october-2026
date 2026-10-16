// Petits outils texte partagés (normalisation, tokens, empreintes).

const STOPWORDS = new Set(
  (
    "le la les un une des du de d l et ou mais donc or ni car a au aux en dans sur sous par pour avec sans ce cet cette ces " +
    "mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se moi toi lui " +
    "qui que quoi dont ou est sont etre avoir ai as avons avez ont fait faire peux peut veux veut plus moins tres bien tout " +
    "tous toute toutes ne pas y c s n qu j m t si comme alors aussi encore deja the a an of to in on for with and or but is are " +
    "be it this that these those i you he she we they my your our me us can could would should will do does did please stp merci " +
    "svp hello bonjour salut ok okay"
  ).split(/\s+/),
)

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function normalize(s: string): string {
  return stripAccents(s.toLowerCase())
}

/** Tokens significatifs (sans accents, sans mots vides), pour la recherche et la classification. */
export function tokenize(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Normalise un prompt pour comparer deux exécutions « du même prompt » (dates, nombres, espaces). */
export function normalizePrompt(s: string): string {
  return normalize(s)
    .replace(/\b\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?\b/g, " <date> ")
    .replace(/\b(hier|aujourd'?hui|demain|yesterday|today|tomorrow)\b/g, " <day> ")
    .replace(/\d+/g, " <n> ")
    .replace(/[^a-z<> ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** FNV-1a 32 bits, en hexadécimal. Suffisant pour regrouper des prompts, pas pour de la crypto. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export function promptFingerprint(prompt: string): string {
  return fnv1a(normalizePrompt(prompt))
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

export function firstSentence(s: string, max = 120): string {
  const line = s
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ""
  const m = line.match(/^(.{10,}?[.!?])(\s|$)/)
  return truncate((m ? m[1] : line).replace(/^[#>*\-\s]+/, ""), max)
}
