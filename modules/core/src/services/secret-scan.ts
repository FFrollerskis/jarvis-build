/**
 * Del 3 (JARVIS-013/005): deterministisk hemmelighetsdeteksjon + redigering FØR tekst lagres (messages, minne, audit) eller sendes til en
 * modell/leverandør. Mønsterbasert (ingen LLM) og bevisst høy-presisjon: kjente token-formater, private nøkler, `NAVN=verdi` der navnet
 * ser ut som en hemmelighet, «passord er …»-fraser og kortnumre (Luhn). Kun VERDIEN fjernes; typen rapporteres (aldri innholdet).
 * Dette er ikke en garanti mot alle hemmeligheter - uregistrerte formater slipper gjennom - men ingen kjent kategori lagres lenger.
 */
export interface SecretFinding {
  kind: string;
  count: number;
}

export interface SecretScanResult {
  /** Teksten med hver funnet hemmelighet erstattet av `[REDACTED:<type>]`. */
  text: string;
  findings: SecretFinding[];
}

const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp; group?: number }> = [
  { kind: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { kind: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "enrollment_ticket", re: /\benr_[A-Za-z0-9_-]{30,}\b/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // `NAVN=verdi` / `NAVN: verdi` der NAVN ser ut som en hemmelighet - kun verdien fjernes.
  // Gjennomgang av WP-A (D-451): prefikset/suffikset er BEGRENSET (`{0,64}`). Uten tak er `[A-Za-z0-9_.-]*` + `\b` kvadratisk på lange tekster uten nøkkelord (bindestrek/punktum gir ordgrense overalt): 64 KB «a.b.…» tok 5 s og
  // 500 KB «lege-…» 143 s per klassifisering. Et variabelnavn med mer enn 64 tegn rundt nøkkelordet finnes ikke i praksis, og et treff midt i et langt navn redigerer fortsatt verdien.
  { kind: "named_secret", re: /\b([A-Za-z0-9_.-]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]{0,64}\s*[:=]\s*["']?)([^\s"']{6,})/gi, group: 2 },
  // Miljøvariabel-stil med KEY i navnet (STORE BOKSTAVER, så «monkey=...» ikke treffer): INFISICAL_ENCRYPTION_KEY=..., AWS_KEY_ID=...
  { kind: "named_secret", re: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_KEY|KEY_[A-Z0-9_]+)\s*[:=]\s*["']?)([^\s"']{6,})/g, group: 2 },
  // Naturlig språk (norsk/engelsk): «passordet mitt er X», «password: X», «pin-kode er 1234». Gjennomgang av WP-A (D-451): også bestemte former («PIN-koden er …») og BankID-/engangskoder - de ble klassifisert
  // som hemmelighet (Q-52 A) men aldri redigert bort, så koden ble lagret.
  { kind: "spoken_password", re: /\b(?:passord(?:et)?(?:\s+mitt)?|password|pin(?:-?kode[a-zæøå]*)?|bankid-?kode[a-zæøå]*|engangskode[a-zæøå]*|kodeord(?:et)?)(?:\s+(?:min|mi|mitt|di|ditt|din|vår))?\s*(?:er|is|[:=])\s*["']?([^\s"',.;]{4,})/gi, group: 1 }
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function scanForSecrets(input: string): SecretScanResult {
  let text = input;
  const counts = new Map<string, number>();
  const bump = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);

  for (const { kind, re, group } of PATTERNS) {
    text = text.replace(re, (...args: unknown[]) => {
      const match = args[0] as string;
      if (group === undefined) {
        bump(kind);
        return `[REDACTED:${kind}]`;
      }
      const value = args[group] as string;
      // Allerede redigert (f.eks. av et tidligere mønster) - ikke tell to ganger.
      if (value.startsWith("[REDACTED")) return match;
      bump(kind);
      return match.slice(0, match.length - value.length) + `[REDACTED:${kind}]`;
    });
  }

  // Kortnumre: 13-19 sifre (med mellomrom/bindestrek) som består Luhn.
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    bump("card_number");
    return "[REDACTED:card_number]";
  });

  return { text, findings: [...counts.entries()].map(([kind, count]) => ({ kind, count })) };
}

export function containsSecret(input: string): boolean {
  return scanForSecrets(input).findings.length > 0;
}

/** Kort, menneskelig beskrivelse av funnene (kun typer - aldri verdier). */
export function describeSecretFindings(findings: SecretFinding[]): string {
  return findings.map((f) => (f.count > 1 ? `${f.kind} ×${f.count}` : f.kind)).join(", ");
}
