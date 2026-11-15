import { scanForSecrets } from "@jarvis/core";

/**
 * WP-I (D-472), review M2: ALL tekst kittet og scoringen sender ut (detail, subjects, evidens) går gjennom denne. Den redigerer hemmelighetsformer (den sentrale skanneren, `scanForSecrets` - ÉN skanner, ingen egne
 * mønstre) og kjente literaler (credential-kanarifuglen adapteren oppgir) - også når verdien kommer fra adapteren (feilkode, handlingsnøkkel, helsetilstand) eller fra et manifest kittet fikk uvalidert.
 * Grense: kun det den sentrale skanneren kjenner igjen (kjente token-formater, URL-passord, NAVN=verdi ...), jf. skannerens egen kommentar - den er ikke en garanti mot alle hemmeligheter.
 */
export function redactText(text: string, literals: readonly string[] = []): string {
  let t = text;
  for (const lit of literals) if (lit.length >= 8) t = t.split(lit).join("[REDACTED:credential]");
  return scanForSecrets(t).text;
}

/** Meldingsteksten til noe som ble kastet (aldri `undefined`, uansett hva som ble kastet: `Error`, streng, objekt). Råtekst - redigeres av kalleren FØR den kuttes (review N4). */
export function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  const m = typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined;
  return typeof m === "string" ? m : "";
}

/**
 * Review N4: NAVN og KODE for et unntak - aldri meldingsteksten. En feil kan sitere en verdi (en sti, tredjepartstekst, et argument til en fake-fabrikk), og et token er ikke alltid en form skanneren kjenner. CLI-ene
 * (`scripts/report.ts`) viser derfor bare `Navn (KODE)`, hver del først slipt gjennom en streng allowlist (feilnavn: bokstaver/tall; kode: STORE bokstaver, tall, `_`) og så den sentrale redigeringen (`redactText`).
 */
export function errorLabel(e: unknown): string {
  const rawName = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  const name = typeof rawName === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawName) ? rawName : "Error";
  const rawCode = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(rawCode) ? rawCode : null;
  return redactText(code === null ? name : `${name} (${code})`);
}
