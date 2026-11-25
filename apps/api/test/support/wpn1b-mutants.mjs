#!/usr/bin/env node
// WP-N1b (K4f): MUTANTSETTET for den nye koden (modell-skopet, K2-klassifiseringen, tilbakeholdet VED UTFØRELSE). Hver mutant er én tekstendring i produksjonskoden som SKAL få minst én N1b-test til å feile («drept»).
// Samme idé og regler som `wpn1-mutants.mjs`: kjør fra repo-roten (DB-testene kan ikke kjøre som root: `N1B_RUN_AS=postgres node apps/api/test/support/wpn1b-mutants.mjs [id ...]`), antall vitest-arbeidere `N1B_WORKERS`
// (standard 2). Filen gjenopprettes ALLTID etter hver mutant. `--list` skriver kun settet, `--check` kontrollerer at hvert mønster finnes nøyaktig én gang (uten å kjøre tester). Et mønster som ikke finnes nøyaktig én gang gir
// INVALID (kildekoden har endret seg - oppdater mutanten, ikke testen). Overlevende må enten drepes av en ny test eller begrunnes som ekvivalente (se `equivalent`).
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const K1 = ["modules/tool-gateway/test/wpn1b-model-scope.test.ts", "apps/api/test/wpn1b-model-scope.test.ts", "apps/api/test/wpn1b-structure.test.ts"];
const K1_NEST = [...K1, "apps/api/test/wpn1-nested-finance-lock.test.ts"];
const K2 = ["apps/api/test/wpn1b-finance-derived-table.test.ts", "apps/api/test/wpn1b-finance-withheld.test.ts"];
const SCOPE = "modules/tool-gateway/src/model-scope.ts";
const GW = "modules/tool-gateway/src/gateway.ts";
const TGW = "modules/tool-gateway/src/finance-withheld.ts";
const OLT = "modules/business/src/open-loop-types.ts";
const BTR = "modules/business/src/transport.ts";
const BRIEF = "modules/business/src/business-brief.ts";
const OLS = "modules/business/src/open-loop-service.ts";
const CGS = "modules/conversation-graph/src/service.ts";
const CGT = "modules/conversation-graph/src/transport.ts";
const EXFW = "modules/executive/src/finance-withheld.ts";
const EXTOOLS = "modules/executive/src/control-center/tools.ts";
const EXTR = "modules/executive/src/transport.ts";
const EXSVC = "modules/executive/src/service.ts";
const RR = "apps/api/src/run-rate.ts";

/** [id, beskrivelse, fil, gammel tekst, ny tekst, testfiler, ekvivalent?] */
export const MUTANTS = [
  // ---- K1: modell-skopet og gatewayens omslag ----
  ["B01", "K1: skopet er lokalt med mindre kalleren sier sky (fail-open: manglende `cloud` regnes som lokal)", SCOPE, "cloud: scope.cloud !== false", "cloud: scope.cloud === true", K1],
  ["B02", "K1: den sentrale lesningen er snudd (sky leses som lokal og omvendt)", SCOPE, "return store.getStore()?.cloud === true;", "return store.getStore()?.cloud === false;", K1_NEST],
  ["B03", "K1: et eksplisitt lokalt kall kan LØSNE et ytre skyskop (ambient-vinner-regelen fjernet)", GW, "const model = ambient?.cloud === true ? ambient.servingModel : (request.servingModel ?? ambient?.servingModel);", "const model = request.servingModel ?? ambient?.servingModel;", K1_NEST],
  ["B04", "K1: nøstede kall arver ikke modellen (kun den eksplisitte brukes)", GW, "const model = ambient?.cloud === true ? ambient.servingModel : (request.servingModel ?? ambient?.servingModel);", "const model = request.servingModel;", K1_NEST],
  ["B05", "K1: skopet settes aldri (omslaget kaller kroppen uten `runWithModelScope`)", GW, "return runWithModelScope({ servingModel: model, cloud }, () => this.executeCall(effective));", "return this.executeCall(effective);", K1_NEST],
  ["B06", "K1: den effektive modellen går ikke til kroppen (utførelseslåsen ser kun den eksplisitte)", GW, "const effective: ToolExecuteRequest = model === request.servingModel ? request : { ...request, servingModel: model };", "const effective: ToolExecuteRequest = request;", K1_NEST],
  ["B07", "K1: lokalitetsvedtaket snudd (sky regnes som lokal i skopet)", GW, "const cloud = ambient?.cloud === true || this.servedByCloud(model, lock);", "const cloud = ambient?.cloud === true || !this.servedByCloud(model, lock);", K1_NEST],
  ["B08", "K1: vakt AV går ikke lenger rett til kroppen (omslaget kjører også uten lås)", GW, "if (lock === undefined) return this.executeCall(request);", "if (false) return this.executeCall(request);", K1],
  // ---- K2: klassifiseringen (hva som er finansavledet) ----
  ["B09", "K2 AV (som main): den sentrale lesningen sier aldri «hold tilbake» - ALLE de 23 stiene lekker (den røde kjøringen mot main-oppførselen)", SCOPE, "return store.getStore()?.cloud === true;", "return false;", K2],
  ["B10", "K2: betalingsintensjon-løkker regnes ikke som finansavledet", OLT, "  payment_intent_anomaly: true,", "  payment_intent_anomaly: false,", K2],
  ["B11", "K2: markedsutgift-løkker regnes ikke som finansavledet (den strengeste valgfriheten)", OLT, "  marketing_spend_anomaly: true,", "  marketing_spend_anomaly: false,", K2],
  ["B12", "K2: en ukjent løkketype regnes som IKKE finansavledet (fail-open)", OLT, "!Object.hasOwn(FINANCE_DERIVED_LOOP_TYPE, loopType) || ", "", K2],
  ["B13", "K2: hvitlisten til SQL-filtrene er snudd (kun finanstyper slipper gjennom)", OLT, "(Object.keys(FINANCE_DERIVED_LOOP_TYPE) as OpenLoopType[]).filter((t) => !FINANCE_DERIVED_LOOP_TYPE[t]);", "(Object.keys(FINANCE_DERIVED_LOOP_TYPE) as OpenLoopType[]).filter((t) => FINANCE_DERIVED_LOOP_TYPE[t]);", K2],
  ["B14", "K2: `spend`-domenet regnes ikke som finansavledet (situasjonene slipper gjennom)", TGW, 'new Set(["spend"])', "new Set<string>([])", K2],
  ["B15", "K2: ordstamme-regelen for ukjente connector-/credential-referanser fjernet (bare finans-ordet beholdes)", TGW, "(finance|finans|stripe|vipps|fiken|neonomics|wallester|payment|bank)", "(finance)", K2],
  ["B16", "K2: en connector-id som ikke er en streng regnes som ikke-finans (fail-open)", TGW, 'if (typeof id !== "string") return true;', 'if (typeof id !== "string") return false;', K2],
  // ---- K2: forretnings-OS (åpne løkker, kø, brief, kalibrering) ----
  ["B20", "K2: `list_open_loops` filtrerer ikke finansløkker for sky", BTR, "open_loops: rows.filter((r) => !isFinanceDerivedLoopType(r.loop_type))", "open_loops: rows", K2],
  ["B21", "K2: `get_attention_queue` (business) filtrerer ikke finansløkker for sky", BTR, "entries: rows.filter((r) => !isFinanceDerivedLoopType(r.loop.loop_type))", "entries: rows", K2],
  ["B22", "K2: `read_open_loop` holder ikke tilbake en finansløkke", BTR, "if (row !== null && withholdFinanceFromCurrentModel() && isFinanceDerivedLoopType(row.loop_type))", "if (false)", K2],
  ["B23", "K2: ukebriefens `still_open` teller finansløkker for sky", BRIEF, '" AND loop_type = ANY($2::text[])"', '" AND (loop_type = ANY($2::text[]) OR true)"', K2],
  ["B24", "K2: dagsbriefen tar med finansløkker for sky", BRIEF, "options.excludeFinanceDerived === true ? all.filter((loop) => !isFinanceDerivedLoopType(loop.loop_type)) : all", "all", K2],
  ["B25", "K2: kalibreringsrapporten tar med finansløkker for sky", OLS, ".filter((r) => options.excludeFinanceDerived !== true || !isFinanceDerivedLoopType(r.loop_type))", ".filter(() => true)", K2],
  // ---- K2: samtalegrafen ----
  ["B30", "K2: tverr-kanal-spørringen utelater ikke finansløkker (valget ignoreres)", CGS, "const excludeFinance = options.excludeFinanceDerived === true;", "const excludeFinance = false;", K2],
  ["B31", "K2: tverr-kanal-køen sender ikke tilbakeholdet til tjenesten", CGT, "tenantId, memorySpace, undefined, withhold ? { excludeFinanceDerived: true } : undefined", "tenantId, memorySpace, undefined, undefined", K2],
  ["B32", "K2: identitetsvisningen har ikke det nøytrale merket for sky", CGT, "data: (withhold ? { ...view, ...financeWithheldMarker() } : view)", "data: (view)", K2],
  // ---- K2: executive (kø, status, kontrollflate, sentre, rapporter) ----
  ["B40", "K2: situasjoner i `spend` filtreres ikke bort FØR rangeringen", EXSVC, "const situations = withholdFinance ? allSituations.filter((s) => !financeSituationIds.has(s.situation_id)) : allSituations;", "const situations = allSituations;", K2],
  ["B41", "K2: `owner_control` beholder frosne finanskoblinger", EXFW, "frozen_connectors: state.frozen_connectors.filter((f) => !isFinanceConnectorId(f.connector_id)).map(", "frozen_connectors: state.frozen_connectors.map(", K2],
  ["B42", "K2: `owner_control` beholder nødbryterens fritekst-begrunnelse", EXFW, "kill_switch: { ...state.kill_switch, reason: null },", "kill_switch: { ...state.kill_switch },", K2],
  ["B43", "K2: delegeringstavlen beholder autonomi-bindinger for `spend`/finansverktøy", EXFW, "return policies.filter((p) => !isFinanceDerivedSituationDomain(p.domain) && !isFinanceToolId(p.tool_id));", "return [...policies];", K2],
  ["B44", "K2: SLO-rapporten beholder kostnadsdriften (`cost_per_call_ore`)", EXFW, 'report.drift.findings.filter((f) => f.metric !== "cost_per_call_ore")', "report.drift.findings", K2],
  ["B45", "K2: AI-senteret holdes ikke tilbake fra sky (`ai` ut av listen over vakt-styrte sentre)", EXTOOLS, 'GUARDED_CLOUD_WITHHELD_CENTERS: readonly ControlCenterId[] = ["authority", "integration", "ai"];', 'GUARDED_CLOUD_WITHHELD_CENTERS: readonly ControlCenterId[] = ["authority", "integration"];', K2],
  ["B46", "K2: de vakt-styrte sentrene holdes aldri tilbake (kun H2-listen gjelder)", EXTR, "if ((isCloudWithheldCenter(center) || (guarded && isGuardedCloudWithheldCenter(center))) && cloud && this.service.hasControlCenter(center)) {", "if ((isCloudWithheldCenter(center)) && cloud && this.service.hasControlCenter(center)) {", K2],
  ["B47", "K2: `get_connector_status` beholder finanskoblingene for sky", EXTR, "const connectors = shapeConnectorsForCloud(status.connectors);", "const connectors = status.connectors;", K2],
  ["B48", "K2: `get_value_report` holdes ikke tilbake fra sky", EXTR, "if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };\n        const report = await this.service.getValueReport(identity.tenant_id);", "const report = await this.service.getValueReport(identity.tenant_id);", K2],
  ["B49", "K2: `get_ai_mesh_status` holdes ikke tilbake fra sky", EXTR, "if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };\n        const report = await this.service.getAiMeshStatus();", "const report = await this.service.getAiMeshStatus();", K2],
  // ---- K2: run_rate ----
  ["B50", "K2: `get_cost_overview` holdes ikke tilbake fra sky", RR, "if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };\n", "", K2],
  ["B51", "K2: vedlikeholdsloggen beholder finanskoblingene (`by_connector`) for sky", RR, "const by_connector = r.maintenance.by_connector.filter((m) => !isFinanceConnectorId(m.connector_id));", "const by_connector = r.maintenance.by_connector;", K2],
  // ---- strukturvaktene (K1 iii / K4e): en ny leser eller en ny setter må feile testen ----
  ["B60", "K1/K2: en NY leser av den sentrale lesningen i en kjent fil (strukturvakten pinner antall per fil)", EXTR, "const report = await this.service.getInfraStatus(identity.tenant_id);", "void withholdFinanceFromCurrentModel();\n        const report = await this.service.getInfraStatus(identity.tenant_id);", ["apps/api/test/wpn1b-structure.test.ts"]],
  ["B61", "K1: et ANNET sted setter modell-skopet (strukturvakten: `runWithModelScope(` kalles nøyaktig én gang)", "modules/tool-gateway/src/mesh-bridge.ts", "servingModel: { provider: call.provider, model: call.model },", "servingModel: { provider: call.provider, model: call.model }, // @ts-expect-error mutant\n      __n1b: runWithModelScope({ servingModel: { provider: call.provider, model: call.model } }, () => 0),", ["apps/api/test/wpn1b-structure.test.ts"]]
];

if (process.argv.includes("--list")) {
  for (const [id, description, file, , , tests, equivalent] of MUTANTS) console.log(`${id}\t${equivalent ? "ekvivalent" : "skal drepes"}\t${file}\t${description}\t${tests.join(",")}`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [id, , file, oldText] of MUTANTS) {
    const n = readFileSync(resolve(ROOT, file), "utf8").split(oldText).length - 1;
    if (n !== 1) { bad += 1; console.log(id, "INVALID", n); }
  }
  console.log(bad === 0 ? `OK: ${MUTANTS.length} mønstre, hvert nøyaktig én gang` : `${bad} ugyldige`);
  process.exit(bad === 0 ? 0 : 1);
}

const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("--")));
const runAs = process.env["N1B_RUN_AS"];
const results = [];
for (const [id, description, file, oldText, newText, tests, equivalent] of MUTANTS) {
  if (only.size > 0 && !only.has(id)) continue;
  const path = resolve(ROOT, file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(oldText).length - 1;
  if (occurrences !== 1) {
    results.push({ id, status: "INVALID", detail: `mønsteret forekommer ${occurrences} ganger` });
    console.log(id, "INVALID", occurrences);
    continue;
  }
  let status = "ERROR";
  try {
    writeFileSync(path, original.replace(oldText, () => newText));
    const vitest = `pnpm exec vitest run --maxWorkers=${process.env["N1B_WORKERS"] ?? "2"} --bail=1 ${tests.join(" ")}`;
    const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", npm_config_manage_package_manager_versions: "false" };
    const proc = runAs
      ? spawnSync("su", [runAs, "-s", "/bin/bash", "-c", `export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=${process.env["PATH"]} NODE_OPTIONS=--max-old-space-size=2048; cd ${ROOT} && timeout -k 5 600 ${vitest}`], { encoding: "utf8" })
      : spawnSync("bash", ["-c", `timeout -k 5 600 ${vitest}`], { encoding: "utf8", env });
    // Skill assertion-drap (minst én test feilet) fra tekniske brudd (kompilering/innlasting/tidsavbrudd uten en feilet test) - kun det første er et ekte drap.
    const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
    const testFailed = /Tests\s+(?:\d+ passed \| )?\d+ failed/.test(output) || /AssertionError/.test(output);
    status = proc.status === 0 ? "SURVIVED" : testFailed ? "KILLED" : "TECHNICAL";
  } finally {
    writeFileSync(path, original);
  }
  results.push({ id, status, equivalent: equivalent === true });
  console.log(id, status, equivalent ? "(ekvivalent forventet)" : "", description);
}
const killed = results.filter((r) => r.status === "KILLED").length;
const survivors = results.filter((r) => r.status === "SURVIVED");
console.log(`\nTOTALT ${results.length}  DREPT (assertion) ${killed}  TEKNISKE BRUDD ${JSON.stringify(results.filter((r) => r.status === "TECHNICAL").map((r) => r.id))}  OVERLEVDE ${JSON.stringify(survivors.map((r) => r.id))}  ugyldige ${JSON.stringify(results.filter((r) => r.status === "INVALID").map((r) => r.id))}`);
process.exit(results.some((r) => r.status === "INVALID" || r.status === "TECHNICAL" || (r.status === "SURVIVED" && !r.equivalent) || r.status === "ERROR") ? 1 : 0);
