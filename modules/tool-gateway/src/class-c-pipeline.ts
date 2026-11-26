/**
 * WP-AUTH2a (JARVIS-014): deterministisk behandling av klasse C - «utfør autonomt, men med bevis». Klasse C har ingen godkjenningsport (CLAUDE.md regel 11: A-D styrer HVORDAN en handling utføres, aldri OM eieren har
 * kapabiliteten); i stedet håndhever gatewayen en fast kjede i kode, aldri i en prompt og aldri med en modell i beslutningene:
 *
 *   1. mål-/kapabilitetsbevis: ren validering av parametrene (`adapter.validate`, ingen I/O);
 *   2. preflight: fersk tilstandslesing via EKSISTERENDE lese-handlinger i samme connector + en deterministisk vurdering (`adapter.before.judge`);
 *   3. FØR-snapshot (normalisert, hvitelistet, sladdet);
 *   4. utførelsen (uendret - transporten og ledgeren er de samme som før);
 *   5. ETTER-readback via samme lese-handlinger, ETTER-snapshot;
 *   6. deterministisk diff mot FORVENTET diff (`adapter.expect`): uventede endringer og brudd er `mismatch`, en readback som ikke lot seg lese er `unverified`;
 *   7. rollback-plan (kompenserende handling eller manuell prosedyre) registrert med en stabil referanse (`rollback_ref`) - planen UTFØRES aldri av pipelinen;
 *   8. forsterket audit: ett `class_c`-objekt i revisjonsraden (modus, preflight, før/etter, diff, forventning, verdikt, rollback, `request_digest`-feltet).
 *
 * MODUS (`JARVIS_CLASS_C_PIPELINE`): `off` (standard) = pipelinen finnes ikke og gatewayen er byte-lik main. `observe` = alt kjøres og registreres, men INGENTING blokkeres og ingen status endres («ville blokkert» står i audit).
 * `enforce` = et preflight-avslag blokkerer FØR noe reserveres/utføres, og en etterkontroll som ikke bekrefter forventet diff gir `unverified` (aldri suksess; ledger-raden kan ikke retry-es med samme nøkkel).
 *
 * FAIL-LUKKET: en lesing som feiler, tidsavbrytes eller mangler, en adapter som kaster og et uleselig svar er aldri «greit». Under `enforce` blokkerer de (preflight) eller gir `unverified` (etterkontroll); under `observe` registreres de.
 * UKJENT UTFALL er `unverified`/UKJENT, aldri FAILED; ingen automatisk retry av bivirkninger (pipelinen gjør kun LESINGER, og selve mutasjonen kjøres av gatewayen akkurat én gang).
 *
 * EIER-OVERSTYRING er uendret og kommer FØRST: global pause, frys og tilbakekalt credential avgjøres av gatewayen/policyen før pipelinen starter og sjekkes på nytt rett før utførelsen (se `ToolGateway`). Pipelinen er aldri en ny barriere
 * for eierens egne kontrollhandlinger: adaptere for kill switch, selvgjenoppretting og `owner_controls`-/«pause/frys/tilbakekall»-handlinger NEKTES ved oppsett (`class_c_adapter_forbidden`), og `begin()` gir aldri en kjøring for dem.
 *
 * LEVERANDØRFAKTA: adaptere bruker KUN felt som EKSISTERENDE lese-handlinger allerede returnerer (se transportene). Det som ikke kan leses (f.eks. verdien til en hemmelig variabel) står i `unobservable` og påstås aldri.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@jarvis/contracts";
import { isSelfRecoveryAction } from "@jarvis/policy";
import { isClassDExempt, isNotFoundError } from "./class-d-pipeline.ts";
import type { ToolDefinition } from "./gateway.ts";
import { redactVendorText } from "./vendor-text.ts";

export type ClassCMode = "off" | "observe" | "enforce";
export const CLASS_C_PIPELINE_FLAG = "JARVIS_CLASS_C_PIPELINE";
/** Øvre frist for én lesing i pipelinen (gatewayen bruker `min(timeout_ms, dette)`); en hengende lesing skal aldri holde en mutasjon for alltid. */
export const CLASS_C_READ_TIMEOUT_MS = 10_000;

/** `off` ved manglende/tom/ukjent verdi (flagg AV er standard); `invalid` er sann for en ikke-tom verdi som ikke er off/observe/enforce, slik at oppstarten kan logge en skrivefeil høyt. */
export function parseClassCMode(raw: string | undefined | null): { mode: ClassCMode; invalid: boolean } {
  if (raw === undefined || raw === null) return { mode: "off", invalid: false };
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "off") return { mode: "off", invalid: false };
  if (value === "observe" || value === "enforce") return { mode: value, invalid: false };
  return { mode: "off", invalid: true };
}

type JsonObject = Record<string, JsonValue>;

/** En lesing som pipelinen kjører via transporten (alltid en EKSISTERENDE lese-handling). `optional`: en feilet lesing blokkerer ikke og er ikke «uverifisert» (kun opplysende). */
export interface ClassCRead {
  id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  optional?: boolean;
}

export type ClassCReadResult =
  | { ok: true; data: JsonValue | null; external_id: string | null }
  | { ok: false; error: string; timed_out: boolean; not_found: boolean };
export type ClassCReads = Readonly<Record<string, ClassCReadResult>>;

/** Gatewayens lesefunksjon: kaller transporten med SAMME credential/kontekst som mutasjonen og med en frist (kontrakt: kaster ved feil/tidsavbrudd, aldri henger). */
export type ClassCReadFn = (action: string, parameters: Record<string, JsonValue>) => Promise<{ external_id?: string; data?: JsonValue }>;

export interface ClassCMutation { external_id: string | null; data: JsonValue | null }

/** `state` sammenlignes (diff + forventninger); `context` er kun bevis (aldri sammenlignet). Nøkler i `state` er `[A-Za-z0-9_-]+` (stier skilles med punktum). */
export interface ClassCSnapshot { state: JsonObject; context: JsonObject }

export type ClassCExpectation =
  | { path: string; op: "equals"; value: JsonValue }
  | { path: string; op: "unchanged" }
  | { path: string; op: "changed" }
  | { path: string; op: "present" }
  | { path: string; op: "absent" }
  /** Effekten på `path` kan ikke observeres med eksisterende lesinger (i denne tilstanden): verdiktet kan aldri bli `verified` - det blir `unverified` (aldri en stille suksess), med `reason` i audit. */
  | { path: string; op: "unobservable"; reason: string };

export interface ClassCRollbackStep { tool_id: string; action: string; parameters: Record<string, JsonValue> }
export interface ClassCRollbackDraft {
  /** `compensating_action` = trinnene kan utføres via registrerte verktøy; `manual` = prosedyre i `note`; `none` = ingenting ble endret. */
  kind: "compensating_action" | "manual" | "none";
  steps: ClassCRollbackStep[];
  note: string;
}

export interface ClassCAdapter {
  /** `tool_id.action`. */
  readonly key: string;
  /** Mål-/kapabilitetsbevis: ren validering uten I/O. `null` = gyldig, ellers en kort, stabil årsakskode. */
  validate(parameters: Record<string, JsonValue>): string | null;
  readonly before: {
    reads(parameters: Record<string, JsonValue>): ClassCRead[];
    /** Deterministisk vurdering av den ferske tilstanden. Kalles kun når alle ikke-valgfrie lesinger lyktes. `block` = årsakskode som blokkerer (enforce), `warnings` blokkerer aldri. */
    judge(parameters: Record<string, JsonValue>, reads: ClassCReads): { block: string | null; warnings?: string[] };
    snapshot(parameters: Record<string, JsonValue>, reads: ClassCReads): ClassCSnapshot;
  };
  readonly after: {
    /** `null` = handlingen kan ikke leses tilbake (gir `unverified`). Kan bruke mutasjonsresultatet (f.eks. ID-en til det opprettede). */
    reads(parameters: Record<string, JsonValue>, mutation: ClassCMutation, before: ClassCSnapshot): ClassCRead[] | null;
    snapshot(parameters: Record<string, JsonValue>, mutation: ClassCMutation, reads: ClassCReads, before: ClassCSnapshot): ClassCSnapshot;
  };
  /** FORVENTET diff: det som MÅ stemme i etter-tilstanden (og hva som ikke skal ha endret seg). */
  expect(parameters: Record<string, JsonValue>, mutation: ClassCMutation, before: ClassCSnapshot): ClassCExpectation[];
  /** `state`-stier som kan endre seg uten å være en uventet endring (flyktige leverandørfelt). */
  readonly tolerated?: readonly string[];
  /** Felt som ikke kan leses med eksisterende lese-handlinger: registreres i audit, påstås aldri. */
  readonly unobservable?: readonly string[];
  /** Kompenserende handling/prosedyre. Pipelinen utfører den ALDRI. */
  rollback(parameters: Record<string, JsonValue>, mutation: ClassCMutation, before: ClassCSnapshot, after: ClassCSnapshot | null): ClassCRollbackDraft;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rene hjelpere: kanonisk JSON, sanering, diff og forventninger
// ---------------------------------------------------------------------------------------------------------------------

/** Kanonisk JSON (sorterte nøkler) - to verdier er like hvis og bare hvis strengene er like. `undefined` regnes som `null`. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as JsonObject)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SECRET_KEY_NAME = /(token|secret|passw(?:or)?d|credential|authorization|api[_-]?key|private[_-]?key|cookie)/i;
const MAX_STRING = 200;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 40;
const STATE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sladder bevis FØR det lagres (ledger, audit): strenger går gjennom den felles hemmelighetsskanneren (`redactVendorText`: skann, kollaps blanke, kutt), nøkler som ser ut som hemmelighetsnavn får verdien
 * erstattet, og dybde/bredde/lengde er begrenset. `lossless` er sann KUN hvis ingenting ble endret (sladdet, kuttet, kollapset) - brukes til å avgjøre om en rollback-plan kan gjenskapes ordrett fra den lagrede kopien.
 * Sammenligninger (diff/forventninger) gjøres ALLTID på de rå verdiene; kun det som lagres er sladdet.
 */
export function sanitizeEvidence(value: JsonValue | undefined, depth = 0): { value: JsonValue; lossless: boolean } {
  if (value === undefined || value === null) return { value: null, lossless: true };
  if (typeof value === "string") {
    const clean = redactVendorText(value, MAX_STRING);
    return { value: clean, lossless: clean === value };
  }
  if (typeof value !== "object") return { value, lossless: true };
  if (depth >= MAX_DEPTH) return { value: "[TRUNCATED:depth]", lossless: false };
  let lossless = true;
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) lossless = false;
    const items = value.slice(0, MAX_ENTRIES).map((item) => {
      const inner = sanitizeEvidence(item, depth + 1);
      if (!inner.lossless) lossless = false;
      return inner.value;
    });
    return { value: items, lossless };
  }
  const out: JsonObject = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) lossless = false;
  for (const [rawKey, inner] of entries.slice(0, MAX_ENTRIES)) {
    const key = redactVendorText(rawKey, 80);
    if (key !== rawKey) lossless = false;
    if (SECRET_KEY_NAME.test(rawKey)) {
      out[key] = "[REDACTED:secret_key_name]";
      lossless = false;
      continue;
    }
    const cleaned = sanitizeEvidence(inner, depth + 1);
    if (!cleaned.lossless) lossless = false;
    out[key] = cleaned.value;
  }
  return { value: out, lossless };
}

/** Verdien på en punktum-skilt sti i et `state`-objekt (`undefined` hvis stien ikke finnes). */
function getAt(state: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = state;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function assertStateKeys(value: JsonValue, path = ""): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (!STATE_KEY.test(key)) throw new Error(`class_c_state_key_invalid:${path}${key}`.slice(0, 80));
    assertStateKeys(inner, `${path}${key}.`);
  }
}

function assertPath(path: string): void {
  if (path.length === 0 || !path.split(".").every((part) => STATE_KEY.test(part))) throw new Error(`class_c_path_invalid:${path}`.slice(0, 80));
}

/** Flater et `state`-objekt til blad-stier (objekter går i dybden, matriser og primitiver er blader). */
function flatten(value: JsonValue | undefined, prefix: string, out: Map<string, JsonValue>): void {
  if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      for (const [key, inner] of entries) flatten(inner, prefix === "" ? key : `${prefix}.${key}`, out);
      return;
    }
  }
  if (prefix !== "") out.set(prefix, value ?? null);
}

export interface ClassCDiffEntry { path: string; before: JsonValue; after: JsonValue }

/** Deterministisk diff mellom to `state`-objekter: alle blad-stier der verdiene er ulike (manglende = `null`). Sortert på sti. */
export function diffStates(before: JsonObject, after: JsonObject): ClassCDiffEntry[] {
  const a = new Map<string, JsonValue>();
  const b = new Map<string, JsonValue>();
  flatten(before, "", a);
  flatten(after, "", b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: ClassCDiffEntry[] = [];
  for (const path of paths) {
    const x = a.get(path) ?? null;
    const y = b.get(path) ?? null;
    if (canonicalJson(x) !== canonicalJson(y)) out.push({ path, before: x, after: y });
  }
  return out;
}

export interface ClassCViolation { path: string; rule: string; expected?: JsonValue; actual?: JsonValue }

/** Er forventningen oppfylt? `null` = ja, ellers bruddet. Ren funksjon av før-/etter-tilstanden. */
export function evaluateExpectation(expectation: ClassCExpectation, before: JsonObject, after: JsonObject): ClassCViolation | null {
  const was = getAt(before, expectation.path) ?? null;
  const now = getAt(after, expectation.path) ?? null;
  switch (expectation.op) {
    case "equals":
      return canonicalJson(now) === canonicalJson(expectation.value) ? null : { path: expectation.path, rule: "expected_equals", expected: expectation.value, actual: now };
    case "unchanged":
      return canonicalJson(was) === canonicalJson(now) ? null : { path: expectation.path, rule: "expected_unchanged", expected: was, actual: now };
    case "changed":
      return canonicalJson(was) !== canonicalJson(now) ? null : { path: expectation.path, rule: "expected_changed", actual: now };
    case "present":
      return now !== null ? null : { path: expectation.path, rule: "expected_present" };
    case "absent":
      return now === null ? null : { path: expectation.path, rule: "expected_absent", actual: now };
    case "unobservable":
      return { path: expectation.path, rule: "unobservable", expected: expectation.reason };
  }
}

/** En diff-sti er DEKKET hvis en forventning eller en tolerert sti er stien selv eller en forelder. */
function covered(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}.`));
}

function reasonCode(raw: string, max = 60): string {
  return raw.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, max);
}

function errorCode(err: unknown): string {
  return reasonCode(err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------------------------------------------------
// Kjøringen (én per verktøykall)
// ---------------------------------------------------------------------------------------------------------------------

export type ClassCVerdict = "not_run" | "verified" | "mismatch" | "unverified";

export interface ClassCRollbackPlan extends ClassCRollbackDraft {
  /** Stabil referanse (`crb-` + 16 hex av SHA-256 over kanonisk plan) - samme plan gir samme referanse. */
  ref: string;
  /** Sann KUN hvis planen i audit er identisk med den rå planen (ingenting sladdet/kuttet). Ellers må verdier hentes fra leverandørens historikk. */
  complete: boolean;
  /** Per trinn: finnes verktøyet i denne gatewayens register (dvs. kan trinnet utføres her)? */
  registered: boolean[];
}

export interface ClassCPreflightResult {
  /** Avslagsårsak (kun `enforce`); `null` = fortsett. Alltid `null` under `observe`. */
  block: string | null;
  /** Sladdet før-snapshot for ledgeren, eller `null`. */
  beforeState: JsonValue | null;
}

export interface ClassCVerifyResult {
  /** `postcondition_*`-årsak som gjør raden `unverified` (kun `enforce`); `null` = verifisert eller `observe`. */
  postconditionReason: string | null;
  /** Sladdet etter-snapshot for ledgeren, eller `null`. */
  afterState: JsonValue | null;
}

interface PreflightRecord {
  outcome: "passed" | "blocked" | "would_block" | "skipped";
  reason: string | null;
  warnings: string[];
  reads: Array<{ id: string; action: string; ok: boolean; error?: string }>;
}

export interface ClassCRunExtras {
  /** `request_digest` fra WP-T1 når det finnes (koblet via FELT, ikke via kodeavhengighet): sendes videre uendret til audit. */
  requestDigest?: string | null;
  /** Finnes `tool_id.action` i gatewayens register? Brukes til å merke rollback-trinn som utførbare. */
  isRegistered?: (toolId: string, action: string) => boolean;
}

const DIGEST = /^[0-9a-f]{64}$/;
/** Øvre grense for `class_c`-objektet i en revisjonsrad; over den fjernes kontekst og deretter verdier (stier og verdikt beholdes). */
export const CLASS_C_AUDIT_MAX_CHARS = 24_000;

export class ClassCRun {
  private pre: PreflightRecord | null = null;
  private beforeRaw: ClassCSnapshot | null = null;
  private afterRaw: ClassCSnapshot | null = null;
  private diff: ClassCDiffEntry[] = [];
  private violations: ClassCViolation[] = [];
  private expected: ClassCExpectation[] = [];
  private verdict: ClassCVerdict = "not_run";
  private verdictDetail: string | null = null;
  private verifyReads: PreflightRecord["reads"] = [];
  private rollbackPlan: ClassCRollbackPlan | null = null;
  private readonly wouldBlock: string[] = [];

  constructor(private readonly adapter: ClassCAdapter, readonly mode: "observe" | "enforce", private readonly extras: ClassCRunExtras = {}) {}

  get adapterKey(): string { return this.adapter.key; }
  get currentVerdict(): ClassCVerdict { return this.verdict; }

  private async runReads(specs: ClassCRead[], read: ClassCReadFn): Promise<{ reads: Record<string, ClassCReadResult>; log: PreflightRecord["reads"] }> {
    const reads: Record<string, ClassCReadResult> = {};
    const log: PreflightRecord["reads"] = [];
    for (const spec of specs) {
      try {
        const res = await read(spec.action, spec.parameters);
        reads[spec.id] = { ok: true, data: res.data ?? null, external_id: res.external_id ?? null };
        log.push({ id: spec.id, action: spec.action, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reads[spec.id] = { ok: false, error: errorCode(err), timed_out: message === "tool_timeout", not_found: isNotFoundError(message) };
        log.push({ id: spec.id, action: spec.action, ok: false, error: errorCode(err) });
      }
    }
    return { reads, log };
  }

  /** Første ikke-valgfrie lesing som feilet som en avslagsårsak (`null` = alle nødvendige lesinger lyktes). */
  private failedRequiredRead(specs: ClassCRead[], reads: Record<string, ClassCReadResult>): { id: string; kind: "timeout" | "not_found" | "read_failed" } | null {
    for (const spec of specs) {
      const res = reads[spec.id];
      if (res !== undefined && !res.ok && spec.optional !== true) return { id: spec.id, kind: res.timed_out ? "timeout" : res.not_found ? "not_found" : "read_failed" };
    }
    return null;
  }

  /**
   * Preflight. `replay: true` (ledgeren har allerede en rad for nøkkelen som ikke er `failed`) hopper over HELE fasen: tilstanden har flyttet seg ved handlingen selv, og ledger-porten svarer med det lagrede utfallet
   * (samme prinsipp som klasse D-validatoren). Kaster aldri.
   */
  async preflight(parameters: Record<string, JsonValue>, read: ClassCReadFn, options: { replay: boolean }): Promise<ClassCPreflightResult> {
    if (options.replay) {
      this.pre = { outcome: "skipped", reason: "replay", warnings: [], reads: [] };
      return { block: null, beforeState: null };
    }
    const record: PreflightRecord = { outcome: "passed", reason: null, warnings: [], reads: [] };
    this.pre = record;
    let reason: string | null = null;
    try {
      const invalid = this.adapter.validate(parameters);
      if (invalid !== null) {
        reason = `target_invalid:${reasonCode(invalid)}`;
      } else {
        const specs = this.adapter.before.reads(parameters);
        const { reads, log } = await this.runReads(specs, read);
        record.reads = log;
        const failed = this.failedRequiredRead(specs, reads);
        if (failed !== null) {
          reason = failed.kind === "not_found" ? `target_not_found:${reasonCode(failed.id, 30)}` : `preflight_failed:${reasonCode(failed.id, 30)}:${failed.kind}`;
        } else {
          const snapshot = this.adapter.before.snapshot(parameters, reads);
          assertStateKeys(snapshot.state);
          this.beforeRaw = snapshot;
          const judged = this.adapter.before.judge(parameters, reads);
          record.warnings = (judged.warnings ?? []).map((w) => reasonCode(w)).slice(0, 10);
          if (judged.block !== null) reason = `preflight_invalid:${reasonCode(judged.block)}`;
        }
      }
    } catch (err) {
      reason = `preflight_failed:adapter_error:${errorCode(err).slice(0, 30)}`;
    }
    record.reason = reason;
    if (reason === null) {
      record.outcome = "passed";
      return { block: null, beforeState: this.beforeStateJson() };
    }
    if (this.mode === "observe") {
      record.outcome = "would_block";
      this.wouldBlock.push(`preflight:${reason}`);
      return { block: null, beforeState: this.beforeStateJson() };
    }
    record.outcome = "blocked";
    return { block: `class_c_${reason}`.slice(0, 120), beforeState: null };
  }

  private beforeStateJson(): JsonValue | null {
    return this.beforeRaw === null ? null : sanitizeEvidence({ state: this.beforeRaw.state, context: this.beforeRaw.context }).value;
  }

  private afterStateJson(): JsonValue | null {
    return this.afterRaw === null ? null : sanitizeEvidence({ state: this.afterRaw.state, context: this.afterRaw.context }).value;
  }

  /**
   * Etterkontroll (kun etter en LYKTES mutasjon): readback, diff mot forventet diff, verdikt og rollback-plan. Under `observe` er resultatet alltid «ingen endring av status» (`postconditionReason: null`), men verdiktet
   * registreres (og «ville gjort uverifisert» havner i audit). Kaster aldri.
   */
  async verify(parameters: Record<string, JsonValue>, mutation: ClassCMutation, read: ClassCReadFn): Promise<ClassCVerifyResult> {
    let reason: string | null = null;
    try {
      reason = await this.verifyInner(parameters, mutation, read);
    } catch (err) {
      this.verdict = "unverified";
      this.verdictDetail = `adapter_error:${errorCode(err).slice(0, 30)}`;
      reason = "postcondition_unverified:predicate_error";
    }
    this.buildRollback(parameters, mutation);
    if (reason !== null && this.mode === "observe") this.wouldBlock.push(`verify:${reason}`);
    return { postconditionReason: this.mode === "enforce" ? reason : null, afterState: this.afterStateJson() };
  }

  private async verifyInner(parameters: Record<string, JsonValue>, mutation: ClassCMutation, read: ClassCReadFn): Promise<string | null> {
    if (this.beforeRaw === null) {
      this.verdict = "unverified";
      this.verdictDetail = this.pre?.outcome === "skipped" ? "before_state_missing:replay" : "before_state_missing";
      return "postcondition_unverified:class_c_no_baseline";
    }
    const specs = this.adapter.after.reads(parameters, mutation, this.beforeRaw);
    if (specs === null || specs.length === 0) {
      this.verdict = "unverified";
      this.verdictDetail = "no_readback";
      return "postcondition_unverified:class_c_no_readback";
    }
    const { reads, log } = await this.runReads(specs, read);
    this.verifyReads = log;
    const failed = this.failedRequiredRead(specs, reads);
    if (failed !== null) {
      this.verdict = "unverified";
      this.verdictDetail = `readback_${failed.kind}:${reasonCode(failed.id, 30)}`;
      return failed.kind === "not_found" ? "postcondition_unverified:target_missing" : "postcondition_unverified:readback_failed";
    }
    const after = this.adapter.after.snapshot(parameters, mutation, reads, this.beforeRaw);
    assertStateKeys(after.state);
    this.afterRaw = after;
    this.expected = this.adapter.expect(parameters, mutation, this.beforeRaw);
    for (const expectation of this.expected) assertPath(expectation.path);
    for (const tolerated of this.adapter.tolerated ?? []) assertPath(tolerated);
    this.diff = diffStates(this.beforeRaw.state, after.state);
    const violations: ClassCViolation[] = [];
    for (const expectation of this.expected) {
      const broken = evaluateExpectation(expectation, this.beforeRaw.state, after.state);
      if (broken !== null) violations.push(broken);
    }
    const roots = [...this.expected.map((e) => e.path), ...(this.adapter.tolerated ?? [])];
    for (const entry of this.diff) {
      if (!covered(entry.path, roots)) violations.push({ path: entry.path, rule: "unexpected_change", expected: entry.before, actual: entry.after });
    }
    this.violations = violations;
    if (violations.length === 0) {
      this.verdict = "verified";
      return null;
    }
    // Et brudd er `mismatch`; kun «kan ikke observeres» (uten brudd) er `unverified`: handlingen kan ha virket, men gatewayen kan ikke bevise det.
    const broken = violations.filter((v) => v.rule !== "unobservable");
    if (broken.length === 0) {
      this.verdict = "unverified";
      this.verdictDetail = reasonCode(`unobservable:${violations.map((v) => v.path).join(",")}`, 60);
      return "postcondition_unverified:class_c_unobservable";
    }
    this.verdict = "mismatch";
    this.verdictDetail = reasonCode(broken[0]?.rule ?? "mismatch", 40);
    return "postcondition_mismatch";
  }

  private buildRollback(parameters: Record<string, JsonValue>, mutation: ClassCMutation): void {
    let draft: ClassCRollbackDraft;
    try {
      draft = this.beforeRaw === null
        ? { kind: "manual", steps: [], note: "Ingen før-tilstand ble lest; undersøk leverandørens historikk før noe rettes." }
        : this.adapter.rollback(parameters, mutation, this.beforeRaw, this.afterRaw);
    } catch {
      draft = { kind: "manual", steps: [], note: "Rollback-planen kunne ikke beregnes; undersøk leverandørens historikk." };
    }
    const cleaned = sanitizeEvidence({ kind: draft.kind, steps: draft.steps as unknown as JsonValue, note: draft.note });
    const canonical = canonicalJson({ kind: draft.kind, steps: draft.steps as unknown as JsonValue, note: draft.note });
    const isRegistered = this.extras.isRegistered;
    this.rollbackPlan = {
      kind: draft.kind,
      steps: (cleaned.value as unknown as { steps: ClassCRollbackStep[] }).steps,
      note: (cleaned.value as unknown as { note: string }).note,
      ref: `crb-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`,
      complete: cleaned.lossless,
      registered: draft.steps.map((step) => (isRegistered === undefined ? false : isRegistered(step.tool_id, step.action)))
    };
  }

  /** Sladdet, størrelsesbegrenset `class_c`-objekt til revisjonsraden. Kaster aldri. */
  auditBlock(): Record<string, JsonValue> {
    try {
      return this.buildAuditBlock();
    } catch {
      return { schema: 1, mode: this.mode, adapter: this.adapter.key, verdict: this.verdict, error: "audit_block_failed" };
    }
  }

  private buildAuditBlock(): Record<string, JsonValue> {
    const digest = this.extras.requestDigest;
    const clean = (value: unknown): JsonValue => sanitizeEvidence(value as JsonValue).value;
    const block: Record<string, JsonValue> = {
      schema: 1,
      mode: this.mode,
      adapter: this.adapter.key,
      request_digest: typeof digest === "string" && DIGEST.test(digest) ? digest : null,
      preflight: this.pre === null ? null : clean({ outcome: this.pre.outcome, reason: this.pre.reason, warnings: this.pre.warnings, reads: this.pre.reads }),
      before: this.beforeRaw === null ? null : clean({ state: this.beforeRaw.state, context: this.beforeRaw.context }),
      after: this.afterRaw === null ? null : clean({ state: this.afterRaw.state, context: this.afterRaw.context }),
      readback: clean(this.verifyReads),
      expected: clean(this.expected),
      diff: clean(this.diff),
      violations: clean(this.violations),
      verdict: this.verdict,
      verdict_detail: this.verdictDetail,
      unobservable: clean([...(this.adapter.unobservable ?? [])]),
      would_block: clean(this.wouldBlock),
      rollback: this.rollbackPlan === null ? null : clean(this.rollbackPlan)
    };
    if (JSON.stringify(block).length <= CLASS_C_AUDIT_MAX_CHARS) return block;
    // Trinn 1: kontekst fjernes. Trinn 2: også verdiene i før/etter og diff (stier, verdikt og rollback beholdes).
    const slim: Record<string, JsonValue> = {
      ...block,
      truncated: true,
      before: this.beforeRaw === null ? null : clean({ state: this.beforeRaw.state }),
      after: this.afterRaw === null ? null : clean({ state: this.afterRaw.state })
    };
    if (JSON.stringify(slim).length <= CLASS_C_AUDIT_MAX_CHARS) return slim;
    return { ...slim, before: null, after: null, diff: clean(this.diff.map((d) => d.path)), expected: clean(this.expected.map((e) => e.path)), violations: clean(this.violations.map((v) => `${v.rule}:${v.path}`)) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Registeret (én per gateway)
// ---------------------------------------------------------------------------------------------------------------------

const ADAPTER_KEY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9_]+$/;

/**
 * Eierens egne stopp-/kontrollhandlinger (frys, tilbakekall, pause, kill switch, enhetstilbakekall) skal ALDRI kunne blokkeres av en preflight eller en uverifisert etterkontroll: de MÅ virke når noe er galt.
 * Settet speiler kontrollhandlingene i produksjonsregisteret (klasse C, effekt «control»/pause) og er pinnet av test; i tillegg er alle `owner_controls`-handlinger, kill switch-handlingene (`isClassDExempt`)
 * og selvgjenopprettingshandlingene (`isSelfRecoveryAction`) utelukket.
 */
export const CLASS_C_OWNER_OVERRIDE_ACTIONS: ReadonlySet<string> = new Set([
  "executive.pause_domain", "executive.resume_domain", "executive.freeze_connector", "executive.unfreeze_connector", "executive.revoke_credential", "executive.restore_credential", "executive.revoke_device",
  "situations.pause_domain", "situations.unpause_domain", "situations.pause_all", "situations.unpause_all"
]);

export function isClassCOwnerOverride(def: Pick<ToolDefinition, "tool_id" | "action">): boolean {
  return def.tool_id === "owner_controls" || isClassDExempt(def) || isSelfRecoveryAction(def.tool_id, def.action) || CLASS_C_OWNER_OVERRIDE_ACTIONS.has(`${def.tool_id}.${def.action}`);
}

export interface ClassCPipelineOptions {
  mode: ClassCMode;
  adapters: readonly ClassCAdapter[];
}

export class ClassCPipeline {
  readonly mode: ClassCMode;
  private readonly adapters = new Map<string, ClassCAdapter>();

  constructor(options: ClassCPipelineOptions) {
    this.mode = options.mode;
    for (const adapter of options.adapters) {
      if (!ADAPTER_KEY.test(adapter.key)) throw new Error(`class_c_adapter_key_invalid:${adapter.key}`);
      const [toolId, ...rest] = adapter.key.split(".");
      if (isClassCOwnerOverride({ tool_id: toolId ?? "", action: rest.join(".") })) throw new Error(`class_c_adapter_forbidden:${adapter.key}`);
      if (this.adapters.has(adapter.key)) throw new Error(`class_c_adapter_duplicate:${adapter.key}`);
      this.adapters.set(adapter.key, adapter);
    }
  }

  adapterKeys(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Oppstartslogg (kun navn, ingen hemmeligheter). */
  describe(): { msg: "class_c_pipeline"; mode: ClassCMode; adapters: string[] } {
    return { msg: "class_c_pipeline", mode: this.mode, adapters: this.adapterKeys() };
  }

  /** `null` = pipelinen er ikke i bruk for denne handlingen (modus off, ikke klasse C, eierens kontrollhandling eller ingen adapter): gatewayen er da identisk med main. */
  begin(definition: Pick<ToolDefinition, "tool_id" | "action" | "capability_class">, extras: ClassCRunExtras = {}): ClassCRun | null {
    if (this.mode === "off") return null;
    if (definition.capability_class !== "C") return null;
    if (isClassCOwnerOverride(definition)) return null;
    const adapter = this.adapters.get(`${definition.tool_id}.${definition.action}`);
    if (adapter === undefined) return null;
    return new ClassCRun(adapter, this.mode, extras);
  }
}

export function createClassCPipeline(options: ClassCPipelineOptions): ClassCPipeline {
  return new ClassCPipeline(options);
}

/** Leser `request_digest` (WP-T1) som FELT på forespørselen uten kodeavhengighet: kun en gyldig SHA-256 (64 hex) godtas, alt annet er `null`. */
export function requestDigestOf(request: object): string | null {
  const value = (request as { request_digest?: unknown }).request_digest;
  return typeof value === "string" && DIGEST.test(value) ? value : null;
}
