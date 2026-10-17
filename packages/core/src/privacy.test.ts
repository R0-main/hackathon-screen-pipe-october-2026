import { test } from "node:test"
import assert from "node:assert/strict"
import { isAiBrowserWindow, isAllowedApp, isSecretKey, looksPersonal, personalSignals, redact, redactText } from "./index"

// Fake secrets are assembled at runtime: the source text must not look like a real token
// (otherwise GitHub's secret scanning rejects the push).
const j = (...parts: string[]) => parts.join("")

/** Failures of a [case, text, fragments that must no longer appear] list: leak, nothing counted, not idempotent. */
function maskFailures(cases: [string, string, string[]][], requireCount = true): string[] {
  const failures: string[] = []
  for (const [name, input, leaks] of cases) {
    const r = redact(input)
    const leaked = leaks.filter((l) => r.text.includes(l))
    if (leaked.length) failures.push(`${name}: leaks ${leaked.join(", ")} → ${r.text}`)
    if (requireCount && Object.keys(r.redactions).length === 0) failures.push(`${name}: no redaction counted`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`${name}: not idempotent → ${again.text}`)
  }
  return failures
}
const changed = (list: string[]) => list.map((s) => [s, redactText(s)]).filter(([a, b]) => a !== b)
const signalsOf = (list: string[]) => list.map((t) => `${t} ${JSON.stringify(personalSignals(t))}`)

const MUST_MASK: [string, string, string[]][] = [
  // .env and variables, any case
  ["env uppercase", "DATABASE_PASSWORD=hunter2hunter2", ["hunter2"]],
  ["env lowercase", "db_password=Fournil2026!", ["Fournil2026"]],
  ["env DB_PASS", "DB_PASS=supersecret123", ["supersecret123"]],
  ["env PWD", "MYSQL_PWD=Rt5678xx", ["Rt5678xx"]],
  ["env lowercase secret", "client_secret: abcd1234efgh5678", ["abcd1234efgh5678"]],
  ["env TOKEN", "api_token: abcd1234efgh5678", ["abcd1234efgh5678"]],
  ["env KEY", "SENTRY_KEY=abc123def456", ["abc123def456"]],
  ["env KEY_BASE", "secret_key_base: 4a8f3c2e1d0b9a8f7e6d5c4b3a2f1e0d", ["4a8f3c2e"]],
  ["aws config", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ["wJalrXUtnFEMI"]],
  ["aws env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ["wJalrXUtnFEMI"]],
  ["aws in context", "the AWS secret key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, don't share it", ["wJalrXUtnFEMI"]],
  ["aws id", j("AKIA", "IOSFODNN7EXAMPLE"), ["IOSFODNN7EXAMPLE"]],
  ["quoted value with spaces", 'PASSWORD="correct horse battery staple"', ["correct", "horse", "staple"]],
  ["single quotes", "PASSWORD='p@ss w0rd'", ["p@ss", "w0rd"]],
  ["export", 'export DB_PASSWORD="correct horse battery staple"', ["horse"]],
  ["camelCase", "clientSecret: 'xyz12345'", ["xyz12345"]],
  ["arrow", "password => 'Ab12cd34'", ["Ab12cd34"]],
  ["value starting with $", "PASSWORD=$ecret123", ["$ecret123"]],
  ["value starting with xxx", "token: xxxSecret1", ["xxxSecret1"]],
  ["quoted \"my_…\" value", 'password: "my_password_123"', ["my_password_123"]],
  ["JSON password", '{"password": "hunter2hunter2"}', ["hunter2"]],
  ["JSON token", '{"user": "hugo", "token": "abcdef123456"}', ["abcdef123456"]],
  [
    "GCP service account",
    '{"type": "service_account", "private_key_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n", "client_email": "bot@proj.iam.gserviceaccount.com"}',
    ["a1b2c3d4e5f6", "MIIEvQ", "bot@proj"],
  ],
  ["truncated private key", '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', ["MIIEvQ"]],
  ["OpenSSH key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", ["b3BlbnNz"]],
  // spelled out
  ["password in a sentence", "the ssh root password is Qwerty123! on 51.15.12.34", ["Qwerty123"]],
  ["password colon", "password: Bakery#42", ["Bakery"]],
  ["pwd", "pwd: Qwerty123", ["Qwerty123"]],
  ["password's", "the password's Fournil2026", ["Fournil2026"]],
  ["password:", "ssh root@51.15.12.34 password: Fournil2026!", ["Fournil2026"]],
  ["password is", "the password for the db is hunter22", ["hunter22"]],
  ["API key spelled out", "the API key is 9f8e7d6c5b4a39281706f5e4d3c2b1a0", ["9f8e7d6c5b4a"]],
  [
    "full sentence from the review",
    "The connection to the prod database fails with db_password=Fournil2026! and aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY in my .env, the ssh root password is Qwerty123! on 51.15.12.34",
    ["Fournil2026", "wJalrXUtnFEMI", "Qwerty123"],
  ],
  // token formats
  ["anthropic", j("key sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv"), ["sk-ant-api03"]],
  ["openai", j("sk-", "proj-abcdefghijklmnopqrstuvwxyz0123"), ["sk-proj-abc"]],
  ["github", j("ghp", "_abcdefghijklmnopqrstuvwxyz0123"), ["ghp_"]],
  ["github fine-grained", j("github", "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"), ["github_pat_"]],
  ["gitlab", j("glpat", "-abcdefghijklmnopqrst"), ["glpat-"]],
  ["npm", j("npm", "_abcdefghijklmnopqrstuvwxyz0123456789"), ["npm_abc"]],
  ["huggingface", j("hf", "_abcdefghijklmnopqrstuvwxyzABCDEFGH"), ["hf_abc"]],
  ["sendgrid", j("SG", ".abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDE"), ["SG.abc"]],
  ["stripe", j("sk", "_live_abcdefghij1234567890"), ["sk_live_"]],
  ["stripe webhook", j("STRIPE_KEY=whsec", "_abcdefghijklmnopqrstuvwxyz123456"), ["whsec_"]],
  ["slack token", j("xox", "b-1234567890-abcdefghij"), ["xoxb-"]],
  ["slack webhook", j("https://hooks.slack.com/", "services/", "T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"), ["T00000000/B00000000"]],
  ["discord webhook", j("https://discord.com/api/", "webhooks/123456789012345678/", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"), ["abcdefghijklmnop"]],
  ["google", j("AIza", "SyA1234567890abcdefghijklmnopqrstu"), ["AIzaSy"]],
  ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", ["eyJzdWIi"]],
  ["unsigned jwt", "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig", ["eyJzdWIi"]],
  // HTTP headers
  ["Authorization Basic", "curl -H 'Authorization: Basic YWRtaW46cGFzc3dvcmQxMjM='", ["YWRtaW46"]],
  ["Authorization Bearer", "Authorization: Bearer abc123def456ghi789jkl", ["abc123def456"]],
  ["Basic alone", "the header is Basic YWRtaW46cGFzc3dvcmQxMjM=", ["YWRtaW46"]],
  ["x-api-key", "curl -H 'x-api-key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0'", ["9f8e7d6c"]],
  ["x-auth-token", "x-auth-token: 7c9e6679-7425-40de-944b-e07fc1f90ae7", ["7c9e6679"]],
  ["cookie", "Cookie: sid=s%3Aabc123def456; Path=/", ["abc123def456"]],
  ["bearer", "Bearer abcdefghijklmnop1234", ["abcdefghijklmnop1234"]],
  // command line
  ["--password", "brain.mjs init --password S3cret123", ["S3cret123"]],
  ["curl -u", "curl -u admin:S3cret! https://api.example.com", ["S3cret"]],
  // URL with credentials
  ["url", "postgres://admin:s3cret@db.example.com:5432/app", ["s3cret"]],
  ["url with @ in the password", "postgres://admin:p@ss@db:5432/x", ["p@ss", "ss@db"]],
  ["url with / in the password", "redis://default:ab/cd1234@redis:6379", ["ab/cd1234"]],
  ["mongodb+srv url", "mongodb+srv://user:Pa55word@cluster0.mongodb.net/db", ["Pa55word"]],
  ["git url", j("git clone https://romain:ghp", "_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y"), ["ghp_", "romain"]],
  ["url user with @", "smtp://user@domain.com:p4ss@smtp.host:587", ["p4ss"]],
  // brain token
  ["brain token", "my token cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", ["tqoelDcQ"]],
  ["brain token JSON", '{"token": "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv"}', ["tqoelDcQ"]],
  ["brain token env", "BRAIN_TOKEN cb_abcdefghijklmnopqrstuvwxyz0123456789", ["abcdefghijklmnop"]],
  ["brain token token=", "token=cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", ["tqoelDcQ"]],
  // personal data
  ["email", "write to jane.doe@example.com", ["jane.doe"]],
  ["email +tag", "romain+test@gmail.com", ["romain+test"]],
  ["French phone 06", "call me at 06 12 34 56 78", ["06 12 34"]],
  ["compact phone", "0612345678", ["0612345678"]],
  ["phone with dots", "06.12.34.56.78", ["06.12"]],
  ["phone +33", "+33 6 12 34 56 78", ["12 34 56"]],
  ["phone +33 (0)6", "tel +33 (0)6 12 34 56 78", ["12 34 56"]],
  ["phone 0033", "0033612345678", ["0033612345678"]],
  ["US phone", "call me at (415) 555-0132", ["555-0132"]],
  ["US phone dashes", "my cell is 415-555-0132", ["555-0132"]],
  ["spaced IBAN", "IBAN FR76 3000 6000 0112 3456 7890 189", ["FR76 3000", "3456 7890"]],
  ["compact IBAN", "FR7630006000011234567890189", ["FR7630006"]],
  ["lowercase IBAN", "fr76 3000 6000 0112 3456 7890 189", ["fr76 3000"]],
  ["lowercase compact IBAN", "fr7630006000011234567890189", ["fr7630006"]],
  ["IBAN followed by a word", "IBAN: FR76 3000 6000 0112 3456 7890 189 thanks", ["3000 6000"]],
  ["mistyped IBAN", "IBAN FR76 3000 6000 0112 3456 7890 1890 for payroll", ["3000 6000"]],
  ["card", "card 4111 1111 1111 1111", ["4111 1111"]],
  ["compact card", "4111111111111111", ["4111111111111111"]],
  ["US SSN", "SSN: 123-45-6789", ["123-45-6789"]],
  ["French NIR", "1 85 05 78 006 084 91", ["006 084"]],
  ["NIR with wrong key but announced", "my social security number: 1 85 05 78 006 084 36", ["006 084"]],
  ["NIR Corsica 2A", "2 85 05 2A 006 084 36", ["006 084"]],
  ["NIR Corsica 2b compact", "285052b00608436", ["00608436"]],
]

const MUST_KEEP = [
  "We're going with Stripe Billing to handle proration.",
  "commit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 on main",
  "git show 3f2a9c1",
  "uuid 550e8400-e29b-41d4-a716-446655440000",
  "request_id: 550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key: 550e8400-e29b-41d4-a716-446655440000",
  "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "timestamp 1697456789123 and 2026-10-16T08:00:00Z",
  "on 2026-10-16 at 09:00, ticket 123456",
  "Version 0.1.0 of 10/16/2026",
  "Invoice no. 2026-0042 for €1,250.00 is paid.",
  "the bakery's SIRET 732 829 320 00074",
  "max_tokens: 16000",
  "max_tokens=4000",
  "token_count: 1500",
  "TOKEN_EXPIRY=3600",
  "MAX_PASSWORD_LENGTH=128",
  "access_token_expires_in: 3600",
  "const token = await getToken()",
  "token: string",
  "password?: string",
  "def login(password: str):",
  "password = os.environ['DB_PASSWORD']",
  "token: process.env.BRAIN_TOKEN",
  "password: ${{ secrets.DB_PASSWORD }}",
  "PASSWORD=$DB_PASS",
  "PASSWORD=%DB_PASS%",
  'password: "<your-password>"',
  "password: ****",
  "api_key: YOUR_API_KEY",
  "headers: { authorization: `Bearer ${token}` }",
  "PWD=/home/hugo",
  "pk = models.AutoField(primary_key=True)",
  "secret_name: brain-prod",
  "auth: true",
  "AUTH_PROVIDER=github",
  "export NODE_ENV=production",
  "DATABASE_URL=postgres://localhost:5432/app",
  "https://www.npmjs.com/package/@types/node",
  "https://registry.npmjs.org:443/@scope/pkg",
  "npm install react@18.3.1",
  "ssh -p 2222 deploy@51.15.12.34",
  "SELECT * FROM users WHERE id = 42",
  "claude -p 'summarize the session'",
  "mkdir -p src/lib",
  "cb_on_message_received_handler()",
  "the cb_… token is stored hashed",
  "The password is forgotten, it must be reset.",
  "The password must be 12 characters long",
  "The token expired yesterday.",
  "Token: expired since yesterday.",
  "Secret: a homemade recipe",
  "forgot password: reset procedure",
  "Password: see 1Password",
  "password is required",
  "password reset flow: send an email",
  "the Bearer header is required",
  "Basic configuration of the server",
  "Token management system for the internationalization",
  "The cache key is user-42.",
  "There are 3 decisions and 12 open tasks.",
  "We keep the current price of €49 excl. VAT.",
]

test("redact: every secret or personal-data format is redacted, and it is idempotent", () => {
  assert.deepEqual(maskFailures(MUST_MASK), [])
})

test("redact: no false positive on SHAs, UUIDs, dates, amounts, code and prose", () => {
  assert.deepEqual(changed(MUST_KEEP), [])
})

test("redact: the separator and quotes are kept", () => {
  assert.equal(redactText('PASSWORD="correct horse battery staple"'), 'PASSWORD="[redacted]"')
  assert.equal(redactText("db_password: Fournil2026!, then"), "db_password: [redacted], then")
  assert.equal(redactText("postgres://admin:p@ss@db:5432/x"), "postgres://[credentials redacted]@db:5432/x")
})

test("redact: known values redacted verbatim (token from the config)", () => {
  const r = redact("I pasted abcdefgh12345678 then abcdefgh12345678", { literals: ["abcdefgh12345678", undefined, "short"] })
  assert.equal(r.text, "I pasted [secret redacted] then [secret redacted]")
  assert.equal(r.redactions.literal, 2)
})

test("redact: stays fast on long texts without separators", () => {
  const t0 = Date.now()
  for (const blob of ["a.b-c_d".repeat(6000), "A".repeat(40000), "x=".repeat(20000), "password " + " x".repeat(20000), "https://u:" + "@".repeat(20000)]) redact(blob)
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`)
})

test("isSecretKey: secret key names, without counters or types", () => {
  for (const k of ["DB_PASSWORD", "db_pass", "pwd", "clientSecret", "x-api-key", "apiKey", "aws_secret_access_key", "private_key_id", "STRIPE_KEY", "csrfToken", "token", "SECRET_KEY_BASE"]) {
    assert.ok(isSecretKey(k), k)
  }
  for (const k of ["max_tokens", "tokenCount", "TOKEN_EXPIRY", "PASSWORD_HASH", "primary_key", "idempotency_key", "secretary", "bypass", "PWD", "key", "secret_name"]) {
    assert.ok(!isSecretKey(k), k)
  }
})

test("app allowlist: whole words, browsers only on a real AI tab", () => {
  const allowed: [string, string][] = [
    ["Terminal", "claude — ~/code/fournil"],
    ["Code", "messages.ts — fournil-api"],
    ["iTerm2", "node worker — signal handling"],
    ["Google Chrome", "Claude — New chat"],
    ["Google Chrome", "Stripe migration - Claude"],
    ["Arc", "ChatGPT"],
    ["Firefox", "Le Chat - Mistral AI - Mozilla Firefox"],
  ]
  const rejected: [string, string][] = [
    ["Google Chrome", "Chase Bank — My accounts"],
    ["Google Chrome", "Claude AI billing - Gmail"],
    ["Google Chrome", "Inbox (3) - romain@gmail.com - Gmail"],
    ["Safari", "Gemini Horoscope Today - Astrology.com"],
    ["Google Chrome", "Anthropic launches Claude 5 - The Verge"],
    ["Google Chrome", "Claude — Wikipedia"],
    ["WhatsApp", "Mom"],
    ["Messages", "Julie"],
    ["Signal", "Note to self"],
    ["Spotify", ""],
    ["Code", "WhatsApp Web"],
    ["Mail", "Inbox"],
  ]
  for (const [a, w] of allowed) assert.ok(isAllowedApp(a, w), `${a} / ${w} should be allowed`)
  for (const [a, w] of rejected) assert.ok(!isAllowedApp(a, w), `${a} / ${w} should be rejected`)
  // The tab URL (when Screenpipe provides it) is authoritative.
  assert.ok(isAiBrowserWindow("Untitled", "https://claude.ai/chat/123"))
  assert.ok(!isAiBrowserWindow("Claude — New chat", "https://mail.google.com/mail/u/0"))
  assert.ok(isAllowedApp("Google Chrome", "New chat", undefined, "https://chatgpt.com/c/abc"))
})

test("personal content: private-life topics detected, work sessions kept", () => {
  const personal = [
    "Help me write an email to my doctor: I've been off with burnout and depression since Monday, and I also need to tell my lawyer about the divorce.",
    "My WhatsApp verification code doesn't work, my girlfriend Julie is waiting for my message on WhatsApp",
    "Summarize my blood test results and the psychiatrist's prescription",
    "Compare my mortgage offers with my joint account",
    "Find a series on Netflix for tonight",
  ]
  const work = [
    "The signup form's error messages are hard-coded. We decided to centralize the messages in en.json.",
    "The worker doesn't shut down cleanly when Docker sends the SIGTERM signal, we close the Postgres pool before exiting.",
    "Integrate the WhatsApp Business API to send order confirmations from the backend.",
    "Add a link to our YouTube channel in the site footer, Footer component of the showcase project.",
    "How do we deploy the API to production? My token is [secret redacted]",
    "Prepare the September VAT return from Pennylane",
    "Our customer, a dental clinic, wants the appointment reminders sent by SMS from the backend.",
  ]
  for (const t of personal) assert.ok(looksPersonal(t), `personal not detected: ${t}`)
  for (const t of work) assert.ok(!looksPersonal(t), `work wrongly dropped: ${t}`)
  const s = personalSignals(personal[0])
  assert.ok(s.strong.includes("my doctor") && s.strong.includes("divorce") && s.weak.includes("burnout"), JSON.stringify(s))
})

const MUST_MASK_R2: [string, string, string[]][] = [
  // URL parameters
  ["url ?api_key=", "curl https://api.fournil.fr/v1/export?api_key=Fk29xLmQ7pWzT4&format=csv", ["Fk29xLmQ7pWzT4"]],
  ["url &access_token=", "url: https://x.fr/cb?access_token=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url &token=", "https://api.fournil.fr/v1/export?format=csv&token=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url ?key=", "https://maps.example.com/api?key=Zt81kQmv02Lx&lang=en", ["Zt81kQmv02Lx"]],
  ["url &secret=", "https://x.fr/hook?id=12&secret=Hk2mVq81pZt", ["Hk2mVq81pZt"]],
  ["url &pwd=", "curl -X POST https://api.fournil.fr/login?login=admin&pwd=Fournil2026", ["Fournil2026"]],
  ["url &password=", "jdbc:postgresql://db.internal:5432/prod?user=admin&password=Fournil2026", ["Fournil2026"]],
  ["url &sig=", "https://cdn.fournil.fr/f.pdf?exp=1700000000&sig=a8Fk2LmQ9zXw", ["a8Fk2LmQ9zXw"]],
  // glued pairs, arrow, languages
  ["pairs without spaces", "{user:admin,password:Fournil2026}", ["Fournil2026"]],
  ["connection string", "Server=tcp:sql.fournil.fr;Database=prod;User Id=sa;Password=Fournil2026;", ["Fournil2026"]],
  ["arrow ->", "password -> Fournil2026", ["Fournil2026"]],
  ["pw:", "pw: hunter22", ["hunter22"]],
  ["Passwort", "Passwort: Fournil2026", ["Fournil2026"]],
  ["contraseña", "contraseña: Fournil2026", ["Fournil2026"]],
  ["cookie with attributes", "Cookie: session=S3cr3tPass99xyzABCDEF; other=1", ["S3cr3tPass99xyz"]],
  // spelled out, without a separator
  ["password without separator", "with the password Fournil2026! it works", ["Fournil2026"]],
  ["login / password", "login admin / password Fournil2026", ["Fournil2026"]],
  ["PASSWORD without separator", "PASSWORD Fournil2026", ["Fournil2026"]],
  ["task from the review", "change the password Sunny2026! of the back office", ["Sunny2026"]],
  ["root password", "the root password S3cret!42 works", ["S3cret!42"]],
  ["credentials pair", "credentials: admin / Fournil2026!", ["Fournil2026"]],
  ["curly quotes with a space", "password: “Fournil 2026”", ["Fournil", "2026"]],
  ["single word after is", "The wifi password is sunnygreenhill", ["sunnygreenhill"]],
  ["PIN code", "My PIN is 4589", ["4589"]],
  // code and command line
  ["redis-cli -a", "redis-cli -a Fournil2026 ping", ["Fournil2026"]],
  ["glued mysql -p", "mysql -u root -pFournil2026 prod", ["Fournil2026"]],
  ["sshpass -p", "sshpass -p Fournil2026 ssh root@51.15.12.34", ["Fournil2026"]],
  ["docker login -p", "docker login -u ci -p Fournil2026 registry.fournil.fr", ["Fournil2026"]],
  ["python auth", "requests.get(url, auth=('admin', 'Fournil2026'))", ["Fournil2026"]],
  ["auth attribute", "client.auth = ('admin', 'Fournil2026')", ["Fournil2026"]],
  ["HTTPBasicAuth", 'HTTPBasicAuth("admin", "Fournil2026")', ["Fournil2026"]],
  ["XML", "<password>Fournil2026</password>", ["Fournil2026"]],
  ["prefixed XML", "<db:password>Fournil2026</db:password>", ["Fournil2026"]],
  // formats without context
  ["AWS key alone", j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"), ["wJalrXUtnFEMI"]],
  ["lowercase brain token", j("cb_", "abcdefghijklmnopqrstuvwxyzabcdef"), ["abcdefghijklmnop"]],
]

const MUST_KEEP_R2 = [
  "The password is mandatory",
  "the password field is mandatory",
  "password: min 12 characters, one capital",
  "password_reset_token: uuid NOT NULL",
  "The token: JWT signed with HS256",
  "Authorization: header missing from the request",
  "authorization: required",
  "Authorization: Bearer <token>",
  "The secret: talk to the customer early",
  "const user = { email, password: hashedPassword, role }",
  "headers: { Authorization: 'Bearer ' + token }",
  "cookie: req.headers.cookie",
  "The password is incorrect",
  "The password is expired",
  "password: 8 characters minimum",
  "The password is stored hashed with bcrypt",
  "The password is hashed with Argon2id",
  "the password hashed in SHA-256",
  "the shop Wi-Fi password",
  "change the password every 90 days",
  "The PIN code is mandatory",
  "STRIPE_SECRET_KEY=sk_test_...",
  "secret_key_base: <%= ENV['SECRET_KEY_BASE'] %>",
  "password=getpass.getpass()",
  "Batch 2 85 05 78 006 084 36 is delivered",
  "Order no. 4970101234567890 of 10/12",
  "https://www.fournil.fr/search?q=token&page=2",
  "https://api.fournil.fr/v1/export?format=csv&limit=100",
  "mysql -u root -p prod",
  "mkdir -p src/lib && ssh -p 2222 deploy@51.15.12.34",
  "redis-cli ping",
  "credentials read / write",
  "access: admin / read",
  "<title>Forgot password</title>",
  "{user:admin,role:editor}",
]

test("redact: secret variants are redacted, idempotent", () => {
  assert.deepEqual(maskFailures(MUST_MASK_R2), [])
})

test("redact: ordinary words after \"password\", \"token:\", \"Authorization:\" stay readable", () => {
  assert.deepEqual(changed(MUST_KEEP_R2), [])
})

test("redact: the next pair is not swallowed and the rest of the URL is kept", () => {
  assert.equal(redactText("https://x.fr/export?api_key=Fk29xLmQ7pWzT4&format=csv"), "https://x.fr/export?api_key=[redacted]&format=csv")
  assert.equal(redactText("{user:admin,password:Fournil2026}"), "{user:admin,password:[redacted]}")
  assert.equal(redactText("password: “Fournil 2026”"), "password: “[redacted]”")
  assert.equal(redactText("credentials: admin / Fournil2026!"), "credentials: admin / [redacted]")
})

// Whole sessions.
const MUST_DROP = [
  "My Chase Bank access code doesn't work anymore, my customer number is 12345678, help me call the bank",
  "Explain this charge on my Chase Bank statement, customer code 12345678",
  "Help me write to my physio to move my appointment",
  "I have a dentist appointment tomorrow for a cavity, write an apology email",
  "My MRI results show a herniated disc, what should I ask the rheumatologist?",
  "I was diagnosed with cancer, how do I tell my team?",
  "I'm diabetic, what diet for my blood sugar?",
  "I was hospitalized in the ER yesterday, write a message to my manager",
  "My hypertension treatment makes me tired",
  "Help me write a message to my boyfriend for tonight",
  "My girlfriend wants us to move in together, how do we handle the budget?",
  "The family court set the hearing date",
  "How do I contest my speeding ticket?",
  "Write a letter to terminate my lease",
  "My mortgage with Wells Fargo",
  "I have an appointment with my physio",
  "I'm 3 months pregnant, how do I tell my manager?",
  "HIV testing: where to go?",
  "My son has a fever",
  "My father wants me to help choose a retirement home",
  "I've been on sick leave since Monday, tell the customer the project will be late",
  "My savings account and my 401k",
  "My health insurance reimburses my glasses badly",
]
const MUST_KEEP_WORK = [
  "Do the reconciliation of my Qonto bank account with Pennylane for September and list the variances",
  "Export the statements of my business bank account and prepare the VAT",
  "Léo is on sick leave from Oct 3 to 10: compute the statutory sick pay in payroll (Gusto)",
  "Record Léo's sick leave in October payroll (Payfit)",
  "Compute the tax withholding for Léo's payroll, who has been on sick leave since Monday",
  "How do I report an employee's sick leave in the payroll filings?",
  "The employee is on sick leave, how do we report it to HR?",
  "How do we handle an employee with burnout? HR process",
  "Update the employees' Alan health insurance for payroll",
  "My father is the founder of the bakery and wants a balance sheet",
  "My father and I are partners in the bakery, prepare the shareholders' agreement",
  "Create a Facebook Ads campaign for the product launch",
  "Analyze the performance of our YouTube channel",
  "Set up a Facebook pixel and a Google Analytics tag on the website",
  "Add Instagram as a sales channel",
  "Integrate YouTube into the product page",
  "Our customer Zocdoc wants a demo of the integration",
  "The customer wants to receive their invoices on WhatsApp",
  "The divorce() function of the date library",
  "Write the maternity and paternity leave policy for the HR handbook",
  "Léo is sick and on sick leave: update payroll in Gusto",
  "Prepare an Instagram and Facebook Ads campaign for the Christmas brioche launch. €600 budget, lookalike audience, 3 carousel creatives.",
]

test("personal content: personal banking and health dropped, payroll, accounting and family business kept", () => {
  const kept = signalsOf(MUST_DROP.filter((t) => !looksPersonal(t)))
  const dropped = signalsOf(MUST_KEEP_WORK.filter((t) => looksPersonal(t)))
  assert.deepEqual({ kept, dropped }, { kept: [], dropped: [] })
  // A retail bank + "access code" / "customer number": these are not work words.
  assert.equal(personalSignals(MUST_DROP[0]).work, 0)
})

test("allowlist: an app name inside a file name is not the app", () => {
  assert.ok(isAllowedApp("Code", "whatsapp-webhook.ts — fournil-api"))
  assert.ok(isAllowedApp("Terminal", "ssh revolut-export"))
  assert.ok(!isAllowedApp("Code", "WhatsApp Web"))
  assert.ok(!isAllowedApp("Google Chrome", "WhatsApp - Chats"))
})

test("redact: linear, even on a long line of minified JSON mentioning mongo / mysql / redis-cli", () => {
  const json = "[" + Array.from({ length: 4000 }, (_, i) => `{"service":"mongo","host":"mongo-${i}.internal","db":"mysql","cache":"redis-cli"}`).join(",") + "]"
  assert.ok(json.length > 300_000)
  redact(json.slice(0, 20_000)) // warm-up
  const best = (s: string) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now()
    redact(s)
    return performance.now() - t0
  }))
  const ms = best(json)
  assert.ok(ms < 100, `minified JSON of ${Math.round(json.length / 1024)} KB: ${ms.toFixed(0)} ms`)
  // Each keyword repeated over 320 KB: cost bounded per occurrence (not quadratic).
  const slow: string[] = []
  for (const unit of ["mongo ", "mysql ", "mysql -u root ", "redis-cli ", "docker login ", "sqlcmd ", j("-----BEGIN PRIV", "ATE KEY-----"), "http://a:", "password is ", "token "]) {
    const s = unit.repeat(Math.ceil(320_000 / unit.length))
    const t = best(s)
    if (t > 400) slow.push(`${JSON.stringify(unit)}: ${t.toFixed(0)} ms`)
  }
  assert.deepEqual(slow, [])
  // The bounded scan keeps the real cases.
  assert.equal(redactText("mysql -h db.internal -P 3306 -u root --ssl-mode=REQUIRED -pFournil2026 prod"), "mysql -h db.internal -P 3306 -u root --ssl-mode=REQUIRED -p[redacted] prod")
  assert.equal(redactText("mongo -u admin -p Fournil2026"), "mongo -u admin -p [redacted]")
  assert.equal(redactText(j("-----BEGIN PRIV", "ATE KEY-----\nMIIEvQ\n-----END PRIV", "ATE KEY----- then the rest")), "[private key redacted] then the rest")
})

const MUST_MASK_R3: [string, string, string[]][] = [
  ["is:", "The password is: Fournil2026", ["Fournil2026"]],
  ["is :", "The password is : Fournil2026", ["Fournil2026"]],
  ["was:", "the password was: Fournil2026", ["Fournil2026"]],
  ["pwd is:", "The pwd is: Fournil2026", ["Fournil2026"]],
  ["API key is:", "The API key is: S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["qualifier then is:", "The prod password is: Fournil2026!", ["Fournil2026"]],
  ["in parentheses", "TODO: log into the back office with the admin login (the password is: Fournil2026) and rerun the export", ["Fournil2026"]],
  ["arrow", "password → Fournil2026", ["Fournil2026"]],
  ["long arrow", "Password —> Fournil2026", ["Fournil2026"]],
  ["long detour before is", "the password to log into the production server over SSH is Fournil2026", ["Fournil2026"]],
  ["PIN :", "PIN : 4589", ["4589"]],
  ["qualifier without separator", "password root Fournil2026", ["Fournil2026"]],
  ["url ?sid=", "https://x.fr/?sid=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url ?token= long word", "https://x.fr/reset?token=abcdefghijklmnop", ["abcdefghijklmnop"]],
  ["passw key", "passw: Fournil2026", ["Fournil2026"]],
]

const MUST_KEEP_R3 = [
  "Forgot password?",
  "Wrong password!",
  "toast('Password changed!')",
  "Error: invalid password!",
  "The password is incorrect!",
  "The password is encoded in base64",
  "The password is stored in 1Password",
  "The password for the Office365 account",
  "reset the password on Windows 11",
  "reset the password on Windows11",
  "The password expires in Q4-2026",
  "password WPA2-PSK",
  "the password is: see the vault",
  "?sort=asc&key=created_at",
  "https://example.com/?auth=google",
  "https://example.com/?pass=true",
  "https://example.com/?secret=false",
  "https://example.com/docs?key=value",
  "https://example.com/?sig=abc",
  "https://app.fournil.fr/admin?tab=tokens&key=name",
  "credentials: EIN / VAT",
  "Logins: Google / Microsoft",
  "credentials: 'include'",
  "fetch(url, { credentials: 'same-origin' })",
  "token: uuid",
  "password: hashed",
  "Authorization: Bearer YOUR_TOKEN",
  "The PIN code is mandatory",
]

test("redact: \"is:\", \"was:\" and arrows as separators; idempotent", () => {
  assert.deepEqual(maskFailures(MUST_MASK_R3, false), [])
  assert.equal(redactText("The password is: Fournil2026"), "The password is: [redacted]")
  assert.equal(redactText("The API key is: S3cr3tPass99xyz"), "The API key is: [redacted]")
})

test("redact: an ordinary word is not a secret (\"forgotten?\", \"1Password\", \"?key=created_at\", \"EIN / VAT\")", () => {
  assert.deepEqual(changed(MUST_KEEP_R3), [])
  // Values that look like secrets stay redacted in the same phrasings.
  assert.equal(redactText("change the password Sunny2026! of the back office"), "change the password [redacted] of the back office")
  assert.equal(redactText("https://x.fr/?key=Zt81kQmv02Lx&lang=en"), "https://x.fr/?key=[redacted]&lang=en")
  assert.equal(redactText("credentials: admin / Fournil2026!"), "credentials: admin / [redacted]")
})

const MUST_DROP_R3 = [
  "How do I dispute a charge on my checking account at Chase Bank? They debited me $89 twice.",
  "My Revolut account is blocked, I have a transfer to make for the house renovation project with the contractor's quote",
  "How do I calculate child support for my kids?",
]
const MUST_KEEP_WORK_R3 = [
  "Wage garnishment for child support: how to apply it in Léo's payroll",
  "Organize the pre-employment medical check with the occupational doctor for the two new employees",
  "Prepare my meeting with my bank adviser for the bakery loan (balance sheet, forecast)",
  "Export my Qonto account statement for the accountant",
]

test("personal content: checking account and personal bank dropped; wage garnishment and occupational doctor kept", () => {
  const kept = signalsOf(MUST_DROP_R3.filter((t) => !looksPersonal(t)))
  const dropped = signalsOf([...MUST_KEEP_WORK_R3, ...MUST_KEEP_WORK].filter((t) => looksPersonal(t)))
  assert.deepEqual({ kept, dropped }, { kept: [], dropped: [] })
  assert.deepEqual(MUST_DROP.filter((t) => !looksPersonal(t)), [])
  // One's own doctor stays a private-life topic.
  assert.ok(looksPersonal("I have a doctor's appointment tomorrow, move my customer meeting"))
})

test("redact: linear on 32 KB of spaces, line breaks or non-breaking spaces after each keyword", () => {
  const keywords = [
    "password", "The password is", "The password is now", "pwd:", "pwd", "the password is", "token",
    "the token is", "secret", "the secret is", "API key", "The API key is:", "PIN", "PIN code is", "pin code:",
  ]
  const runs = [" ", "\n", "\t", " ", " ", " \n"]
  const ends = ["", "»", "”", '"', "'", "`"]
  redact("warm-up: the password is: x, the token is: y ".repeat(50))
  const time = (s: string) => {
    const t0 = performance.now()
    redact(s)
    return performance.now() - t0
  }
  const slow: string[] = []
  for (const k of keywords) {
    for (const w of runs) {
      for (const e of ends) {
        const s = k + w.repeat(Math.ceil((32 * 1024 - k.length) / w.length)) + e
        // A single measurement can be slowed down by garbage collection: keep the best of three.
        let ms = time(s)
        for (let i = 0; i < 2 && ms > 50; i++) ms = Math.min(ms, time(s))
        if (ms > 50) slow.push(`${JSON.stringify(k)} + ${JSON.stringify(w)} × ${s.length} + ${JSON.stringify(e)}: ${ms.toFixed(0)} ms`)
      }
    }
  }
  assert.deepEqual(slow, [])
})

// "Pin the react version: react@18.3.1": the English verb "pin" is not a PIN code.
const PIN_KEEP = [
  "Pin the react version: react@18.3.1",
  "We pin dependencies: lodash@4.17.21",
  "Pin the message in Slack: https://fournil.slack.com/archives/C0123",
  "* **internal:** pin the pnpm version with an integrity hash ([f804366](https://github.com/a/b/commit/f804366))",
  "pin: true",
  "Pin it: top of channel",
  "The Qonto card PIN code is sent by SMS",
  "The PIN code is mandatory",
  "PIN: GPIO 13",
]
const PIN_MASK: [string, string][] = [
  ["PIN : 4589", "PIN : [redacted]"],
  ["PIN: 4589", "PIN: [redacted]"],
  ["PIN code: 4589", "PIN code: [redacted]"],
  ["My PIN is 4589", "My PIN is [redacted]"],
  ["The card PIN is: 4589.", "The card PIN is: [redacted]."],
  ["the pin code = 123456", "the pin code = [redacted]"],
]

test("redact: \"PIN\" in capitals or \"pin code\", followed by 4 to 8 digits; the verb \"pin\" stays readable", () => {
  assert.deepEqual(changed(PIN_KEEP), [])
  assert.deepEqual(PIN_MASK.map(([s, want]) => [s, redactText(s), want]).filter(([, got, want]) => got !== want), [])
})

// One or a few words between the verb and the value, and dots in a domain or an abbreviation.
const PW = j("Fournil", "2026")
const KEY = j("S3cr3t", "Pass99xyz")
const MUST_MASK_R4: string[] = [
  `The password is now: ${PW}`,
  `The password is still: ${PW}`,
  `The new password is currently: ${PW}`,
  `The password is the following: ${PW}`,
  `The password is as follows: ${PW}`,
  `the password is now: ${PW}`,
  `The API key is the following: ${KEY}`,
  `The token is the following: ${KEY}`,
  `The password is now ${PW}`,
  `The password is still ${PW}`,
  `the password is still ${PW}`,
  `The password is now:\n${PW}`,
  `Hi, the password is now: "${PW}"`,
  `The password for pennylane.com: ${PW}`,
  `password for fournil.fr: ${PW}`,
  `The password for app.qonto.com is: ${PW}`,
  `The password (cf. docs) is: ${PW}`,
  `The password v2.1 is: ${PW}`,
  `The current password is still: ${PW}`,
  `The password is: ${PW}`,
]
const MUST_KEEP_R4 = [
  "The password is now mandatory",
  "The password is safely stored in 1Password",
  "The password is always valid for 24h",
  "The password is the same as Qonto's",
  "The password is too short: 8 characters minimum",
  "The password for the docs: see the vault",
  "Forgot password: https://app.fournil.fr/reset",
  "Password changed. Version: v2.3.1",
  "The API key is generated server-side: see auth.ts",
  "The secret is simple: talk to the customer early",
  "- _password_: password string according to the [openApi 3.0.0 specification](https://spec.openapis.org/oas/v3.0.0#data-types)",
  "is the password correct?",
]

test("redact: \"is now:\", \"is the following:\", \"is still\", a domain or \"cf.\" before the separator; idempotent", () => {
  const failures: string[] = []
  for (const input of MUST_MASK_R4) {
    const r = redact(input)
    if (r.text.includes(PW) || r.text.includes(KEY)) failures.push(`leak: ${input} → ${r.text}`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`not idempotent: ${again.text}`)
  }
  assert.deepEqual(failures, [])
  // The redacted value is the secret, not the word before ":".
  assert.equal(redactText(`The password is this one: ${PW}`), "The password is this one: [redacted]")
  assert.equal(redactText(`The password is now: ${PW}`), "The password is now: [redacted]")
  assert.equal(redactText(`The API key is the following: ${KEY}`), "The API key is the following: [redacted]")
  assert.equal(redactText(`The password for pennylane.com: ${PW}`), "The password for pennylane.com: [redacted]")
  // Prose stays readable, like the cases above.
  assert.deepEqual(changed([...MUST_KEEP_R4, ...MUST_KEEP_R3, ...MUST_KEEP_R2]), [])
})

// The company's bank at a traditional bank: accounting, not private life.
const MUST_KEEP_WORK_R4 = [
  "Do the reconciliation of my Chase Bank account with Pennylane for September",
  "Reconcile my Barclays account with Pennylane for September",
  "Reconcile my HSBC business account with the invoices in Pennylane",
  "Export the statements of my Barclays business account to Pennylane",
  "The payroll tax debit was rejected on the bakery's Barclays account",
  "Supplier payment: the transfer from my Barclays account to the flour mill was rejected, see the invoice",
  "How do I repay my shareholder loan account?",
  "My shareholder loan account has a €20,000 credit balance, how do I repay it?",
  "Léo owes child support: how do we do the garnishment on their pay?",
  "Child support: how to apply the wage garnishment to Léo's salary?",
]
const MUST_DROP_R4 = [
  "How do I dispute a charge on my checking account at Chase Bank?",
  "I'm overdrawn on my Barclays account, what are the fees?",
  "Revolut blocked my transfer, what should I do?",
  "My Chase Bank card was declined at the supermarket, how do I unblock the payment?",
  "I'm paying my rent late, how do I negotiate with my landlord?",
  "My pay didn't arrive on my Monzo account, what do I do?",
  "My son is sick, how do I tell my company?",
]

test("personal content: the company's bank stays accounting; a personal bank without a work context is dropped", () => {
  const dropped = signalsOf([...MUST_KEEP_WORK_R4, ...MUST_KEEP_WORK_R3, ...MUST_KEEP_WORK].filter((t) => looksPersonal(t)))
  const kept = signalsOf([...MUST_DROP_R4, ...MUST_DROP_R3, ...MUST_DROP].filter((t) => !looksPersonal(t)))
  assert.deepEqual({ dropped, kept }, { dropped: [], kept: [] })
  // "I pay" is a verb; a bank name is not a work word.
  assert.equal(personalSignals("I pay the rent").work, 0)
  assert.equal(personalSignals("My card was blocked by Barclays").work, 0)
})

/** Best of three measurements (garbage collection can slow down a single one). */
function bestMs(f: () => unknown): number {
  f()
  return Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now()
    f()
    return performance.now() - t0
  }))
}
const repeatTo = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

// Keyword and verb or separator on two lines (OCR line break, Markdown definition list).
const NL_MASK_R5: [string, string][] = [
  [`the password\nis ${PW}`, "the password\nis [redacted]"],
  [`Your new Wi-Fi password\nis ${PW}`, "Your new Wi-Fi password\nis [redacted]"],
  [`The shop password\nis: ${PW}`, "The shop password\nis: [redacted]"],
  [`The API key\nis: ${KEY}`, "The API key\nis: [redacted]"],
  [`Password\n: ${PW}`, "Password\n: [redacted]"],
  [`Password\r\n: ${PW}`, "Password\r\n: [redacted]"],
  [`password\n= ${PW}`, "password\n= [redacted]"],
  ["PIN\n: 4589", "PIN\n: [redacted]"],
  [`The password is\n: ${PW}`, "The password is\n: [redacted]"],
  [`To log into the back office, the password\nis ${PW}, the login is admin.`, "To log into the back office, the password\nis [redacted], the login is admin."],
  // up to 64 whitespace characters between the separator and the value
  [`Password:${" ".repeat(40)}${PW}`, `Password:${" ".repeat(40)}[redacted]`],
  [`Password:${" ".repeat(64)}${PW}`, `Password:${" ".repeat(64)}[redacted]`],
  [`The password is:${" ".repeat(64)}${PW}`, `The password is:${" ".repeat(64)}[redacted]`],
  [`The password is now${" ".repeat(40)}${PW}`, `The password is now${" ".repeat(40)}[redacted]`],
]
const NL_KEEP_R5 = ["Resetting the password\nis a simple task", "Change the password\n: see the procedure", "The password\nis mandatory"]

test("redact: keyword and \"is\" / \":\" separated by a line break, up to 64 whitespace characters before the value", () => {
  assert.deepEqual(NL_MASK_R5.map(([s, want]) => [s, redactText(s), want]).filter(([, got, want]) => got !== want), [])
  assert.deepEqual(changed(NL_KEEP_R5), [])
})

// A letters-only password followed further on by ":" is the value, not a filler word.
const SUNNY = j("Sunny", "Green")
const FILLER_MASK_R5: [string, string][] = [
  [`The password is ${SUNNY}: don't share it`, "The password is [redacted]: don't share it"],
  [`The password is ${j("Hunter", "Two")}: don't share it`, "The password is [redacted]: don't share it"],
  [`The password is ${j("bakery", "house")}: it's simple`, "The password is [redacted]: it's simple"],
  [`The password is ${SUNNY} and the login: admin`, "The password is [redacted] and the login: admin"],
  [`pwd is ${SUNNY}: ok`, "pwd is [redacted]: ok"],
  [`The password is ${j("StrongPass", "Word")}: keep it to yourself`, "The password is [redacted]: keep it to yourself"],
  [`The wifi password is ${j("fournil", "wifi")}: give it to customers`, "The wifi password is [redacted]: give it to customers"],
  // filler words from the closed list are still recognized
  [`The password is simple: ${PW}`, "The password is simple: [redacted]"],
  [`The password is at the moment: ${PW}`, "The password is at the moment: [redacted]"],
  [`The password is still the same: ${PW}`, "The password is still the same: [redacted]"],
  [`The password is as follows: ${PW}`, "The password is as follows: [redacted]"],
  [`The token is the following: ${KEY}`, "The token is the following: [redacted]"],
  [`Here is the password: ${PW}`, "Here is the password: [redacted]"],
]
// What follows "is in / managed by / available at / generated from:" is a place, not the value; nor a version, nor a date.
const FILLER_KEEP_R5 = [
  "The password is in the vault: 1Password",
  "The password is managed by: 1Password",
  "The password is in the file: config/db-prod.env",
  "The API key is available at: https://app.fournil.fr/settings/api-2026",
  "The token is generated from: https://github.com/settings/tokens/new?scopes=repo2",
  "The secret is stored in: projects/fournil-2026/secrets/db-password",
  "The token is now v2.3.1-beta4",
  "the password is also used for: SSH2 access",
  "PIN: 2024-10-17",
  "PIN : 2024/10/17",
]

test("redact: a letters-only password is redacted, not taken for a filler word; a place or a version stays readable", () => {
  const failures: string[] = []
  for (const [s, want] of FILLER_MASK_R5) {
    const r = redact(s)
    if (r.text !== want) failures.push(`${s} → ${r.text}`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`not idempotent: ${again.text}`)
  }
  assert.deepEqual(failures, [])
  assert.deepEqual(changed(FILLER_KEEP_R5), [])
  // The earlier gains hold, like the kept lines above.
  assert.deepEqual(MUST_MASK_R4.filter((s) => redactText(s).includes(PW) || redactText(s).includes(KEY)), [])
  assert.deepEqual(changed([...MUST_KEEP_R4, ...MUST_KEEP_R3, ...MUST_KEEP_R2, ...PIN_KEEP]), [])
  assert.equal(redactText("PIN : 4589."), "PIN : [redacted].")
})

test("redact: linear on abbreviations (\"cf.cf.cf.\"), login / password pairs, JWTs and unclosed quotes", () => {
  const cases: [string, (n: number) => string][] = [
    ["pwd + cf.×20", (n) => repeatTo("pwd " + "cf.".repeat(20) + "\n", n)],
    ["password + ex.×20", (n) => repeatTo("password " + "ex.".repeat(20) + " ", n)],
    ["pwd + cf.ex.vs.×6", (n) => repeatTo("pwd " + "cf.ex.vs.".repeat(6) + "\n", n)],
    ["token + ex.×10", (n) => repeatTo("token " + "ex.".repeat(10) + "\n", n)],
    ["PIN + vs.×10", (n) => repeatTo("PIN " + "vs.".repeat(10) + "\n", n)],
    ["credentials: admin / + dots", (n) => "credentials: admin / " + ".".repeat(n) + "x"],
    ["access = admin / + !", (n) => "access = admin / " + "!".repeat(n) + "x"],
    ["credentials repeated + 2,001 :", (n) => repeatTo("credentials: admin / " + ":".repeat(2001), n)],
    ["eyJ- repeated", (n) => repeatTo("eyJ-", n)],
    ["eyJa1- repeated", (n) => repeatTo("eyJa1-", n)],
    ["token=«x", (n) => repeatTo("token=«x", n)],
    ["token : «", (n) => repeatTo("token : « ", n)],
    ["password: “?", (n) => repeatTo("password: “?", n)],
    ["password: «", (n) => repeatTo("password: « ", n)],
    ["value of 2,000 dots", (n) => repeatTo("token=" + ".".repeat(1990) + "x ", n)],
  ]
  const slow: string[] = []
  for (const [name, make] of cases) {
    for (const [n, limit] of [[32_000, 50], [320_000, 250]] as const) {
      const s = make(n)
      const ms = bestMs(() => redact(s))
      if (ms > limit) slow.push(`${name} × ${n}: ${ms.toFixed(0)} ms`)
    }
  }
  // A window title made of a long run of spaces (split on "\s+ - \s+").
  for (const [n, limit] of [[32_000, 50], [320_000, 250]] as const) {
    const title = "a" + " ".repeat(n) + "x"
    const ms = bestMs(() => isAllowedApp("Google Chrome", title))
    if (ms > limit) slow.push(`title of ${n} spaces: ${ms.toFixed(0)} ms`)
  }
  assert.deepEqual(slow, [])
})

test("redact: the real cases stay redacted (domain and \"cf.\" before the separator, JWT, pair, quoted 1,200-character token)", () => {
  assert.equal(redactText(`The password (cf. docs) is: ${PW}`), "The password (cf. docs) is: [redacted]")
  assert.equal(redactText(`The password for app.qonto.com is: ${PW}`), "The password for app.qonto.com is: [redacted]")
  assert.equal(redactText(`Pwd pennylane.com: ${PW}`), "Pwd pennylane.com: [redacted]")
  const jwt = j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "c2lnbmF0dXJlLXRlc3Q")
  assert.equal(redactText(`token: ${jwt}`), "token: [token redacted]")
  assert.equal(redactText(`Authorization: Bearer ${jwt}`), "Authorization: Bearer [token redacted]")
  assert.equal(redactText(`id_token=${jwt}&state=1`), "id_token=[token redacted]&state=1")
  assert.equal(redactText(`credentials: admin / ${PW}.`), "credentials: admin / [redacted].")
  // The search for the closing quote keeps its 2,000-character reach (an AWS session token is ~1,000).
  const session = j("IQoJb3JpZ2luX2Vj", "A1b2C3d4".repeat(150))
  assert.equal(redactText(`AWS_SESSION_TOKEN="${session}"`), 'AWS_SESSION_TOKEN="[redacted]"')
  // After thousands of never-closed quotes, a real quoted value is still read.
  assert.ok(redactText("password: « ".repeat(3000) + `\npassword: «${PW}»`).endsWith("password: «[redacted]»"))
  // An ordinary tab title is still recognized.
  assert.ok(isAllowedApp("Google Chrome", "September close - Claude - Google Chrome"))
})

// Personal: generic business-management words are worth one point only.
const MUST_DROP_R5 = [
  "I'm an employee and my rent went up 10%, is it legal? Help me write to my landlord.",
  "I'm an employee, my landlord refuses to return my deposit, what can I do?",
  "My pay went down this month and my bank charged me overdraft fees, how do I dispute it?",
  "My electricity supplier charged me twice, my bank refuses to refund",
  "My bank rejected my internet provider's direct debit, what can I do?",
  "My son is doing an internship at a company, help me proofread the report",
  "My daughter is looking for a work-study job at a company, proofread the cover letter",
  "My daughter is sick, I need to tell my company and my team",
  "My child is sick, I need to tell the company and cancel the meeting",
  "My mother is looking for a moving company for Saturday",
  "My landlord says the management company will raise the rent, my rent goes up to €900",
  "My brother is a partner with me in a property company, how do we split the rent on my apartment?",
  "My bank adviser is asking for a certificate from my company for my loan",
  "My parents want me to change companies, help me answer them",
]

test("personal content: \"company\", \"supplier\", \"employee\", \"payroll\" count one point; only management phrases count two", () => {
  const kept = signalsOf(MUST_DROP_R5.filter((t) => !looksPersonal(t)))
  const dropped = signalsOf([...MUST_KEEP_WORK_R4, ...MUST_KEEP_WORK_R3, ...MUST_KEEP_WORK].filter((t) => looksPersonal(t)))
  const keptBefore = [...MUST_DROP_R4, ...MUST_DROP_R3, ...MUST_DROP].filter((t) => !looksPersonal(t))
  assert.deepEqual({ kept, dropped, keptBefore }, { kept: [], dropped: [], keptBefore: [] })
  // One's own pay is not work vocabulary; the company's payroll is.
  assert.equal(personalSignals("my pay").work, 0)
  // "my company": for a founder, it is the business itself ("My company sells on Instagram").
  assert.equal(personalSignals("my company").work, 1)
  assert.equal(personalSignals("Léo's payroll").work, 1)
  // "bank reconciliation": two points for "bank", one for "reconciliation"; "transfer to supplier": two plus one.
  assert.equal(personalSignals("the bank reconciliation").work, 3)
  assert.equal(personalSignals("Transfer to supplier rejected").work, 3)
})
