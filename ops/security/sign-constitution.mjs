#!/usr/bin/env node
// EV-0 (D-406): eierens OFFLINE-verktøy for Safety Constitution. Kjøres av eieren (Platform Operator) på en maskin Jarvis ikke har tilgang til.
// Privatnøkkelen skal aldri inn i repoet, NAS-en, chat eller Jarvis sine miljøvariabler.
//   node ops/security/sign-constitution.mjs keygen <privat.pem> <offentlig.pem>   # lager Ed25519-par (nekter å overskrive)
//   node ops/security/sign-constitution.mjs summary [manifest.json]               # lesbar oversikt over det du signerer (kr, timer, harde tak, SHA-256) + funn
//   node ops/security/sign-constitution.mjs check [manifest.json]                 # exit 0 = klart for signering, 1 = funn (UTKAST-markører, tak/koherens)
//   node ops/security/sign-constitution.mjs sign <privat.pem> [manifest.json] [sig-ut]   # NEKTER et UTKAST eller et manifest kjøretiden ville avvise
//   node ops/security/sign-constitution.mjs fingerprint <offentlig.pem>           # verdien som festes i NAS-.env
//   node ops/security/sign-constitution.mjs verify <offentlig.pem> [manifest.json] [sig]
// Verktøyet er bevisst AVHENGIGHETSFRITT (kun node: innebygde moduler) så det kan kjøres på en offline maskin uten installasjon. Tak og koherensregler er derfor
// speilet fra modules/self-modification/src/constitution.ts; paritet er testet differensielt (ops/security/test/sign-constitution.test.mjs).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_MANIFEST = "config/evolution/constitution.v1.json";
const DEFAULT_SIG = "config/evolution/constitution.v1.sig";

/** MÅ være identisk med `canonicalizeManifest` i modules/self-modification/src/constitution.ts. */
export function canonicalize(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

export function fingerprint(publicKeyPem) {
  return createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");
}

/** MÅ være identisk med `BUDGET_HARD_CEILINGS` i modules/self-modification/src/constitution.ts (testet). Selv et signert manifest over disse avvises av kjøretiden. */
export const HARD_CEILINGS = Object.freeze({
  max_auto_merges_per_day: 20,
  max_deploys_per_day: 10,
  max_deploys_per_hour: 3,
  max_owner_proposals_per_day: 50,
  max_evolution_cost_ore_per_month: 100_000,
  max_radar_cost_ore_per_month: 100_000,
  max_eval_cost_ore_per_month: 100_000,
  max_redteam_cost_ore_per_month: 100_000,
  max_shadow_cost_ore_per_month: 100_000,
  max_review_cost_ore_per_month: 100_000,
  owner_time_budget_minutes_per_week: 600,
  max_owner_minutes_per_autonomous_change: 60
});
const CATEGORY_KEYS = ["max_radar_cost_ore_per_month", "max_eval_cost_ore_per_month", "max_redteam_cost_ore_per_month", "max_shadow_cost_ore_per_month", "max_review_cost_ore_per_month"];
const TOP_LEVEL_KEYS = new Set(["schema_version", "constitution_id", "version", "issued_at", "issued_by", "notes", "protected_paths", "e1_allowlist", "e3_actions", "budget_caps"]);

/**
 * Funn som hindrer signering (tom liste = klart). Dekker det EIEREN redigerer: UTKAST-markører, versjoner, merknad og budsjettgrenser (tak og koherens, samme regler som
 * `buildConstitution`). Beskyttede stier og E3-handlinger redigeres ikke av eieren og kontrolleres av CI-testen på det innsjekkede manifestet og av kjøretiden.
 */
export function validateForSigning(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest_not_an_object"];
  const problems = [];
  for (const k of Object.keys(manifest)) if (!TOP_LEVEL_KEYS.has(k)) problems.push(`unknown_top_level_key:${k}`);
  if (manifest.schema_version !== 2) problems.push("schema_version_must_be_2");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) problems.push("version_must_be_positive_integer");
  if (typeof manifest.constitution_id !== "string" || manifest.constitution_id.length < 1 || manifest.constitution_id.length > 80) problems.push("constitution_id_invalid");
  if (typeof manifest.issued_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(manifest.issued_at) || Number.isNaN(Date.parse(manifest.issued_at))) problems.push("issued_at_invalid");
  if (typeof manifest.issued_by !== "string" || manifest.issued_by.length < 1 || manifest.issued_by.length > 80) problems.push("issued_by_invalid");
  else if (/^unsigned-draft/i.test(manifest.issued_by)) problems.push("draft_marker_in_issued_by");
  if (manifest.notes !== undefined) {
    if (typeof manifest.notes !== "string" || manifest.notes.length < 1 || manifest.notes.length > 2000) problems.push("notes_invalid");
    else if (/utkast/i.test(manifest.notes)) problems.push("draft_marker_in_notes");
  }
  const caps = manifest.budget_caps;
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    problems.push("budget_caps_missing");
    return problems;
  }
  for (const k of Object.keys(caps)) if (!(k in HARD_CEILINGS)) problems.push(`budget_cap_unknown:${k}`);
  const valid = new Set();
  for (const k of Object.keys(HARD_CEILINGS)) {
    const v = caps[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) problems.push(`budget_cap_invalid:${k}`);
    else {
      valid.add(k);
      if (v > HARD_CEILINGS[k]) problems.push(`budget_above_ceiling:${k}`);
    }
  }
  if (CATEGORY_KEYS.every((k) => valid.has(k)) && valid.has("max_evolution_cost_ore_per_month")) {
    if (CATEGORY_KEYS.reduce((n, k) => n + caps[k], 0) > caps.max_evolution_cost_ore_per_month) problems.push("budget_categories_exceed_total");
  }
  if (valid.has("max_deploys_per_hour") && valid.has("max_deploys_per_day") && caps.max_deploys_per_hour > caps.max_deploys_per_day) problems.push("deploys_per_hour_above_per_day");
  if (valid.has("max_owner_minutes_per_autonomous_change") && valid.has("owner_time_budget_minutes_per_week") && caps.max_owner_minutes_per_autonomous_change > caps.owner_time_budget_minutes_per_week) {
    problems.push("owner_change_minutes_above_weekly_budget");
  }
  return problems;
}

const kr = (ore) => `${Math.trunc(ore / 100)},${String(ore % 100).padStart(2, "0")}`;
const t = (minutes) => `${(minutes / 60).toFixed(1).replace(".", ",")} t`;

/** Lesbar oversikt over det eieren signerer. `digest` er SHA-256 av det kanoniske manifestet (= `Constitution.digest` i kjøretiden og i endringsregisteret). */
export function summarize(manifest) {
  const digest = createHash("sha256").update(canonicalize(manifest)).digest("hex");
  const c = manifest.budget_caps ?? {};
  const H = HARD_CEILINGS;
  const catSum = CATEGORY_KEYS.reduce((n, k) => n + (Number.isInteger(c[k]) ? c[k] : 0), 0);
  const lines = [
    `Konstitusjon: id ${manifest.constitution_id} · versjon ${manifest.version} · skjemaversjon ${manifest.schema_version}`,
    `issued_by: ${manifest.issued_by} (bruk en nøytral rolle-ID, aldri et personnavn - repoet er offentlig)`,
    `SHA-256 av kanonisk manifest: ${digest}`,
    `Merknad (notes): ${manifest.notes === undefined ? "ingen" : /utkast/i.test(manifest.notes) ? "finnes og inneholder UTKAST - fjern eller skriv om før signering" : "finnes"}`,
    "",
    "KOSTNADSTAK (kr pr. kalendermåned; kategoriene må summere til høyst totalen):",
    `  totalt ${kr(c.max_evolution_cost_ore_per_month)} kr (hardt tak ${kr(H.max_evolution_cost_ore_per_month)} kr)`,
    `  radar ${kr(c.max_radar_cost_ore_per_month)} · evaluering ${kr(c.max_eval_cost_ore_per_month)} · red team ${kr(c.max_redteam_cost_ore_per_month)} · shadow/canary ${kr(c.max_shadow_cost_ore_per_month)} · review ${kr(c.max_review_cost_ore_per_month)} (sum ${kr(catSum)})`,
    "",
    "EIER-TID:",
    `  ${t(c.owner_time_budget_minutes_per_week)}/uke (${c.owner_time_budget_minutes_per_week} min; hardt tak ${H.owner_time_budget_minutes_per_week} min)`,
    `  ${c.max_owner_minutes_per_autonomous_change} min pr. autonom endring (hardt tak ${H.max_owner_minutes_per_autonomous_change})`,
    "",
    "GRENSER:",
    `  auto-merger ${c.max_auto_merges_per_day}/døgn (tak ${H.max_auto_merges_per_day}) · deploys ${c.max_deploys_per_day}/døgn (tak ${H.max_deploys_per_day}) og ${c.max_deploys_per_hour}/time (tak ${H.max_deploys_per_hour}) · E2-forslag til eier ${c.max_owner_proposals_per_day}/døgn (tak ${H.max_owner_proposals_per_day})`,
    "",
    `Beskyttede stier: ${Array.isArray(manifest.protected_paths) ? manifest.protected_paths.length : "?"} regler · E3-handlinger: ${Array.isArray(manifest.e3_actions) ? manifest.e3_actions.length : "?"} · E1-allowlist: ${Array.isArray(manifest.e1_allowlist) ? manifest.e1_allowlist.length : "?"}`
  ];
  return { digest, lines, problems: validateForSigning(manifest) };
}

function readManifest(path) {
  if (!existsSync(path)) throw new Error(`fant ikke manifestet: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  if (cmd === "keygen") {
    if (!a || !b) throw new Error("bruk: keygen <privat.pem> <offentlig.pem>");
    if (existsSync(a) || existsSync(b)) throw new Error("nekter å overskrive eksisterende nøkkelfil");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(a, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(b, publicKey.export({ type: "spki", format: "pem" }));
    console.log(`privat nøkkel: ${a} (OPPBEVAR OFFLINE)\noffentlig nøkkel: ${b}\nfingeravtrykk: ${fingerprint(readFileSync(b, "utf8"))}`);
  } else if (cmd === "summary") {
    const { lines, problems } = summarize(readManifest(a ?? DEFAULT_MANIFEST));
    console.log(lines.join("\n"));
    console.log(`\nBlokkerende funn før signering: ${problems.length === 0 ? "ingen" : problems.length}`);
    for (const p of problems) console.log(`  - ${p}`);
  } else if (cmd === "check") {
    const problems = validateForSigning(readManifest(a ?? DEFAULT_MANIFEST));
    if (problems.length === 0) console.log("klart for signering: ingen blokkerende funn");
    else {
      console.log(`IKKE klart for signering (${problems.length} funn):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      process.exitCode = 1;
    }
  } else if (cmd === "sign") {
    if (!a) throw new Error("bruk: sign <privat.pem> [manifest] [sig-ut]");
    const manifest = readManifest(b ?? DEFAULT_MANIFEST);
    const problems = validateForSigning(manifest);
    if (problems.length > 0) throw new Error(`nekter å signere (${problems.length} funn - rett dem først, se «check»/«summary»):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    const sig = sign(null, Buffer.from(canonicalize(manifest), "utf8"), createPrivateKey(readFileSync(a, "utf8")));
    writeFileSync(c ?? DEFAULT_SIG, `${sig.toString("base64")}\n`);
    console.log(`signert ${b ?? DEFAULT_MANIFEST} -> ${c ?? DEFAULT_SIG}`);
  } else if (cmd === "fingerprint") {
    if (!a) throw new Error("bruk: fingerprint <offentlig.pem>");
    console.log(fingerprint(readFileSync(a, "utf8")));
  } else if (cmd === "verify") {
    if (!a) throw new Error("bruk: verify <offentlig.pem> [manifest] [sig]");
    const manifest = JSON.parse(readFileSync(b ?? DEFAULT_MANIFEST, "utf8"));
    const ok = verify(null, Buffer.from(canonicalize(manifest), "utf8"), createPublicKey(readFileSync(a, "utf8")),
      Buffer.from(readFileSync(c ?? DEFAULT_SIG, "utf8").trim(), "base64"));
    console.log(ok ? "OK: signaturen er gyldig" : "FEIL: signaturen er ugyldig");
    process.exitCode = ok ? 0 : 1;
  } else {
    throw new Error("kommandoer: keygen | summary | check | sign | fingerprint | verify");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 2; }
}
