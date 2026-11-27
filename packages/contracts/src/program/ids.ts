/**
 * WP-PGA / PG1: identifikator-mønstre for programindeksen. Én kilde, brukt av skjemaene, skanningen og CLI-en (feilkode-registeret holder en bevisst kopi av komponent-id-mønsteret
 * så det kan ligge i barrelen uten å dra inn programmodulen; en test sjekker at de to er like).
 * Alle mønstre er forankret med ^ og $ (JS `$` uten m-flagg matcher ikke før et avsluttende linjeskift), og ingen har nøstede ubegrensede kvantorer.
 */

/** `<familie>.<navn>[.<navn>...]`: små bokstaver, tall og bindestrek (ikke først/sist i et ledd). */
export const COMPONENT_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
/** MAJOR.MINOR.PATCH uten ledende nuller, prerelease eller build; høyst seks sifre per del (trygt innenfor Number). */
export const SEMVER = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
export const GIT_SHA = /^[0-9a-f]{40}$/;
/** Repo-relativ sti: ingen absolutt rot, ingen `..`-ledd, ingen backslash/blank/kolon. */
export const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/;
/** Postgres-tabellnavn slik repoet bruker dem (små bokstaver, tall, understrek). */
export const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
/** Hendelsestype: PascalCase-kontrakt (`TaskCompleted`) eller snake_case (`council_result`), evt. med punktum. */
export const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_.]{1,80}$/;
/** Beslutningsreferanse: `D-<tall>` i repoets beslutningslogg, eller en plan-intern id (planens egne, f.eks. `D-PROG-07` i HF6 §24 og `D-CI-24`) som ikke finnes i loggen. Byggerens egne forslag bruker prefikset `PGA-D-` (ikke samme navnerom). */
export const D_REF = /^D-(?:\d{1,4}|[A-Z]{2,5}-\d{2})$/;
/** Et repo-nummerert beslutningsrad-id (`D-497`): kun disse sjekkes mot beslutningsloggen. */
export const LOG_D_REF = /^D-\d{1,4}$/;
