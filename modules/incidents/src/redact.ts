import { redactLogText } from "@jarvis/core";

/**
 * D-105 (UA-5 kriterium 1, §Q): kjøretids-redaksjon av driftslogger FØR persistering - operasjonelle logger (Docker container-utdata) er fritekst og strukturelt HØY risiko for hemmelighet-lekkasje (miljøvariabler echoet av en app,
 * en stack-trace som inneholder en Authorization-header, osv). Mønsterbasert (deterministisk), IKKE en LLM-basert klassifisering - gitleaks-skanning av selve repoet er en ANNEN, komplementær beskyttelse (denne funksjonen
 * beskytter RUNTIME-data, ikke kildekode).
 *
 * D-394 (JARVIS-069): den sentrale skanneren dekker flere formater enn de lokale mønstrene (JWT, private nøkler, Stripe/Slack/AWS/Google-nøkler, Telegram-token, passordfraser, kortnumre).
 * WP-SEC2 (K7d): de lokale mønstrene (`Bearer`, hele `Authorization:`-linjen, `ghp_`/`sk-ant-`, `NAVN=verdi`) bor nå ÉN gang i `redactLogText` (@jarvis/core, delt med `docker-transport.ts`), som alltid slutter med sentralen:
 * redaksjonen her er aldri svakere enn `scanForSecrets` (test: `wpsec2-redact-parity.test.ts`).
 */
export function redactSecrets(text: string): string {
  return redactLogText(text);
}
