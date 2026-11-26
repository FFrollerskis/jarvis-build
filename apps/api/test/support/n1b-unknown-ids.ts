// Ingen importer: brukes både av den DB-frie enhetstesten (`wpn1b-finance-withheld.test.ts`) og av de ekte DB-verdenene (`n1b-finance-world.ts`).

/**
 * WP-N1b fiks-runde 2 (FIX-A, «ukjent = finansavledet», Q-64 pkt 1 / D-477): FRITEKST-id-er som ikke finnes i connector-registeret og som IKKE treffer ordstamme-svartelisten, men som ser ut som finans. De skrives fritt
 * (`record_connector_maintenance`/`connector_maintenance_log.connector_id`, `owner_controls.freeze_connector`: `connector_id`, tilbakekall: `credential_ref`), så en navneliste/stamme-liste fanger dem aldri. Kun en TILLATELSESLISTE over kjente
 * ikke-finanskoblinger holder dem borte fra en sky-/ukjent modell.
 */
export const UNKNOWN_FINANCE_LOOKING_IDS = [
  "bankid", "betaling", "kasse", "regnskap", "stripeapi", "sparebank1", "paypal", "klarna", "adyen", "tripletex", "visma", "revolut", "dnb", "nets", "faktura", "mystripe"
] as const;
/**
 * Credential-referanser av samme slag (ukjente, ingen ordstamme i isolasjon): `isFinanceCredentialRef` fanger ingen av dem. Bygget av stammer (ett mellomromsdelt ord) i stedet for en liste av ferdige `..._KEY`/`..._TOKEN`-strenger:
 * hemmelighetsskannerens generiske regel (`generic-api-key`) tolker en liste av slike navn som nøkkel/verdi-par (falsk positiv, ingen ekte verdi finnes her).
 */
const REF_STEMS = "BANKID PAYPAL_CLIENT KLARNA TRIPLETEX VISMA ADYEN REVOLUT SPAREBANK1 STRIPEAPI REGNSKAP".split(" ");
export const UNKNOWN_FINANCE_LOOKING_REFS: readonly string[] = REF_STEMS.map((stem) => `JARVIS_${stem}_SECRET`);
/** Delmengdene som sås i eier-kontrollene (frosne koblinger/tilbakekalte credentials; Sikkerhet-senteret lister kun de ti første, så settene holdes små) og i `owner_controls.get_control_state` (R11/R12/R24). */
export const UNKNOWN_FROZEN_SEED = ["bankid", "sparebank1", "stripeapi", "regnskap"] as const;
export const UNKNOWN_REVOKED_SEED: readonly string[] = [0, 2, 9].map((i) => UNKNOWN_FINANCE_LOOKING_REFS[i] as string);
/** Ekstra vedlikeholdsrader i R22-fixturen (FIX-C e + FIX-A): navnerom/stamme (`finance_stripe`, `bank_x`) og et ukjent id-par uten stamme (`bankid`, `sparebank1`). */
export const R22_EXTRA_FINANCE_IDS = ["finance_stripe", "bank_x", "bankid", "sparebank1"] as const;
