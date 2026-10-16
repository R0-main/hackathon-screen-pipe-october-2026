import { test } from "node:test"
import assert from "node:assert/strict"
import { isAiBrowserWindow, isAllowedApp, isSecretKey, looksPersonal, personalSignals, redact, redactText } from "./index"

// Les faux secrets sont assemblés à l'exécution : le texte source ne doit pas ressembler à un vrai jeton
// (sinon la protection anti-secrets de GitHub refuse le push).
const j = (...parts: string[]) => parts.join("")

// [cas, texte, fragments qui ne doivent plus apparaître]
const MUST_MASK: [string, string, string[]][] = [
  // .env et variables, toutes casses
  ["env majuscules", "DATABASE_PASSWORD=hunter2hunter2", ["hunter2"]],
  ["env minuscules", "db_password=Fournil2026!", ["Fournil2026"]],
  ["env DB_PASS", "DB_PASS=supersecret123", ["supersecret123"]],
  ["env PWD", "MYSQL_PWD=Rt5678xx", ["Rt5678xx"]],
  ["env SECRET minuscules", "client_secret: abcd1234efgh5678", ["abcd1234efgh5678"]],
  ["env TOKEN", "api_token: abcd1234efgh5678", ["abcd1234efgh5678"]],
  ["env KEY", "SENTRY_KEY=abc123def456", ["abc123def456"]],
  ["env KEY_BASE", "secret_key_base: 4a8f3c2e1d0b9a8f7e6d5c4b3a2f1e0d", ["4a8f3c2e"]],
  ["aws config", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ["wJalrXUtnFEMI"]],
  ["aws env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ["wJalrXUtnFEMI"]],
  ["aws en contexte", "la clé secrète AWS vaut wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, ne la partage pas", ["wJalrXUtnFEMI"]],
  ["aws id", "AKIAIOSFODNN7EXAMPLE", ["AKIAIOSFODNN7EXAMPLE"]],
  ["valeur entre guillemets avec espaces", 'PASSWORD="correct horse battery staple"', ["correct", "horse", "staple"]],
  ["guillemets simples", "PASSWORD='p@ss w0rd'", ["p@ss", "w0rd"]],
  ["export", 'export DB_PASSWORD="correct horse battery staple"', ["horse"]],
  ["camelCase", "clientSecret: 'xyz12345'", ["xyz12345"]],
  ["flèche", "password => 'Ab12cd34'", ["Ab12cd34"]],
  ["valeur commençant par $", "PASSWORD=$ecret123", ["$ecret123"]],
  ["valeur commençant par xxx", "token: xxxSecret1", ["xxxSecret1"]],
  ["valeur « my_… » entre guillemets", 'password: "my_password_123"', ["my_password_123"]],
  ["JSON password", '{"password": "hunter2hunter2"}', ["hunter2"]],
  ["JSON token", '{"user": "hugo", "token": "abcdef123456"}', ["abcdef123456"]],
  [
    "compte de service GCP",
    '{"type": "service_account", "private_key_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n", "client_email": "bot@proj.iam.gserviceaccount.com"}',
    ["a1b2c3d4e5f6", "MIIEvQ", "bot@proj"],
  ],
  ["clé privée tronquée", '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', ["MIIEvQ"]],
  ["clé OpenSSH", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", ["b3BlbnNz"]],
  // en toutes lettres
  ["mot de passe en français", "le mot de passe ssh root est Azerty123! sur 51.15.12.34", ["Azerty123"]],
  ["mot de passe deux-points", "mot de passe : Boulange#42", ["Boulange"]],
  ["mdp", "mdp: Azerty123", ["Azerty123"]],
  ["mdp c'est", "le mdp c'est Fournil2026", ["Fournil2026"]],
  ["password:", "ssh root@51.15.12.34 password: Fournil2026!", ["Fournil2026"]],
  ["password is", "the password for the db is hunter22", ["hunter22"]],
  ["clé API en toutes lettres", "la clé API est 9f8e7d6c5b4a39281706f5e4d3c2b1a0", ["9f8e7d6c5b4a"]],
  [
    "phrase complète de la revue",
    "La connexion à la base de prod échoue avec db_password=Fournil2026! et aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY dans mon .env, le mot de passe ssh root est Azerty123! sur 51.15.12.34",
    ["Fournil2026", "wJalrXUtnFEMI", "Azerty123"],
  ],
  // formats de jetons
  ["anthropic", j("clé sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv"), ["sk-ant-api03"]],
  ["openai", j("sk-", "proj-abcdefghijklmnopqrstuvwxyz0123"), ["sk-proj-abc"]],
  ["github", j("ghp", "_abcdefghijklmnopqrstuvwxyz0123"), ["ghp_"]],
  ["github fin", j("github", "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"), ["github_pat_"]],
  ["gitlab", j("glpat", "-abcdefghijklmnopqrst"), ["glpat-"]],
  ["npm", j("npm", "_abcdefghijklmnopqrstuvwxyz0123456789"), ["npm_abc"]],
  ["huggingface", j("hf", "_abcdefghijklmnopqrstuvwxyzABCDEFGH"), ["hf_abc"]],
  ["sendgrid", j("SG", ".abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDE"), ["SG.abc"]],
  ["stripe", j("sk", "_live_abcdefghij1234567890"), ["sk_live_"]],
  ["stripe webhook", j("STRIPE_KEY=whsec", "_abcdefghijklmnopqrstuvwxyz123456"), ["whsec_"]],
  ["slack token", j("xox", "b-1234567890-abcdefghij"), ["xoxb-"]],
  ["webhook slack", j("https://hooks.slack.com/", "services/", "T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"), ["T00000000/B00000000"]],
  ["webhook discord", j("https://discord.com/api/", "webhooks/123456789012345678/", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"), ["abcdefghijklmnop"]],
  ["google", j("AIza", "SyA1234567890abcdefghijklmnopqrstu"), ["AIzaSy"]],
  ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", ["eyJzdWIi"]],
  ["jwt non signé", "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig", ["eyJzdWIi"]],
  // en-têtes HTTP
  ["Authorization Basic", "curl -H 'Authorization: Basic YWRtaW46cGFzc3dvcmQxMjM='", ["YWRtaW46"]],
  ["Authorization Bearer", "Authorization: Bearer abc123def456ghi789jkl", ["abc123def456"]],
  ["Basic seul", "le header vaut Basic YWRtaW46cGFzc3dvcmQxMjM=", ["YWRtaW46"]],
  ["x-api-key", "curl -H 'x-api-key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0'", ["9f8e7d6c"]],
  ["x-auth-token", "x-auth-token: 7c9e6679-7425-40de-944b-e07fc1f90ae7", ["7c9e6679"]],
  ["cookie", "Cookie: sid=s%3Aabc123def456; Path=/", ["abc123def456"]],
  ["bearer", "Bearer abcdefghijklmnop1234", ["abcdefghijklmnop1234"]],
  // ligne de commande
  ["--password", "brain.mjs init --password S3cret123", ["S3cret123"]],
  ["curl -u", "curl -u admin:S3cret! https://api.example.com", ["S3cret"]],
  // URL avec identifiants
  ["url", "postgres://admin:s3cret@db.example.com:5432/app", ["s3cret"]],
  ["url avec @ dans le mot de passe", "postgres://admin:p@ss@db:5432/x", ["p@ss", "ss@db"]],
  ["url avec / dans le mot de passe", "redis://default:ab/cd1234@redis:6379", ["ab/cd1234"]],
  ["url mongodb+srv", "mongodb+srv://user:Pa55word@cluster0.mongodb.net/db", ["Pa55word"]],
  ["url git", "git clone https://romain:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y", ["ghp_", "romain"]],
  ["url user avec @", "smtp://user@domain.com:p4ss@smtp.host:587", ["p4ss"]],
  // jeton du cerveau
  ["jeton cerveau", "mon jeton cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", ["tqoelDcQ"]],
  ["jeton cerveau JSON", '{"token": "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv"}', ["tqoelDcQ"]],
  ["jeton cerveau env", "BRAIN_TOKEN cb_abcdefghijklmnopqrstuvwxyz0123456789", ["abcdefghijklmnop"]],
  ["jeton cerveau token=", "token=cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", ["tqoelDcQ"]],
  // données personnelles
  ["email", "écris à jean.dupont@exemple.fr", ["jean.dupont"]],
  ["email +tag", "romain+test@gmail.com", ["romain+test"]],
  ["téléphone 06", "appelle-moi au 06 12 34 56 78", ["06 12 34"]],
  ["téléphone compact", "0612345678", ["0612345678"]],
  ["téléphone points", "06.12.34.56.78", ["06.12"]],
  ["téléphone +33", "+33 6 12 34 56 78", ["12 34 56"]],
  ["téléphone +33 (0)6", "tel +33 (0)6 12 34 56 78", ["12 34 56"]],
  ["téléphone 0033", "0033612345678", ["0033612345678"]],
  ["IBAN espacé", "IBAN FR76 3000 6000 0112 3456 7890 189", ["FR76 3000", "3456 7890"]],
  ["IBAN compact", "FR7630006000011234567890189", ["FR7630006"]],
  ["IBAN minuscules", "fr76 3000 6000 0112 3456 7890 189", ["fr76 3000"]],
  ["IBAN minuscules compact", "fr7630006000011234567890189", ["fr7630006"]],
  ["IBAN suivi d'un mot", "IBAN : FR76 3000 6000 0112 3456 7890 189 merci", ["3000 6000"]],
  ["IBAN mal recopié", "IBAN FR76 3000 6000 0112 3456 7890 1890 pour la paie", ["3000 6000"]],
  ["carte", "carte 4111 1111 1111 1111", ["4111 1111"]],
  ["carte compacte", "4111111111111111", ["4111111111111111"]],
  ["NIR", "1 85 05 78 006 084 36", ["006 084"]],
  ["NIR Corse 2A", "2 85 05 2A 006 084 36", ["006 084"]],
  ["NIR Corse 2b compact", "285052b00608436", ["00608436"]],
]

const MUST_KEEP = [
  "On part sur Stripe Billing pour gérer la proration.",
  "commit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 sur main",
  "git show 3f2a9c1",
  "uuid 550e8400-e29b-41d4-a716-446655440000",
  "request_id: 550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key: 550e8400-e29b-41d4-a716-446655440000",
  "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "timestamp 1697456789123 et 2026-10-16T08:00:00Z",
  "le 2026-10-16 à 09:00, ticket 123456",
  "Version 0.1.0 du 16/10/2026",
  "La facture n° 2026-0042 de 1 250,00 € est payée.",
  "le SIRET 732 829 320 00074 de la boulangerie",
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
  "claude -p 'résume la session'",
  "mkdir -p src/lib",
  "cb_on_message_received_handler()",
  "le jeton cb_… est stocké haché",
  "Le mot de passe est oublié, il faut le réinitialiser.",
  "Le mot de passe doit faire 12 caractères",
  "Le token est expiré depuis hier.",
  "Token : expiré depuis hier.",
  "Secret : une recette maison",
  "mdp oublié : procédure de réinitialisation",
  "Password: voir 1Password",
  "password is required",
  "password reset flow: envoyer un email",
  "le header Bearer est requis",
  "Basic configuration of the server",
  "Token management system for the internationalization",
  "La clé de cache est user-42.",
  "Il y a 3 décisions et 12 tâches ouvertes.",
  "On garde le prix actuel de 49 € HT.",
]

test("redact : chaque format de secret ou de donnée perso est masqué, et c'est idempotent", () => {
  const failures: string[] = []
  for (const [name, input, leaks] of MUST_MASK) {
    const r = redact(input)
    const leaked = leaks.filter((l) => r.text.includes(l))
    if (leaked.length) failures.push(`${name} : fuite de ${leaked.join(", ")} → ${r.text}`)
    if (Object.keys(r.redactions).length === 0) failures.push(`${name} : aucun masquage compté`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`${name} : non idempotent → ${again.text}`)
  }
  assert.deepEqual(failures, [])
})

test("redact : pas de faux positif sur les SHA, UUID, dates, montants, code et la prose", () => {
  const changed = MUST_KEEP.map((s) => [s, redactText(s)]).filter(([a, b]) => a !== b)
  assert.deepEqual(changed, [])
})

test("redact : le séparateur et les guillemets sont conservés", () => {
  assert.equal(redactText('PASSWORD="correct horse battery staple"'), 'PASSWORD="[masqué]"')
  assert.equal(redactText("db_password: Fournil2026!, ensuite"), "db_password: [masqué], ensuite")
  assert.equal(redactText("postgres://admin:p@ss@db:5432/x"), "postgres://[identifiants masqués]@db:5432/x")
})

test("redact : valeurs connues masquées telles quelles (jeton de la config)", () => {
  const r = redact("j'ai collé abcdefgh12345678 puis abcdefgh12345678", { literals: ["abcdefgh12345678", undefined, "court"] })
  assert.equal(r.text, "j'ai collé [secret masqué] puis [secret masqué]")
  assert.equal(r.redactions.literal, 2)
})

test("redact : reste rapide sur de longs textes sans séparateurs", () => {
  const t0 = Date.now()
  for (const blob of ["a.b-c_d".repeat(6000), "A".repeat(40000), "x=".repeat(20000), "mot de passe " + " x".repeat(20000), "https://u:" + "@".repeat(20000)]) redact(blob)
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`)
})

test("isSecretKey : noms de clés secrètes, sans les compteurs ni les types", () => {
  for (const k of ["DB_PASSWORD", "db_pass", "mdp", "mot_de_passe", "clientSecret", "x-api-key", "apiKey", "aws_secret_access_key", "private_key_id", "STRIPE_KEY", "csrfToken", "token", "SECRET_KEY_BASE"]) {
    assert.ok(isSecretKey(k), k)
  }
  for (const k of ["max_tokens", "tokenCount", "TOKEN_EXPIRY", "PASSWORD_HASH", "primary_key", "idempotency_key", "secretary", "bypass", "PWD", "key", "secret_name"]) {
    assert.ok(!isSecretKey(k), k)
  }
})

test("liste blanche d'apps : mots entiers, navigateurs seulement sur un vrai onglet IA", () => {
  const allowed: [string, string][] = [
    ["Terminal", "claude — ~/code/fournil"],
    ["Code", "messages.ts — fournil-api"],
    ["iTerm2", "node worker — signal handling"],
    ["Google Chrome", "Claude — Nouvelle conversation"],
    ["Google Chrome", "Migration Stripe - Claude"],
    ["Arc", "ChatGPT"],
    ["Firefox", "Le Chat - Mistral AI - Mozilla Firefox"],
  ]
  const rejected: [string, string][] = [
    ["Google Chrome", "Boursorama — Mes comptes"],
    ["Google Chrome", "Claude AI billing - Gmail"],
    ["Google Chrome", "Inbox (3) - romain@gmail.com - Gmail"],
    ["Safari", "Gemini Horoscope Today - Astrology.com"],
    ["Google Chrome", "Anthropic launches Claude 5 - The Verge"],
    ["Google Chrome", "Claude — Wikipédia"],
    ["WhatsApp", "Maman"],
    ["Messages", "Julie"],
    ["Signal", "Note to self"],
    ["Spotify", ""],
    ["Code", "WhatsApp Web"],
    ["Mail", "Boîte de réception"],
  ]
  for (const [a, w] of allowed) assert.ok(isAllowedApp(a, w), `${a} / ${w} devrait être accepté`)
  for (const [a, w] of rejected) assert.ok(!isAllowedApp(a, w), `${a} / ${w} devrait être refusé`)
  // URL de l'onglet (si Screenpipe la fournit) : elle fait foi.
  assert.ok(isAiBrowserWindow("Sans titre", "https://claude.ai/chat/123"))
  assert.ok(!isAiBrowserWindow("Claude — Nouvelle conversation", "https://mail.google.com/mail/u/0"))
  assert.ok(isAllowedApp("Google Chrome", "Nouvelle discussion", undefined, "https://chatgpt.com/c/abc"))
})

test("contenu personnel : sujets de vie privée détectés, séances de travail gardées", () => {
  const personal = [
    "Aide-moi à écrire un mail à mon médecin traitant : je suis en arrêt pour burn-out et dépression depuis lundi, et je dois aussi prévenir mon avocat pour le divorce.",
    "Mon code WhatsApp de vérification ne marche pas, ma copine Julie attend mon message sur WhatsApp",
    "Résume mes analyses de sang et l'ordonnance du psychiatre",
    "Compare les offres de mon prêt immobilier avec mon compte joint",
    "Trouve une série sur Netflix pour ce soir",
  ]
  const work = [
    "Les messages d'erreur du formulaire d'inscription sont en anglais. On a décidé de centraliser les messages dans fr.json.",
    "Le worker ne s'arrête pas proprement quand Docker envoie le signal SIGTERM, on ferme le pool Postgres avant de sortir.",
    "Intègre l'API WhatsApp Business pour envoyer les confirmations de commande depuis le backend.",
    "Ajoute un lien vers notre chaîne YouTube dans le footer du site, composant Footer du projet vitrine.",
    "Comment on déploie l'API en production ? Mon token est [secret masqué]",
    "Prépare la déclaration de TVA de septembre à partir de Pennylane",
    "L'app pilote l'enceinte connectée du magasin, et les ordonnances Macron changent le barème des indemnités.",
  ]
  for (const t of personal) assert.ok(looksPersonal(t), `perso non détecté : ${t}`)
  for (const t of work) assert.ok(!looksPersonal(t), `travail écarté à tort : ${t}`)
  const s = personalSignals(personal[0])
  assert.ok(s.strong.includes("burn-out") && s.strong.includes("divorce"), JSON.stringify(s))
})
