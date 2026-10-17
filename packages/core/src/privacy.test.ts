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
  ["aws id", j("AKIA", "IOSFODNN7EXAMPLE"), ["IOSFODNN7EXAMPLE"]],
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
  ["url git", j("git clone https://romain:ghp", "_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y"), ["ghp_", "romain"]],
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
  ["NIR", "1 85 05 78 006 084 91", ["006 084"]],
  ["NIR clé fausse mais annoncé", "mon n° de sécu : 1 85 05 78 006 084 36", ["006 084"]],
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
  assert.ok(s.strong.includes("medecin traitant") && s.strong.includes("divorce") && s.weak.includes("burn-out"), JSON.stringify(s))
})

// --- Deuxième passe de revue -------------------------------------------------------------------------------------------

// Variantes qui fuyaient encore (sonde verify-core/p1.ts) : [cas, texte, fragments qui ne doivent plus apparaître].
const MUST_MASK_R2: [string, string, string[]][] = [
  // paramètres d'URL
  ["url ?api_key=", "curl https://api.fournil.fr/v1/export?api_key=Fk29xLmQ7pWzT4&format=csv", ["Fk29xLmQ7pWzT4"]],
  ["url &access_token=", "url: https://x.fr/cb?access_token=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url &token=", "https://api.fournil.fr/v1/export?format=csv&token=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url ?key=", "https://maps.example.com/api?key=Zt81kQmv02Lx&lang=fr", ["Zt81kQmv02Lx"]],
  ["url &secret=", "https://x.fr/hook?id=12&secret=Hk2mVq81pZt", ["Hk2mVq81pZt"]],
  ["url &pwd=", "curl -X POST https://api.fournil.fr/login?login=admin&pwd=Fournil2026", ["Fournil2026"]],
  ["url &password=", "jdbc:postgresql://db.internal:5432/prod?user=admin&password=Fournil2026", ["Fournil2026"]],
  ["url &sig=", "https://cdn.fournil.fr/f.pdf?exp=1700000000&sig=a8Fk2LmQ9zXw", ["a8Fk2LmQ9zXw"]],
  // paires collées, flèche, langues
  ["paires sans espace", "{user:admin,password:Fournil2026}", ["Fournil2026"]],
  ["chaîne de connexion", "Server=tcp:sql.fournil.fr;Database=prod;User Id=sa;Password=Fournil2026;", ["Fournil2026"]],
  ["flèche ->", "password -> Fournil2026", ["Fournil2026"]],
  ["pw:", "pw: hunter22", ["hunter22"]],
  ["Passwort", "Passwort: Fournil2026", ["Fournil2026"]],
  ["contraseña", "contraseña: Fournil2026", ["Fournil2026"]],
  ["cookie avec attributs", "Cookie: session=S3cr3tPass99xyzABCDEF; other=1", ["S3cr3tPass99xyz"]],
  // en toutes lettres, sans séparateur
  ["mot de passe sans séparateur", "avec le mot de passe Fournil2026! ça passe", ["Fournil2026"]],
  ["login / mot de passe", "login admin / mot de passe Fournil2026", ["Fournil2026"]],
  ["MDP sans séparateur", "MDP Fournil2026", ["Fournil2026"]],
  ["tâche de la revue", "changer le mot de passe Soleil2026! du back-office", ["Soleil2026"]],
  ["mot de passe root", "le mot de passe root S3cret!42 marche", ["S3cret!42"]],
  ["identifiants paire", "identifiants : admin / Fournil2026!", ["Fournil2026"]],
  ["guillemets français avec espace", "mot de passe : « Fournil 2026 »", ["Fournil", "2026"]],
  ["mot simple après est", "Le mot de passe du wifi est soleilvert", ["soleilvert"]],
  ["code PIN", "Mon code PIN est 4589", ["4589"]],
  // code et ligne de commande
  ["redis-cli -a", "redis-cli -a Fournil2026 ping", ["Fournil2026"]],
  ["mysql -p collé", "mysql -u root -pFournil2026 prod", ["Fournil2026"]],
  ["sshpass -p", "sshpass -p Fournil2026 ssh root@51.15.12.34", ["Fournil2026"]],
  ["docker login -p", "docker login -u ci -p Fournil2026 registry.fournil.fr", ["Fournil2026"]],
  ["auth python", "requests.get(url, auth=('admin', 'Fournil2026'))", ["Fournil2026"]],
  ["auth attribut", "client.auth = ('admin', 'Fournil2026')", ["Fournil2026"]],
  ["HTTPBasicAuth", 'HTTPBasicAuth("admin", "Fournil2026")', ["Fournil2026"]],
  ["XML", "<password>Fournil2026</password>", ["Fournil2026"]],
  ["XML préfixé", "<db:password>Fournil2026</db:password>", ["Fournil2026"]],
  // formats sans contexte
  ["clé AWS seule", j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"), ["wJalrXUtnFEMI"]],
  ["jeton cerveau minuscules", j("cb_", "abcdefghijklmnopqrstuvwxyzabcdef"), ["abcdefghijklmnop"]],
]

// Prose et code ordinaires que la première passe abîmait (sonde verify-core/fp.ts) : doivent rester lisibles.
const MUST_KEEP_R2 = [
  "Le mot de passe est obligatoire",
  "le champ password est obligatoire",
  "password: min 12 caractères, une majuscule",
  "password_reset_token: uuid NOT NULL",
  "Le token : JWT signé HS256",
  "Authorization: header manquant dans la requête",
  "authorization: required",
  "Authorization: Bearer <token>",
  "Le secret : communiquer tôt avec le client",
  "const user = { email, password: hashedPassword, role }",
  "headers: { Authorization: 'Bearer ' + token }",
  "cookie: req.headers.cookie",
  "Le mot de passe est incorrect",
  "Le mot de passe est expiré",
  "mot de passe : 8 caractères minimum",
  "Le mot de passe est stocké hashé avec bcrypt",
  "The password is hashed with Argon2id",
  "le mot de passe hashé en SHA-256",
  "mot de passe Wi-Fi de la boutique",
  "changer le mot de passe tous les 90 jours",
  "Le code PIN est obligatoire",
  "STRIPE_SECRET_KEY=sk_test_...",
  "secret_key_base: <%= ENV['SECRET_KEY_BASE'] %>",
  "password=getpass.getpass()",
  "Le lot 2 85 05 78 006 084 36 est livré",
  "Commande n°4970101234567890 du 12/10",
  "https://www.fournil.fr/recherche?q=token&page=2",
  "https://api.fournil.fr/v1/export?format=csv&limit=100",
  "mysql -u root -p prod",
  "mkdir -p src/lib && ssh -p 2222 deploy@51.15.12.34",
  "redis-cli ping",
  "identifiants lecture / écriture",
  "accès : admin / lecture",
  "<title>Mot de passe oublié</title>",
  "{user:admin,role:editor}",
]

test("redact (2e passe) : variantes de secrets masquées, idempotent", () => {
  const failures: string[] = []
  for (const [name, input, leaks] of MUST_MASK_R2) {
    const r = redact(input)
    const leaked = leaks.filter((l) => r.text.includes(l))
    if (leaked.length) failures.push(`${name} : fuite de ${leaked.join(", ")} → ${r.text}`)
    if (Object.keys(r.redactions).length === 0) failures.push(`${name} : aucun masquage compté`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`${name} : non idempotent → ${again.text}`)
  }
  assert.deepEqual(failures, [])
})

test("redact (2e passe) : les mots ordinaires après « mot de passe », « token : », « Authorization: » restent lisibles", () => {
  const changed = MUST_KEEP_R2.map((s) => [s, redactText(s)]).filter(([a, b]) => a !== b)
  assert.deepEqual(changed, [])
})

test("redact (2e passe) : la paire suivante n'est pas avalée et le reste de l'URL est gardé", () => {
  assert.equal(redactText("https://x.fr/export?api_key=Fk29xLmQ7pWzT4&format=csv"), "https://x.fr/export?api_key=[masqué]&format=csv")
  assert.equal(redactText("{user:admin,password:Fournil2026}"), "{user:admin,password:[masqué]}")
  assert.equal(redactText("mot de passe : « Fournil 2026 »"), "mot de passe : « [masqué] »")
  assert.equal(redactText("identifiants : admin / Fournil2026!"), "identifiants : admin / [masqué]")
})

// Sessions entières (sondes verify-core/p6.ts, p6b.ts, p6c.ts).
const MUST_DROP = [
  "Mon code d'accès Boursorama ne marche plus, mon numéro client est 12345678, aide-moi à appeler la banque",
  "Explique-moi ce prélèvement sur mon relevé Boursorama, code client 12345678",
  "Aide-moi à écrire à mon ostéopathe pour décaler mon rendez-vous",
  "J'ai un rendez-vous chez le dentiste demain pour une carie, rédige un mail d'excuse",
  "Mes résultats d'IRM montrent une hernie discale, que dois-je demander au rhumatologue ?",
  "On m'a diagnostiqué un cancer, comment l'annoncer à mon équipe ?",
  "Je suis diabétique, quel régime pour ma glycémie ?",
  "J'ai été hospitalisé aux urgences hier, rédige un message à mon manager",
  "Mon traitement contre l'hypertension me fatigue",
  "Aide-moi à écrire un message à mon mec pour ce soir",
  "Ma petite amie veut qu'on emménage ensemble, comment gérer le budget ?",
  "Le juge aux affaires familiales a fixé l'audience",
  "Comment contester ma contravention pour excès de vitesse ?",
  "Rédige une lettre de résiliation de mon bail",
  "Mon crédit immo chez la Banque Populaire",
  "J'ai rendez-vous chez mon kiné",
  "Je suis enceinte de 3 mois, comment l'annoncer à mon manager ?",
  "Dépistage VIH : où aller ?",
  "Mon fils a de la fièvre",
  "Mon père veut que je l'aide à choisir une maison de retraite",
  "Je suis en arrêt maladie depuis lundi, préviens le client que le projet aura du retard",
  "Mon PEL et mon assurance vie",
  "Ma mutuelle rembourse mal mes lunettes",
]
const MUST_KEEP_WORK = [
  "Fais le rapprochement de mon compte bancaire Qonto avec Pennylane pour septembre et liste les écarts",
  "Exporte les relevés de mon compte bancaire pro et prépare la TVA",
  "Léo est en arrêt maladie du 3 au 10 octobre : calcule les IJSS et la subrogation dans la paie",
  "Prépare l'arrêt maladie de Léo dans la paie d'octobre (Payfit)",
  "Calcule la retenue à la source pour la paie de Léo, qui est en arrêt maladie depuis lundi",
  "Comment déclarer l'arrêt de travail d'un salarié dans la DSN ?",
  "Le salarié est en arrêt de travail, comment le déclarer à l'URSSAF ?",
  "Comment gérer un salarié en burn-out ? Process RH",
  "Mettre à jour la mutuelle Alan des salariés pour la paie",
  "Mon père est le fondateur de la boulangerie et il veut un bilan",
  "Mon père et moi sommes associés dans la boulangerie, prépare le pacte d'associés",
  "Créer une campagne Facebook Ads pour le lancement du produit",
  "Analyser les performances de notre chaîne YouTube",
  "Mettre en place un pixel Facebook et un tag Google Analytics sur le site",
  "Ajouter Instagram comme canal de vente",
  "Intégrer YouTube dans la page produit",
  "Notre client Doctolib veut une démo de l'intégration",
  "Le client veut recevoir ses factures sur WhatsApp",
  "La fonction divorce() de la lib de dates",
  "Rédige la politique de congé maternité et congé paternité pour le handbook RH",
  "Léo est malade et en arrêt maladie : mets à jour la paie et la DSN",
  "Prépare une campagne Instagram et Facebook Ads pour le lancement de la brioche de Noël. Budget de 600 €, audience lookalike, 3 visuels carrousel.",
]

test("contenu personnel (2e passe) : banque perso et santé écartées, paie, compta et entreprise familiale gardées", () => {
  const kept = MUST_DROP.filter((t) => !looksPersonal(t)).map((t) => `${t} ${JSON.stringify(personalSignals(t))}`)
  const dropped = MUST_KEEP_WORK.filter((t) => looksPersonal(t)).map((t) => `${t} ${JSON.stringify(personalSignals(t))}`)
  assert.deepEqual({ kept, dropped }, { kept: [], dropped: [] })
  // Une banque grand public + « code client » / « numéro client » : ces mots ne sont pas du vocabulaire de travail.
  assert.equal(personalSignals(MUST_DROP[0]).work, 0)
})

test("liste blanche (2e passe) : un nom d'app dans un nom de fichier n'est pas l'app", () => {
  assert.ok(isAllowedApp("Code", "whatsapp-webhook.ts — fournil-api"))
  assert.ok(isAllowedApp("Terminal", "ssh boursorama-export"))
  assert.ok(!isAllowedApp("Code", "WhatsApp Web"))
  assert.ok(!isAllowedApp("Google Chrome", "WhatsApp - Discussions"))
})

// --- Troisième passe de revue ------------------------------------------------------------------------------------------

test("redact (3e passe) : linéaire, même sur une longue ligne de JSON minifié qui cite mongo / mysql / redis-cli", () => {
  // Sondes r2-verify-core/perf.ts et perf2.ts : 4,8 s à 320 Ko avant le correctif (balayage paresseux jusqu'à la fin de ligne).
  const json = "[" + Array.from({ length: 4000 }, (_, i) => `{"service":"mongo","host":"mongo-${i}.internal","db":"mysql","cache":"redis-cli"}`).join(",") + "]"
  assert.ok(json.length > 300_000)
  redact(json.slice(0, 20_000)) // échauffement
  const best = (s: string) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now()
    redact(s)
    return performance.now() - t0
  }))
  const ms = best(json)
  assert.ok(ms < 100, `JSON minifié de ${Math.round(json.length / 1024)} Ko : ${ms.toFixed(0)} ms`)
  // Chaque mot-clé répété sur 320 Ko : coût borné par occurrence (pas de quadratique).
  const slow: string[] = []
  for (const unit of ["mongo ", "mysql ", "mysql -u root ", "redis-cli ", "docker login ", "sqlcmd ", j("-----BEGIN PRIV", "ATE KEY-----"), "http://a:", "mot de passe est ", "token "]) {
    const s = unit.repeat(Math.ceil(320_000 / unit.length))
    const t = best(s)
    if (t > 400) slow.push(`${JSON.stringify(unit)} : ${t.toFixed(0)} ms`)
  }
  assert.deepEqual(slow, [])
  // Le balayage borné garde les vrais cas.
  assert.equal(redactText("mysql -h db.internal -P 3306 -u root --ssl-mode=REQUIRED -pFournil2026 prod"), "mysql -h db.internal -P 3306 -u root --ssl-mode=REQUIRED -p[masqué] prod")
  assert.equal(redactText("mongo -u admin -p Fournil2026"), "mongo -u admin -p [masqué]")
  assert.equal(redactText(j("-----BEGIN PRIV", "ATE KEY-----\nMIIEvQ\n-----END PRIV", "ATE KEY----- puis la suite")), "[clé privée masquée] puis la suite")
})

// Séparateur « est : » (sonde r2-verify-core/leak2.ts, et e2e : « (le mot de passe est : Fournil2026) » envoyé tel quel).
const MUST_MASK_R3: [string, string, string[]][] = [
  ["est :", "Le mot de passe est : Fournil2026", ["Fournil2026"]],
  ["est:", "le mot de passe est: Fournil2026", ["Fournil2026"]],
  ["c'est :", "Le mot de passe c'est : Fournil2026", ["Fournil2026"]],
  ["c’est : typographique", "Le mot de passe c’est : Fournil2026", ["Fournil2026"]],
  ["mdp est :", "Le mdp est : Fournil2026", ["Fournil2026"]],
  ["is:", "the password is: Fournil2026", ["Fournil2026"]],
  ["is :", "The password is : Fournil2026", ["Fournil2026"]],
  ["clé API est :", "La clé API est : S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["qualificatif puis est :", "Le mot de passe de la prod est : Fournil2026!", ["Fournil2026"]],
  ["entre parenthèses", "TODO: se connecter au back-office avec l'identifiant admin (le mot de passe est : Fournil2026) et relancer l'export", ["Fournil2026"]],
  ["flèche", "mot de passe → Fournil2026", ["Fournil2026"]],
  ["flèche longue", "Mot de passe —> Fournil2026", ["Fournil2026"]],
  ["long détour avant est", "le mot de passe pour se connecter au serveur de production en SSH est Fournil2026", ["Fournil2026"]],
  ["PIN :", "PIN : 4589", ["4589"]],
  ["qualificatif sans séparateur", "mot de passe provisoire Fournil2026", ["Fournil2026"]],
  ["url ?sid=", "https://x.fr/?sid=S3cr3tPass99xyz", ["S3cr3tPass99xyz"]],
  ["url ?token= mot long", "https://x.fr/reset?token=abcdefghijklmnop", ["abcdefghijklmnop"]],
  ["clé passw", "passw: Fournil2026", ["Fournil2026"]],
]

// Texte d'interface, docs et URL ordinaires que la 2e passe masquait (sondes r2-verify-core/one.ts et keep.ts).
const MUST_KEEP_R3 = [
  "Mot de passe oublié?",
  "Mot de passe incorrect!",
  "toast('Mot de passe modifié!')",
  "Erreur : mot de passe invalide!",
  "Le mot de passe est incorrect!",
  "Le mot de passe est encodé en base64",
  "Le mot de passe est stocké dans 1Password",
  "Le mot de passe du compte Office365",
  "réinitialise le mot de passe sur Windows 11",
  "réinitialise le mot de passe sur Windows11",
  "Le mot de passe expire en Q4-2026",
  "mot de passe WPA2-PSK",
  "le mot de passe est : voir le coffre",
  "?sort=asc&key=created_at",
  "https://example.com/?auth=google",
  "https://example.com/?pass=true",
  "https://example.com/?secret=false",
  "https://example.com/docs?key=value",
  "https://example.com/?sig=abc",
  "https://app.fournil.fr/admin?tab=tokens&key=name",
  "identifiants : SIRET / TVA",
  "Logins : Google / Microsoft",
  "credentials: 'include'",
  "fetch(url, { credentials: 'same-origin' })",
  "token: uuid",
  "password: hashed",
  "Authorization: Bearer YOUR_TOKEN",
  "Le code PIN est obligatoire",
]

test("redact (3e passe) : « est : », « c'est : », « is: » et les flèches comme séparateurs ; idempotent", () => {
  const failures: string[] = []
  for (const [name, input, leaks] of MUST_MASK_R3) {
    const r = redact(input)
    const leaked = leaks.filter((l) => r.text.includes(l))
    if (leaked.length) failures.push(`${name} : fuite de ${leaked.join(", ")} → ${r.text}`)
    const again = redact(r.text)
    if (again.text !== r.text || Object.keys(again.redactions).length) failures.push(`${name} : non idempotent → ${again.text}`)
  }
  assert.deepEqual(failures, [])
  assert.equal(redactText("Le mot de passe est : Fournil2026"), "Le mot de passe est : [masqué]")
  assert.equal(redactText("La clé API est : S3cr3tPass99xyz"), "La clé API est : [masqué]")
})

test("redact (3e passe) : un mot ordinaire n'est pas un secret (« oublié? », « 1Password », « ?key=created_at », « SIRET / TVA »)", () => {
  const changed = MUST_KEEP_R3.map((s) => [s, redactText(s)]).filter(([a, b]) => a !== b)
  assert.deepEqual(changed, [])
  // Les valeurs qui ressemblent à des secrets restent masquées dans ces mêmes tournures.
  assert.equal(redactText("changer le mot de passe Soleil2026! du back-office"), "changer le mot de passe [masqué] du back-office")
  assert.equal(redactText("https://x.fr/?key=Zt81kQmv02Lx&lang=fr"), "https://x.fr/?key=[masqué]&lang=fr")
  assert.equal(redactText("identifiants : admin / Fournil2026!"), "identifiants : admin / [masqué]")
})

// Sessions entières (sonde r2-verify-core/pers.ts et e2e/out.txt).
const MUST_DROP_R3 = [
  "Comment contester un prélèvement sur mon compte courant à la BNP ? Ils m'ont débité 89 € deux fois.",
  "Mon compte Boursorama est bloqué, j'ai un virement à faire pour le projet de rénovation de la maison avec le devis de l'artisan",
  "Comment calculer la pension alimentaire pour mes enfants ?",
]
const MUST_KEEP_WORK_R3 = [
  "Saisie sur salaire pour pension alimentaire : comment l'appliquer dans la paie de Léo",
  "Organise la visite d'embauche chez le médecin du travail pour les deux nouveaux salariés",
  "Prépare mon rendez-vous avec mon conseiller bancaire pour le prêt de la boulangerie (bilan, prévisionnel)",
  "Exporte le relevé de mon compte Qonto pour le comptable",
]

test("contenu personnel (3e passe) : compte courant et banque perso écartés ; saisie sur salaire et médecin du travail gardés", () => {
  const kept = MUST_DROP_R3.filter((t) => !looksPersonal(t)).map((t) => `${t} ${JSON.stringify(personalSignals(t))}`)
  const dropped = [...MUST_KEEP_WORK_R3, ...MUST_KEEP_WORK].filter((t) => looksPersonal(t)).map((t) => `${t} ${JSON.stringify(personalSignals(t))}`)
  assert.deepEqual({ kept, dropped }, { kept: [], dropped: [] })
  // Les sessions perso de la 2e passe restent écartées.
  assert.deepEqual(MUST_DROP.filter((t) => !looksPersonal(t)), [])
  // « chez le médecin » (le sien) reste un sujet de vie privée.
  assert.ok(looksPersonal("J'ai rendez-vous chez le médecin demain, décale ma réunion client"))
})
