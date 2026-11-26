/**
 * WP-SEC2: testfiksturer for hemmelighetsskanneren. INGEN ferdige nøkkelformer står i kildekoden: hvert token bygges SAMMENSATT ved kjøring (`["gh", "p_"].join("")` + en kropp), slik at hverken gitleaks eller en leser
 * av kilden ser en ekte nøkkelform. Kroppene er deterministiske, blandede base62-strenger (store/små bokstaver + sifre), ikke ekte nøkler. Usynlige tegn bygges av kodepunkter (aldri `\u`-escapes i kilden).
 */
const cp = (n: number): string => String.fromCodePoint(n);

export const HIDDEN = {
  zwsp: cp(0x200b), zwnj: cp(0x200c), zwj: cp(0x200d), wordJoiner: cp(0x2060), bom: cp(0xfeff), softHyphen: cp(0x00ad), rlo: cp(0x202e), lro: cp(0x202d), pdf: cp(0x202c), lri: cp(0x2066), pdi: cp(0x2069),
  tagA: cp(0xe0041), vs16: cp(0xfe0f), cgj: cp(0x034f), nul: cp(0), esc: cp(0x1b), acute: cp(0x0301), ring: cp(0x030a), nbsp: cp(0x00a0), ideographicSpace: cp(0x3000), nonBreakingHyphen: cp(0x2011), hangulFiller: cp(0x3164), arabicNumberSign: cp(0x0600), del: cp(0x7f), vt: cp(0x0b), ff: cp(0x0c)
} as const;

/** Blandet base62-kropp av ønsket lengde (deterministisk; store/små bokstaver og sifre, som en ekte tilfeldig kropp). */
export function body(length: number, seed = 0): string {
  const alphabet = "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0PaTnXeUiOqAzCvBhEjIkMlSw";
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += alphabet[(i * 7 + seed * 13 + Math.floor(i / alphabet.length)) % alphabet.length];
  return out;
}

/** ASCII til fullbreddeformer (`ghp_` -> `ｇｈｐ＿`). */
export function fullwidth(text: string): string {
  return [...text].map((c) => (c === " " ? c : c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e ? cp(c.charCodeAt(0) + 0xfee0) : c)).join("");
}

/** Setter `mark` inn etter tegn nr. `at` (0-basert) i `text`. */
export function insertAt(text: string, at: number, mark: string): string {
  return text.slice(0, at) + mark + text.slice(at);
}

/** `-----BEGIN PRIVATE KEY-----` bygges sammensatt, så ikke en gitleaks-regel for private nøkler treffer kildefilen. */
export const pemBegin = (label = "PRIVATE KEY"): string => ["-----", "BEGIN ", label, "-----"].join("");

export const pemEnd = (label = "PRIVATE KEY"): string => ["-----", "END ", label, "-----"].join("");

export const tok = {
  /** ghp_ + 36 tegn (typisk lengde, `unverified`). */
  github: (seed = 0): string => ["gh", "p_"].join("") + body(36, seed),
  githubX: (): string => ["gh", "p_"].join("") + "x".repeat(36),
  githubPat: (): string => ["github", "_pat_"].join("") + body(82, 3),
  anthropic: (): string => ["sk", "-ant-", "api03-"].join("") + body(60, 5),
  openai: (): string => ["sk", "-"].join("") + body(48, 2),
  openaiProject: (): string => ["sk", "-proj-"].join("") + body(64, 4),
  aws: (): string => ["AK", "IA"].join("") + "7Q3ZLM29XB4RT8WY",
  slack: (): string => ["xo", "xb-"].join("") + "123456789012-1234567890123-" + body(24, 6),
  stripe: (): string => ["sk", "_live_"].join("") + body(24, 1),
  jwt: (): string => ["ey", "Jhb", "GciOiJIUzI1NiJ9"].join("") + "." + ["ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ"].join("") + "." + body(43, 7),
  sendgrid: (): string => ["S", "G."].join("") + body(22, 8) + "." + body(43, 9),
  npm: (): string => ["np", "m_"].join("") + body(36, 4),
  gitlab: (): string => ["gl", "pat-"].join("") + body(20, 5),
  azureKey: (): string => body(86, 2) + "==",
  googleOauth: (): string => ["ya", "29."].join("") + body(60, 3),
  huggingface: (): string => ["h", "f_"].join("") + body(34, 6),
  /** En privat nøkkel-blokk (innholdet er ikke en ekte nøkkel). */
  pem: (lines = 3, label = "PRIVATE KEY"): string => `-----BEGIN ${label}-----\n${Array.from({ length: lines }, (_, i) => body(64, i)).join("\n")}\n-----END ${label}-----`
};
