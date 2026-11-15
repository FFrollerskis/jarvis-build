import { CONNECTOR_REGISTRY, type ConnectorDefinition } from "@jarvis/tool-gateway";
import { deriveSkeletonManifests, type DeriveInput } from "./derive.ts";
import { isUnknown, type ActionSpec, type Completeness, type ConnectorManifest } from "./manifest.ts";

/**
 * WP-I (D-472): manifest-KATALOGEN og DRIFT-kontrollen. Registeret (`CONNECTOR_REGISTRY` + de registrerte verktøydefinisjonene) forblir kjøretidens sannhetskilde; et håndskrevet (`full`)
 * manifest BESKRIVER en connector og sjekkes mot det samme som `derive.ts` leser. Alt som kan avledes (handlingsmengden, risikoklasse, effekt, step-up, idempotenskrav, tillit, tidsavbrudd,
 * rate limit, credential-referanser, helsesjekk) må være IDENTISK med registeret - ellers er det drift, og vakten feiler. Narrativ (runbook, retensjon, D-41-revisjon ...) kan registeret ikke
 * si noe om og sammenlignes derfor ikke.
 */

export interface DriftIssue {
  connector_id: string;
  path: string;
  code: string;
  message: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function actionDrift(id: string, i: number, m: ActionSpec, d: ActionSpec, out: DriftIssue[]): void {
  const at = (f: string) => `actions[${i}].${f}`;
  const diff = (field: string, code: string, a: unknown, b: unknown) => {
    if (a !== b) out.push({ connector_id: id, path: at(field), code, message: `${m.key}: manifestet sier ${String(a)}, registeret sier ${String(b)}` });
  };
  diff("kind", "drift_kind", m.kind, d.kind);
  diff("effect", "drift_effect", m.effect, d.effect);
  diff("authority.risk_class", "drift_risk_class", m.authority.risk_class, d.authority.risk_class);
  diff("authority.step_up_required", "drift_step_up", m.authority.step_up_required, d.authority.step_up_required);
  diff("authority.owner_only", "drift_owner_only", m.authority.owner_only, d.authority.owner_only);
  diff("reversibility.reversible", "drift_reversible", m.reversibility.reversible, d.reversibility.reversible);
  diff("reversibility.evidence.before_state", "drift_before_state", m.reversibility.evidence.before_state, d.reversibility.evidence.before_state);
  diff("reversibility.evidence.postcondition", "drift_postcondition", m.reversibility.evidence.postcondition, d.reversibility.evidence.postcondition);
  diff("reversibility.class_d_chain.status", "drift_class_d_chain", m.reversibility.class_d_chain?.status, d.reversibility.class_d_chain?.status);
  if (d.reversibility.destructive && !m.reversibility.destructive) out.push({ connector_id: id, path: at("reversibility.destructive"), code: "drift_destructive_understated", message: `${m.key}: registeret gjør handlingen destruktiv (sletting eller ikke-reversibel skriving), manifestet sier det ikke` });
  diff("idempotency.requirement", "drift_idempotency_requirement", m.idempotency.requirement, d.idempotency.requirement);
  diff("idempotency.provider_idempotent", "drift_provider_idempotent", m.idempotency.provider_idempotent, d.idempotency.provider_idempotent);
  diff("trust.output", "drift_trust", m.trust.output, d.trust.output);
  diff("limits.rate_limit_per_minute", "drift_rate_limit", m.limits.rate_limit_per_minute, d.limits.rate_limit_per_minute);
  diff("operations.timeout_ms", "drift_timeout", m.operations.timeout_ms, d.operations.timeout_ms);
  if (!sameSet(m.data.identity_fields, d.data.identity_fields)) out.push({ connector_id: id, path: at("data.identity_fields"), code: "drift_identity_fields", message: `${m.key}: identitetsfeltene i skjemaet er ${JSON.stringify(d.data.identity_fields)}` });
  if (!isUnknown(m.data.input_required) && !isUnknown(d.data.input_required) && !sameSet(m.data.input_required, d.data.input_required)) {
    out.push({ connector_id: id, path: at("data.input_required"), code: "drift_input_required", message: `${m.key}: påkrevde parametre i skjemaet er ${JSON.stringify(d.data.input_required)}` });
  }
}

/** Sammenligner et håndskrevet manifest med skeletonet avledet fra registeret. Tom liste = ingen drift. */
export function checkManifestAgainstDerived(authored: ConnectorManifest, derived: ConnectorManifest): DriftIssue[] {
  const out: DriftIssue[] = [];
  const id = authored.identity.id;
  if (authored.identity.id !== derived.identity.id) out.push({ connector_id: id, path: "identity.id", code: "drift_id", message: "id stemmer ikke med registeret" });
  if (authored.identity.name !== derived.identity.name) out.push({ connector_id: id, path: "identity.name", code: "drift_name", message: `navnet i registeret er «${derived.identity.name}»` });
  if (authored.identity.owner.kind !== derived.identity.owner.kind) out.push({ connector_id: id, path: "identity.owner.kind", code: "drift_owner_kind", message: `eier-art i verktøymanifestet er ${derived.identity.owner.kind}` });
  const byKey = new Map(derived.actions.map((a) => [a.key, a]));
  const seen = new Set<string>();
  authored.actions.forEach((m, i) => {
    seen.add(m.key);
    const d = byKey.get(m.key);
    if (d === undefined) out.push({ connector_id: id, path: `actions[${i}].key`, code: "drift_action_not_in_registry", message: `${m.key}: finnes ikke blant connectorens registrerte handlinger` });
    else actionDrift(id, i, m, d, out);
  });
  for (const d of derived.actions) if (!seen.has(d.key)) out.push({ connector_id: id, path: "actions", code: "drift_action_missing_in_manifest", message: `${d.key}: er registrert (klasse ${d.authority.risk_class}) men står ikke i manifestet` });
  if (!sameSet(authored.auth.scopes.declared_by_actions, derived.auth.scopes.declared_by_actions)) out.push({ connector_id: id, path: "auth.scopes.declared_by_actions", code: "drift_declared_scopes", message: `scope-etikettene handlingene deklarerer er ${JSON.stringify(derived.auth.scopes.declared_by_actions)}` });
  const refKey = (m: ConnectorManifest) => m.secrets.refs.map((r) => `${r.ref}:${r.required ? "required" : "optional"}`);
  if (!sameSet(refKey(authored), refKey(derived))) out.push({ connector_id: id, path: "secrets.refs", code: "drift_secret_refs", message: `registerets credential-referanser er ${JSON.stringify(refKey(derived))}` });
  // Valgfrie fakta (kun når kalleren ga dem til avledningen: Integrasjonssenterets API-versjon og synk-jobber).
  const mv = authored.identity.version.provider_api;
  const dv = derived.identity.version.provider_api;
  if (!isUnknown(mv) && !isUnknown(dv) && !mv.includes(dv)) out.push({ connector_id: id, path: "identity.version.provider_api", code: "drift_provider_api", message: `API-versjonen koden oppgir er «${dv}»` });
  const ms = authored.capabilities.sync;
  const ds = derived.capabilities.sync;
  if (!isUnknown(ms) && !isUnknown(ds) && (ms.status !== ds.status || !sameSet(ms.items, ds.items))) out.push({ connector_id: id, path: "capabilities.sync", code: "drift_sync_jobs", message: `synk-jobbene i koden er ${JSON.stringify(ds.items)}` });
  const mh = authored.operations.health_check;
  const dh = derived.operations.health_check;
  if (!isUnknown(mh) && !isUnknown(dh) && (mh.method !== dh.method || mh.action_key !== dh.action_key)) out.push({ connector_id: id, path: "operations.health_check", code: "drift_health_check", message: `registerets helsesjekk er ${dh.method}/${String(dh.action_key)}` });
  const mt = authored.operations.timeout;
  const dt = derived.operations.timeout;
  if (!isUnknown(mt) && !isUnknown(dt) && mt.max_ms !== dt.max_ms) out.push({ connector_id: id, path: "operations.timeout.max_ms", code: "drift_timeout_max", message: `høyeste tidsavbrudd i registeret er ${dt.max_ms} ms` });
  if (authored.trust.output.class !== derived.trust.output.class) out.push({ connector_id: id, path: "trust.output.class", code: "drift_trust_class", message: `strengeste utdata-klasse i registeret er ${derived.trust.output.class}` });
  return out;
}

export interface CatalogueEntry {
  connector_id: string;
  /** `full` når et håndskrevet manifest finnes (og er sjekket mot registeret), ellers `skeleton`. */
  level: Completeness;
  manifest: ConnectorManifest;
  drift: DriftIssue[];
}

export interface Catalogue {
  entries: CatalogueEntry[];
  /** Håndskrevne manifester som peker på en connector som IKKE finnes i registeret (id-er). */
  orphans: string[];
  /** Connector-id-er med mer enn ett håndskrevet manifest. */
  duplicates: string[];
}

export interface CatalogueInput extends DeriveInput {
  /** Håndskrevne manifester (typisk `FULL_MANIFESTS`). */
  authored: readonly ConnectorManifest[];
}

/** Ett manifest per registerioppføring: det håndskrevne når det finnes (drift-sjekket), ellers det avledede skeletonet. */
export function buildManifestCatalogue(input: CatalogueInput): Catalogue {
  const registry: readonly ConnectorDefinition[] = input.registry ?? CONNECTOR_REGISTRY;
  const derived = deriveSkeletonManifests(input);
  const authoredBy = new Map<string, ConnectorManifest[]>();
  for (const m of input.authored) authoredBy.set(m.identity.id, [...(authoredBy.get(m.identity.id) ?? []), m]);
  const registryIds = new Set(registry.map((c) => c.id));
  const entries = derived.map((d): CatalogueEntry => {
    const mine = authoredBy.get(d.identity.id)?.[0];
    if (mine === undefined) return { connector_id: d.identity.id, level: "skeleton", manifest: d, drift: [] };
    return { connector_id: d.identity.id, level: mine.completeness, manifest: mine, drift: checkManifestAgainstDerived(mine, d) };
  });
  return {
    entries,
    orphans: [...authoredBy.keys()].filter((id) => !registryIds.has(id)).sort(),
    duplicates: [...authoredBy.entries()].filter(([, v]) => v.length > 1).map(([id]) => id).sort()
  };
}
