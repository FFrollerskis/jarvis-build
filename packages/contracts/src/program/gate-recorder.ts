import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OperationalGateChangedPayloadSchema, type GateStatus, type OperationalGateChangedPayload } from "./gate-events.ts";
import { evaluateGate, evaluateOrl, GateSchema, makeGateContext, OrlSchema, type Gate, type Orl } from "./gates.ts";
import { loadProgramData, makeFileReader, PROGRAM_DIR, ProgramDataError } from "./fs-loader.ts";
import { contractFingerprint, normalizeLineEndings, sha256Hex } from "./hash.ts";
import { serializeData } from "./index-builder.ts";
import { EvidenceRefSchema, type EvidenceRef } from "./schema.ts";

/**
 * WP-PGA / PG3 (D-PROG-08): REGISTRERING av en overgang for en programport eller et ORL-nivå. Den eneste skrivende stien for port-/nivådata (ved siden av `fingerprint-tool.ts` for komponent-
 * skjerver). Registreringen lager en `OperationalGateChanged`-nyttelast, legger den til historikken (append-only) og oppdaterer `status`/`evidence_ref` i ÉN fil (atomisk: midlertidig fil + rename).
 *
 * Registreringen nekter (heller enn å skrive noe som umiddelbart ville vært foreldet eller ugyldig): ukjent port, uendret status, PASS/FAIL uten evidens, evidens utenfor `docs/evidence/`, symlenke eller
 * for stor evidensfil, evidens som er ELDRE enn en bundet komponents siste kontraktendring, bundne komponenter hvis fingeravtrykk ikke er à jour, og ORL-PASS der en forutsetning ikke står som PASS nå.
 * En PASS som er blitt foreldet gjenåpnes først (`OPEN`) og registreres så på nytt med ny evidens: to forståelige overganger i historikken, ikke en stille overskriving.
 *
 * Evidensfilen er UBETRODD tekst: kun den faste toppteksten (før «## Utdata») leses for tidspunkt og git-SHA; resten hashes, aldri tolkes.
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
}

export type RecordGateResult =
  | { ok: true; gate_id: string; prior_status: GateStatus; new_status: GateStatus; payload: OperationalGateChangedPayload; evidence_ref: EvidenceRef | null; warnings: string[]; written: boolean }
  | { ok: false; problem: RecordProblem; detail: string };

const MAX_EVIDENCE_BYTES = 1_000_000;
const EVIDENCE_PATH = /^docs\/evidence\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TIME_LINE = /^- \*\*Tidspunkt \(UTC\):\*\* (\S+)\s*$/;
const GIT_LINE = /^- \*\*Git:\*\* `([0-9a-f]{40})`(.*)$/;

export interface EvidenceHeader {
  recorded_time: string | null;
  git_sha: string | null;
  /** Evidensen er tatt på et arbeidstre med ucommittede endringer (svakere bevis). */
  dirty: boolean;
}

/** Leser KUN den faste toppteksten (til «## Utdata», høyst 30 linjer): utdataene under er ubetrodd og leses aldri for verdier. */
export function parseEvidenceHeader(text: string): EvidenceHeader {
  const lines = normalizeLineEndings(text).split("\n");
  const end = lines.findIndex((l) => l.startsWith("## Utdata"));
  const header = lines.slice(0, Math.min(end === -1 ? 30 : end, 30));
  let recorded: string | null = null;
  let sha: string | null = null;
  let dirty = false;
  for (const line of header) {
    const t = TIME_LINE.exec(line);
    if (t !== null && recorded === null && ISO_INSTANT.test(t[1] as string) && Number.isFinite(Date.parse(t[1] as string))) recorded = new Date(Date.parse(t[1] as string)).toISOString();
    const g = GIT_LINE.exec(line);
    if (g !== null && sha === null) {
      sha = g[1] as string;
      dirty = /ucommittede endringer|git-status ukjent/.test(g[2] as string);
    }
  }
  return { recorded_time: recorded, git_sha: sha, dirty };
}

const fail = (problem: RecordProblem, detail: string): RecordGateResult => ({ ok: false, problem, detail });

export function recordGate(input: RecordGateInput): RecordGateResult {
  if (!ISO_INSTANT.test(input.now) || !Number.isFinite(Date.parse(input.now))) return fail("evidence_time_invalid", "now er ikke et gyldig UTC-tidspunkt");
  const reason = input.reason.replace(/[\r\n]+/g, " ").trim();
  if (reason.length < 3 || reason.length > 200) return fail("reason_invalid", "begrunnelsen må være 3-200 tegn");

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
  let evidence: EvidenceRef | null = null;

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

    const gitSha = header.git_sha ?? input.git_sha;
    if (gitSha === null || !/^[0-9a-f]{40}$/.test(gitSha)) return fail("git_sha_unavailable", "fant ingen git-SHA (hverken i evidensfilen eller fra arbeidstreet)");
    if (header.git_sha === null) warnings.push("evidensfilen oppgir ingen git-SHA: SHA-en til arbeidstreet ved registrering er brukt");
    if (header.dirty) warnings.push("evidensen er tatt på et arbeidstre med ucommittede endringer eller ukjent git-status (svakere bevis)");

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
  const ctx = makeGateContext(data.components, reader.file_sha256);
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
    writeFileSync(tmp, serializeData(valid.data), { flag: "wx" });
    renameSync(tmp, file);
    written = true;
  }
  return { ok: true, gate_id: input.gate_id, prior_status: prior, new_status: input.status, payload, evidence_ref: evidence, warnings, written };
}
