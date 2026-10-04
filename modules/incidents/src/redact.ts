import { scanForSecrets } from "@jarvis/core";

/**
 * D-105 (UA-5 kriterium 1, §Q): kjøretids-redaksjon av driftslogger FØR
 * persistering - operasjonelle logger (Docker container-utdata) er
 * fritekst og strukturelt HØY risiko for hemmelighet-lekkasje (miljøvariabler
 * echoet av en app, en stack-trace som inneholder en Authorization-header,
 * osv). Mønsterbasert (deterministisk), IKKE en LLM-basert klassifisering -
 * gitleaks-skanning av selve repoet er en ANNEN, komplementær beskyttelse
 * (denne funksjonen beskytter RUNTIME-data, ikke kildekode).
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { re: /Authorization:\s*.*/gi, replacement: "Authorization: [REDACTED]" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { re: /sk-ant-[A-Za-z0-9\-_]{10,}/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  // Generisk `NAVN=verdi`/`NAVN: verdi` der NAVN ser ut som en hemmelighet -
  // KUN verdien redigeres, navnet bevares (nyttig for diagnose: "TOKEN var satt").
  {
    re: /((?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*)(\S+)/gi,
    replacement: "$1[REDACTED]"
  }
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { re, replacement } of PATTERNS) {
    result = result.replace(re, replacement);
  }
  // D-394 (JARVIS-069): den sentrale skanneren (Del 3) dekker flere formater enn de fire lokale mønstrene (JWT, private nøkler, Stripe/Slack/AWS/
  // Google-nøkler, Telegram-token, passordfraser, kortnumre) - alle driftslogger og fritekst-evidens går gjennom BEGGE.
  return scanForSecrets(result).text;
}
