import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OperationalGateChangedPayloadSchema, type GateStatus, type OperationalGateChangedPayload } from "./gate-events.ts";
import { evaluateGate, evaluateOrl, GateSchema, makeGateContext, OrlSchema, type Gate, type Orl } from "./gates.ts";
import { evidenceWeaknesses, parseEvidenceDetails, parseEvidenceHeader, type EvidenceHeader, type EvidenceWeakness } from "./evidence-header.ts";
import { loadProgramData, isInsideRoot, makeFileReader, PROGRAM_DIR, ProgramDataError } from "./fs-loader.ts";
import { acquireLock, replaceFileAtomically } from "./file-lock.ts";
import { canonicalJson, contractFingerprint, normalizeLineEndings, sha256Hex } from "./hash.ts";
import { serializeData } from "./index-builder.ts";
import { EvidenceRefSchema, type EvidenceRef } from "./schema.ts";

/**
 * WP-PGA / PG3 (PGA-D-08): REGISTRERING av en overgang for en programport eller et ORL-nivå. Den eneste skrivende stien for port-/nivådata (ved siden av `fingerprint-tool.ts` for komponent-
 * skjerver). Registreringen lager en `OperationalGateChanged`-nyttelast, legger den til historikken (append-only) og oppdaterer `status`/`evidence_ref` i ÉN fil (atomisk: midlertidig fil + rename).
 *
 * Registreringen nekter (heller enn å skrive noe som umiddelbart ville vært foreldet eller ugyldig): ukjent port, uendret status, PASS/FAIL uten evidens, evidens utenfor `docs/evidence/`, symlenke eller
 * for stor evidensfil, evidens som er ELDRE enn en bundet komponents siste kontraktendring, bundne komponenter hvis fingeravtrykk ikke er à jour, og ORL-PASS der en forutsetning ikke står som PASS nå.
 * En PASS som er blitt foreldet gjenåpnes først (`OPEN`) og registreres så på nytt med ny evidens: to forståelige overganger i historikken, ikke en stille overskriving.
 *
 * Evidensfilen er UBETRODD tekst: kun den faste toppteksten (før «## Utdata») leses for tidspunkt, git-SHA, exit-kode, stdin-merking og ekstern-markør; resten hashes, aldri tolkes.
 *
 * M2 (fiks 1): en PASS krever at evidensen viser en kommando som LYKTES og som opptakeren selv KJØRTE. Evidens med exit ≠ 0 (eller drept), uten gjenkjennelig exit-linje eller pipet inn via `--stdin`
 * nektes for PASS (FAIL og OPEN er uberørt). `verified_at` (flagget) kan aldri være senere enn toppteksttiden og aldri i fremtiden. En `external: true`-port krever en markør for ekstern kilde eller
 * dokumentert eier-bekreftelse i evidensens merknad. `by` er en SELVRAPPORTERT rolle-etikett, ikke autentisert: git-historikken og denne vakten er hele sporbarheten.
 */
export const RECORD_PROBLEMS = [
  "gate_unknown",
  "data_invalid",
  "status_unchanged",
  "evidence_required",
  "evidence_not_allowed_for_open",
  "evidence_path_invalid",
  "evidence_missing",
  "evidence_not_regular_file",
  "evidence_too_large",
  "evidence_time_invalid",
  "evidence_in_future",
  "git_sha_unavailable",
  "time_before_last_change",
  "bound_component_unknown",
  "contract_fingerprint_outdated",
  "evidence_older_than_contract_change",
  "prerequisite_not_pass",
  "reason_invalid",
  "evidence_from_stdin",
  "evidence_exit_not_zero",
  "evidence_exit_unknown",
  "external_confirmation_required",
  "verified_at_after_evidence",
  "concurrent_registration",
  "result_invalid"
] as const;
export type RecordProblem = (typeof RECORD_PROBLEMS)[number];

export interface RecordGateInput {
  root: string;
  /** `G01`-`G17` eller `ORL0`-`ORL5`. */
  gate_id: string;
  /** Ny status. `OPEN` = gjenåpning (ingen evidens). */
  status: GateStatus;
  /** `docs/evidence/<fil>.md` (påkrevd for PASS/FAIL, ikke tillatt for OPEN). */
  evidence_path: string | null;
  reason: string;
  /** Rollen som registrerer overgangen (aldri et personnavn). */
  by: "owner" | "platform_operator";
  /** Registreringstidspunkt (ISO). Injiseres så testene er deterministiske. */
  now: string;
  /** Overstyrer tidspunktet evidensen ble til (kilde `flag`). Utelatt: toppteksten i evidensfilen, ellers registreringstidspunktet. */
  verified_at?: string | null;
  /** Git-SHA til arbeidstreet nå (brukes kun når evidensfilen ikke har en egen). */
  git_sha: string | null;
  write: boolean;
  /** KUN for testene: kalles rett før den endelige re-lesingen, så en test kan late som en annen skriver rørte filen etter at vi leste (aldri satt i produksjon). */
  _before_commit?: () => void;
}

export type RecordGateResult =
  | { ok: true; gate_id: string; prior_status: GateStatus; new_status: GateStatus; payload: OperationalGateChangedPayload; evidence_ref: EvidenceRef | null; warnings: string[]; weaknesses: EvidenceWeakness[]; written: boolean }
  | { ok: false; problem: RecordProblem; detail: string };

const MAX_EVIDENCE_BYTES = 1_000_000;
const EVIDENCE_PATH = /^docs\/evidence\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// Toppteksten leses av `evidence-header.ts` (ren modul, delt med skanningen); re-eksportert her så eksisterende importer virker.
export { parseEvidenceHeader, type EvidenceHeader };

const fail = (problem: RecordProblem, detail: string): RecordGateResult => ({ ok: false, problem, detail });

const GATE_OR_ORL_ID = /^(?:G(?:0[1-9]|1[0-7])|ORL[0-5])$/;

/** Port-/nivåfilen slik den står NÅ, som kanonisk JSON (for re-lesingen rett før rename); null hvis den mangler eller er ugyldig. */
function readCanonical(file: string, isOrl: boolean): string | null {
  try {
    const parsed = (isOrl ? OrlSchema : GateSchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? canonicalJson(parsed.data) : null;
  } catch {
    return null;
  }
}

/* eslint-disable no-control-regex -- kontroll- og retningstegn er hele poenget med denne renseren (samme valg som `sanitize` i ops/acceptance/record-evidence.mjs). */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;
const EXOTIC_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Kontrolltegn, bredde-null-tegn, retningstegn (bidi: U+202A-202E og U+2066-2069), myk bindestrek og Mongolsk vokalskille: ingenting av dette skal stå skjult i en committet begrunnelse. */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

/**
 * Begrunnelsen havner i en committet fil i et offentlig repo (porthistorikken): linjeskift flettes til ETT mellomrom, eksotiske mellomrom blir vanlige, og kontrolltegn, usynlige tegn og
 * retningstegn (som kan snu visningen av teksten) FJERNES. Samme tegnsett som `sanitize` i evidens-opptakeren, pluss retningstegnene (L1).
 */
export function cleanReason(raw: string): string {
  return raw.replace(LINE_BREAKS, " ").replace(EXOTIC_SPACES, " ").replace(INVISIBLE, "").trim();
}

export function recordGate(input: RecordGateInput): RecordGateResult {
  if (!ISO_INSTANT.test(input.now) || !Number.isFinite(Date.parse(input.now))) return fail("evidence_time_invalid", "now er ikke et gyldig UTC-tidspunkt");
  const reason = cleanReason(input.reason);
  if (reason.length < 3 || reason.length > 200) return fail("reason_invalid", "begrunnelsen må være 3-200 tegn (etter at kontrolltegn og usynlige tegn er fjernet)");
  // Id-en bygges inn i en lås- og filsti: kun nøyaktig G01-G17/ORL0-ORL5 slipper videre (aldri ukontrollert tekst i en sti).
  if (!GATE_OR_ORL_ID.test(input.gate_id)) return fail("gate_unknown", `${input.gate_id} er ikke en port (G01-G17) eller et nivå (ORL0-ORL5)`);
  if (!input.write) return recordGateCore(input, reason, false);

  // Skriving: eksklusiv lås per port (M1). Hele lese-vurder-skriv-sekvensen skjer under låsen, så en samtidig registrering enten nektes eller ser vårt resultat.
  const lock = acquireLock(join(input.root, PROGRAM_DIR, `.${input.gate_id}.lock`));
  if (!lock.ok) return lock.reason === "held" ? fail("concurrent_registration", `${input.gate_id}: ${lock.detail}; vent til den er ferdig og prøv på nytt`) : fail("data_invalid", `${PROGRAM_DIR} er ikke tilgjengelig: ${lock.detail}`);
  try {
    return recordGateCore(input, reason, lock.took_over_stale);
  } finally {
    lock.release();
  }
}

function recordGateCore(input: RecordGateInput, reason: string, tookOverStaleLock: boolean): RecordGateResult {
  let data;
  try {
    data = loadProgramData(input.root);
  } catch (err) {
    if (err instanceof ProgramDataError) return fail("data_invalid", err.message);
    throw err;
  }
  const isOrl = /^ORL[0-5]$/.test(input.gate_id);
  const target: Gate | Orl | undefined = isOrl ? data.orls.find((o) => o.id === input.gate_id) : data.gates.find((g) => g.id === input.gate_id);
  if (target === undefined) return fail("gate_unknown", `${input.gate_id} finnes ikke (eller filen er ugyldig) i ${PROGRAM_DIR}/${isOrl ? "orl" : "gates"}`);

  const prior = target.status;
  if (input.status === prior) return fail("status_unchanged", `${input.gate_id} står allerede som ${prior}; en overgang må endre status (en foreldet PASS gjenåpnes først med OPEN)`);
  const last = target.history[target.history.length - 1];
  if (last !== undefined && Date.parse(input.now) < Date.parse(last.changed_at)) return fail("time_before_last_change", `registreringen ligger før siste overgang (${last.changed_at})`);

  const reader = makeFileReader(input.root);
  const warnings: string[] = [];
  if (tookOverStaleLock) warnings.push("en foreldet lås (eldre enn 60 s, fra en avbrutt registrering) ble overtatt");
  let evidence: EvidenceRef | null = null;
  /** Svakhetene ved evidensen for en PASS som likevel ble godtatt (tidspunkt/SHA mangler, uren arbeidstre): skanningen flagger dem som gate_weak_evidence. */
  let weaknesses: EvidenceWeakness[] = [];

  if (input.status === "OPEN") {
    if (input.evidence_path !== null) return fail("evidence_not_allowed_for_open", "en gjenåpning (OPEN) har ingen evidens");
  } else {
    if (input.evidence_path === null) return fail("evidence_required", `${input.status} krever en evidensfil (docs/evidence/<fil>.md)`);
    const path = input.evidence_path;
    if (!EVIDENCE_PATH.test(path)) return fail("evidence_path_invalid", "evidensstien må være docs/evidence/<navn>.md (kun bokstaver, tall, punktum, understrek og bindestrek)");
    const abs = join(input.root, path);
    let size: number;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) return fail("evidence_not_regular_file", "evidensen er ikke en vanlig fil (symlenker avvises)");
      if (!isInsideRoot(input.root, abs)) return fail("evidence_not_regular_file", "evidensen ligger utenfor repoet (en symlenket mellomkatalog peker ut av det)");
      size = st.size;
    } catch {
      return fail("evidence_missing", `${path} finnes ikke`);
    }
    if (size > MAX_EVIDENCE_BYTES) return fail("evidence_too_large", `evidensfilen er over ${MAX_EVIDENCE_BYTES} byte`);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return fail("evidence_missing", `${path} kunne ikke leses`);
    }
    const sha256 = sha256Hex(normalizeLineEndings(text));
    const header = parseEvidenceHeader(text);
    const details = parseEvidenceDetails(text);
    if (input.status === "PASS") {
      // M2: en PASS krever evidens fra en kommando som LYKTES og som opptakeren selv KJØRTE. FAIL kan registreres med hvilken som helst evidens (en feilet kjøring ER evidens), og OPEN har ingen.
      if (details.from_stdin) return fail("evidence_from_stdin", "evidensen er innlimt utdata (--stdin): opptakeren kjørte ingenting og kan ikke bevise at noe lyktes; kjør kommandoen med record-evidence.mjs (en FAIL kan registreres med innlimt evidens, en PASS ikke)");
      if (details.exit_kind === "abnormal") return fail("evidence_exit_not_zero", `kommandoen i evidensen ble drept (tidsavbrudd eller signal, exit ${details.exit_code}): en PASS krever exit 0`);
      if (details.exit_kind === "code" && details.exit_code !== 0) return fail("evidence_exit_not_zero", `kommandoen i evidensen avsluttet med exit ${details.exit_code}: en PASS krever exit 0 (registrer FAIL, eller ta evidensen på nytt når kommandoen lykkes)`);
      if (details.exit_kind === "missing" || details.exit_kind === "unrecognized") return fail("evidence_exit_unknown", "evidensen har ingen entydig «Exit:»-linje i toppteksten: en PASS krever en evidensfil fra record-evidence.mjs som viser exit 0");
      if (target.external && details.external_source === null) {
        return fail("external_confirmation_required", `${input.gate_id} krever en ekstern kilde (NAS-kjøring, pilot eller eier-signoff): ta evidensen med --note "ekstern-kilde: <hva og hvor>" eller "eier-bekreftet: <hva>". Merk at «by» er en selvrapportert etikett, ikke autentisert`);
      }
    }

    let verifiedAt: string;
    let source: EvidenceRef["verified_at_source"];
    if (input.verified_at !== undefined && input.verified_at !== null) {
      if (!ISO_INSTANT.test(input.verified_at) || !Number.isFinite(Date.parse(input.verified_at))) return fail("evidence_time_invalid", "verified_at er ikke et gyldig UTC-tidspunkt");
      verifiedAt = new Date(Date.parse(input.verified_at)).toISOString();
      source = "flag";
    } else if (header.recorded_time !== null) {
      verifiedAt = header.recorded_time;
      source = "evidence_header";
    } else {
      verifiedAt = new Date(Date.parse(input.now)).toISOString();
      source = "registration_time";
      warnings.push("evidensfilen har ingen gjenkjennelig topptekst med tidspunkt: verified_at er satt til registreringstidspunktet (svakere bevis)");
    }
    if (Date.parse(verifiedAt) > Date.parse(input.now)) return fail("evidence_in_future", "evidensen er datert etter registreringstidspunktet");
    if (source === "flag") {
      // --verified-at kan aldri gjøre evidensen NYERE enn filen selv sier (ellers omgår den «evidens eldre enn kontraktendringen»): høyst toppteksttiden.
      if (header.recorded_time === null) return fail("verified_at_after_evidence", "evidensfilen har ingen tidsangivelse i toppteksten, så --verified-at har ingenting å begrenses mot");
      if (Date.parse(verifiedAt) > Date.parse(header.recorded_time)) return fail("verified_at_after_evidence", `--verified-at (${verifiedAt}) kan ikke være senere enn tidspunktet i evidensens topptekst (${header.recorded_time})`);
    }

    const gitSha = header.git_sha ?? input.git_sha;
    if (gitSha === null || !/^[0-9a-f]{40}$/.test(gitSha)) return fail("git_sha_unavailable", "fant ingen git-SHA (hverken i evidensfilen eller fra arbeidstreet)");
    if (header.git_sha === null) warnings.push("evidensfilen oppgir ingen git-SHA: SHA-en til arbeidstreet ved registrering er brukt");
    if (header.dirty) warnings.push("evidensen er tatt på et arbeidstre med ucommittede endringer eller ukjent git-status (svakere bevis)");
    if (input.status === "PASS") weaknesses = evidenceWeaknesses({ ...header, ...details }, { external: target.external, verified_at: verifiedAt });

    const fingerprints: Record<string, string | null> = {};
    for (const id of [...target.bound_components].sort()) {
      const comp = data.components.find((c) => c.component_id === id);
      if (comp === undefined) return fail("bound_component_unknown", `${input.gate_id} er bundet til ${id}, som ikke finnes i indeksen`);
      // Fingeravtrykket i skjerven skal tilsvare filene NÅ: ellers ville øyeblikksbildet i evidensen låse en utdatert verdi.
      if (comp.contract.files.length > 0) {
        const hashes = comp.contract.files.map((f) => ({ path: f, sha256: reader.file_sha256(f) }));
        if (hashes.some((h) => h.sha256 === null) || contractFingerprint(hashes.map((h) => ({ path: h.path, sha256: h.sha256 as string }))) !== comp.contract.fingerprint) {
          return fail("contract_fingerprint_outdated", `${id}: kontraktfilene er endret uten at fingeravtrykket er oppdatert (kjør «fingerprint ${id} --write» først)`);
        }
      }
      if (comp.contract.changed_at !== null && Date.parse(comp.contract.changed_at) > Date.parse(verifiedAt)) {
        return fail("evidence_older_than_contract_change", `${id}: kontrakten er endret ${comp.contract.changed_at}, etter at evidensen ble til (${verifiedAt}); ta evidensen på nytt`);
      }
      fingerprints[id] = comp.contract.fingerprint;
    }
    const candidate = { path, sha256, git_sha: gitSha, recorded_at: new Date(Date.parse(input.now)).toISOString(), verified_at: verifiedAt, verified_at_source: source, contract_fingerprints: fingerprints };
    const parsed = EvidenceRefSchema.safeParse(candidate);
    if (!parsed.success) return fail("result_invalid", `evidensreferansen er ugyldig: ${parsed.error.issues[0]?.message ?? "ukjent"}`);
    evidence = parsed.data;
  }

  // ORL-PASS: forutsetningene (porter og forrige nivå) må stå som PASS NÅ (effektivt), ellers ville registreringen vært ugyldig fra første sekund.
  const ctx = makeGateContext(data.components, reader);
  if (isOrl && input.status === "PASS") {
    const orl = target as Orl;
    const gateEffective = new Map(data.gates.map((g) => [g.id, evaluateGate(g, ctx).effective]));
    const orlEffective = new Map<string, GateStatus>();
    for (const o of [...data.orls].sort((a, b) => a.level - b.level)) orlEffective.set(o.id, evaluateOrl(o, ctx, (id) => gateEffective.get(id) ?? "OPEN", (id) => orlEffective.get(id) ?? "OPEN").effective);
    const missing = [...orl.requires_gates.filter((g) => gateEffective.get(g) !== "PASS"), ...(orl.requires_orl !== null && orlEffective.get(orl.requires_orl) !== "PASS" ? [orl.requires_orl] : [])];
    if (missing.length > 0) return fail("prerequisite_not_pass", `${orl.id} krever at disse står som PASS først: ${missing.join(", ")}`);
  }

  const payloadParsed = OperationalGateChangedPayloadSchema.safeParse({
    gate_kind: isOrl ? "orl" : "program_gate",
    gate_id: input.gate_id,
    prior_status: prior,
    new_status: input.status,
    evidence_refs: evidence === null ? [] : [evidence],
    owner: input.by,
    changed_at: new Date(Date.parse(input.now)).toISOString(),
    reason
  });
  if (!payloadParsed.success) return fail("result_invalid", `overgangen er ugyldig: ${payloadParsed.error.issues[0]?.message ?? "ukjent"}`);
  const payload = payloadParsed.data;

  const next = { ...target, status: input.status, evidence_ref: evidence, history: [...target.history, payload] };
  const valid = isOrl ? OrlSchema.safeParse(next) : GateSchema.safeParse(next);
  if (!valid.success) return fail("result_invalid", `resultatet er ikke en gyldig ${isOrl ? "ORL" : "port"}-fil: ${valid.error.issues[0]?.message ?? "ukjent"}`);

  let written = false;
  if (input.write) {
    const dir = join(input.root, PROGRAM_DIR, isOrl ? "orl" : "gates");
    const file = join(dir, `${input.gate_id}.json`);
    const tmp = join(dir, `.${input.gate_id}.json.tmp-${process.pid}`);
    // Re-lesing rett før rename: er port-filen fortsatt nøyaktig slik vi leste den? Ellers har en annen skriver rørt den, og vi skriver ikke over den (tapt oppdatering).
    const before = canonicalJson(target);
    const outcome = replaceFileAtomically({
      file,
      tmp,
      text: serializeData(valid.data),
      unchanged: () => {
        input._before_commit?.();
        return readCanonical(file, isOrl) === before;
      }
    });
    if (outcome === "tmp_exists") return fail("concurrent_registration", `${input.gate_id}: en midlertidig fil finnes allerede (en annen, eller en avbrutt, skriving); fjern den og prøv på nytt`);
    if (outcome === "changed_since_read") return fail("concurrent_registration", `${input.gate_id}: port-filen ble endret av en annen mens registreringen pågikk; ingenting er skrevet, prøv på nytt`);
    written = true;
  }
  return { ok: true, gate_id: input.gate_id, prior_status: prior, new_status: input.status, payload, evidence_ref: evidence, warnings, weaknesses, written };
}
