// Small shared text helpers (normalization, tokens, fingerprints).

const STOPWORDS = new Set(
  (
    "the a an of to in on at for with and or but nor so yet is are was were be been being it its this that these those " +
    "i you he she we they me him her us them my your his our their mine yours can could would should will shall may might " +
    "must do does did done have has had having not no from by as if then than there here what which who whom whose when " +
    "where why how all any both each few more most other some such only own same too very just also again already still " +
    "into out up down over under about after before between through during please thanks thank hello hi hey ok okay"
  ).split(/\s+/),
)

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function normalize(s: string): string {
  return stripAccents(s.toLowerCase())
}

/** Meaningful tokens (no accents, no stopwords), for search and classification. */
export function tokenize(s: string): string[] {
  return normalize(s)
    // the CI acronym: "gitlab-ci.yml", "github-ci", and "CI/CD" (continuous integration + delivery: two signals, plus "cicd")
    .replace(/\bci\s*[/-]\s*cd\b/g, " ci ci cicd ")
    .replace(/\b(gitlab|github|circle|circleci|travis|drone|bitbucket|woodpecker|azure|jenkins)-ci\b/g, "$1 ci ")
    .replace(/-ci(?=\.(?:ya?ml|json|toml)\b)/g, " ci ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Normalizes a prompt to compare two runs of "the same prompt" (dates, numbers, whitespace). */
export function normalizePrompt(s: string): string {
  return normalize(s)
    .replace(/\b\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?\b/g, " <date> ")
    .replace(/\b(yesterday|today|tomorrow)\b/g, " <day> ")
    .replace(/\d+/g, " <n> ")
    .replace(/[^a-z<> ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** 32-bit FNV-1a, in hex. Good enough to group prompts, not for cryptography. */
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
