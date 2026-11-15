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
