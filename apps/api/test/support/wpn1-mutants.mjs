#!/usr/bin/env node
// WP-N1 (K7e): MUTANTSETTET. Hver mutant er én tekstendring i produksjonskoden som SKAL få minst én N1-test til å feile («drept»).
// Kjør fra repo-roten (DB-testene kan ikke kjøre som root: `N1_RUN_AS=postgres node apps/api/test/support/wpn1-mutants.mjs [id ...]`).
// Filen gjenopprettes ALLTID etter hver mutant (også ved feil). `--list` skriver kun settet. Et mønster som ikke lenger finnes nøyaktig én gang gir INVALID
// (kildekoden har endret seg - oppdater mutanten, ikke testen). Overlevende mutanter må enten drepes av en ny test eller begrunnes som ekvivalente (se `equivalent`).
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const ENGINE = [
  "apps/api/test/wpn1-engine-guard.test.ts", "apps/api/test/wpn1-flag-off-differential.test.ts", "modules/model-gateway/test/wpn1-restricted-history.test.ts", "apps/api/test/wpn1-guard-env.test.ts"
];
const GATEWAY = ["modules/tool-gateway/test/wpn1-finance-execution-lock.test.ts"];
const STORE_TESTS = ["modules/core/test/wpn1-messages-restricted.test.ts"];
const NEST = ["apps/api/test/wpn1-nested-finance-lock.test.ts"];
const PRED = ["apps/api/test/wpn1-lock-predicate.test.ts", "apps/api/test/wpn1-nested-finance-lock.test.ts"];
const DELIV = ["apps/api/test/wpn1-job-delivery.test.ts"];
const FAST = ["apps/api/test/wpn1-council-fast.test.ts"];
const EXEC_SVC = "modules/executive/src/service.ts";
const EXEC_TR = "modules/executive/src/transport.ts";
const CJ = "apps/api/src/chat-jobs.ts";
const MESH = "modules/tool-gateway/src/mesh-bridge.ts";
const MAIN = "apps/api/src/main.ts";
const TTR = "apps/api/src/tool-turn-route.ts";
const CONV = "apps/api/src/conversation.ts";
const GUARD = "apps/api/src/restricted-context-guard.ts";
const SENS = "modules/model-gateway/src/content-sensitivity.ts";
const GW = "modules/tool-gateway/src/gateway.ts";
const MAN = "modules/tool-gateway/src/tool-manifest.ts";
const STORE = "modules/core/src/services/message-store.ts";
const MIG = "modules/core/src/db/migrations/140_messages_restricted.sql";

/** [id, beskrivelse, fil, gammel tekst, ny tekst, testfiler, ekvivalent?] */
export const MUTANTS = [
  ["M01", "fjern merking ved turstart (låst tur merkes aldri)", CONV, 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(', 'if (false && marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(', ENGINE],
  ["M02", "merk bare assistent (brukermeldingen merkes aldri)", GUARD, 'const marked = await this.store.markRestricted(this.identity, this.userMessageId);\n    if (marked !== true) throw new Error("restricted_marking_failed");', "const marked = true;\n    void marked;", ENGINE],
  ["M03", "merk bare brukermelding (assistentsvar lagres aldri begrenset)", CONV, 'if (marker?.locked === true) await this.deps.messages.save(identity, "assistant", content, { restricted: true });', 'if (false && marker?.locked === true) await this.deps.messages.save(identity, "assistant", content, { restricted: true });', ENGINE],
  ["M04", "hopp over reserve (tilbakefall til lokal visning låser ikke turen)", CONV, 'if (marker && cloudVariant !== undefined && fullView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(fullView.sensitivityDecision.reasons);', "", ENGINE],
  ["M05", "snu par-regelen i withholdSensitiveMessages", SENS, 'if (role === "assistant" && messages[index - 1]?.role === "user") drop[index - 1] = true;', 'if (role === "assistant" && messages[index - 1]?.role === "assistant") drop[index - 1] = true;', ENGINE],
  ["M06", "snu par-regelen i partitionHistoryBySensitivity", SENS, 'if (role === "user" && history[index + 1]?.role === "assistant") drop[index + 1] = true;', 'if (role === "user" && history[index + 1]?.role === "user") drop[index + 1] = true;', ENGINE],
  ["M07", "glem halen", SENS, "if (firstRecent >= 0) {", "if (false && firstRecent >= 0) {", ENGINE],
  ["M08", "lekk gjennom protect (snudd)", SENS, "if (!(options.protect?.(messages[index]!, index) ?? false)) drop[index] = true;", "if ((options.protect?.(messages[index]!, index) ?? false)) drop[index] = true;", ENGINE],
  ["M09", "partisjonen ignorerer merket", SENS, 'return message.restricted === true ? "SECRET_RESTRICTED" :', 'return false ? "SECRET_RESTRICTED" :', ENGINE],
  ["M10", "ikke-eksakt true (enhver sann verdi er et merke)", SENS, 'return message.restricted === true ? "SECRET_RESTRICTED" :', 'return Boolean(message.restricted) ? "SECRET_RESTRICTED" :', ENGINE],
  ["M11", "flagg-AV-lekkasje (merker leses uten flagget)", CONV, "...(guardOn && m.restricted === true ? { restricted: true as const } : {})", "...(m.restricted === true ? { restricted: true as const } : {})", ENGINE],
  ["M12", "løft ikke turen (merket rad i konteksten gir ingen lås)", CONV, "const classified = guardOn && history.some((m) => m.restricted === true)", "const classified = false && history.some((m) => m.restricted === true)", ENGINE],
  ["M13", "lekk merket til modellen (wireMessages sender raden uendret)", CONV, "rows.map(({ role, content }) => ({ role, content }));", "rows.map((row) => ({ ...row }));", ENGINE],
  ["M14", "kostnadsrapporten merkes ikke", GUARD, "  cost_report: true,", "  cost_report: false,", ENGINE],
  ["M15", "rådet merkes ikke", CONV, 'if (marker && councilSensitivity === "SECRET_RESTRICTED") await marker.lock(', 'if (false && marker && councilSensitivity === "SECRET_RESTRICTED") await marker.lock(', ENGINE],
  ["M16", "minneuttrekket får merkede rader", CONV, "(this.deps.restrictedContextGuard === true ? recent.filter((m) => m.restricted !== true) : recent)", "(recent)", ENGINE],
  ["M17", "over-merking: en trygg skyvariant merkes", CONV, 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(', 'if (marker && (primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED" || cloudVariant !== undefined)) await marker.lock(', ENGINE],
  ["M18", "fail-open: manglende markering svelges", GUARD, 'if (marked !== true) throw new Error("restricted_marking_failed");', "void marked;", ENGINE],
  ["M19", "bakgrunnsjobb låst av ruteavgjørelsen merkes ikke", CONV, "(FAST_INTENT_RESTRICTED[intent.kind] || delegatedRestricted === true)", "(FAST_INTENT_RESTRICTED[intent.kind])", ENGINE],
  ["M20", "skyvarianten holder ikke merkede rader unna", SENS, "const direct = messages.map((message) => RANK[messageSensitivity(message)] > RANK[ceiling]);", "const direct = messages.map((message) => RANK[classifyContentSensitivity({ texts: [message.content] }).sensitivity] > RANK[ceiling]);", ENGINE],
  ["M21", "løftet blir bare PRIVATE", CONV, 'sensitivity: maxSensitivity(classifiedByText.sensitivity, "SECRET_RESTRICTED"),', 'sensitivity: maxSensitivity(classifiedByText.sensitivity, "PRIVATE"),', ENGINE],
  ["M22", "lås uten å vente og med svelget feil (fail-open)", CONV, 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(primaryView.sensitivityDecision.reasons);', 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") void marker.lock(primaryView.sensitivityDecision.reasons).catch(() => undefined);', ENGINE],
  ["M23", "minneuttrekkets filter snudd", CONV, "recent.filter((m) => m.restricted !== true)", "recent.filter((m) => m.restricted === true)", ENGINE],
  ["M24", "rådet uten konfigurasjon merkes ikke", CONV, 'if (marker && classifyContentSensitivity({ texts: [text], memory_spaces: [identity.memory_space_id] }).sensitivity === "SECRET_RESTRICTED") await marker.lock(["council:unconfigured"]);', "", ENGINE],
  ["M30", "fail-open ved ukjent/blank leverandør", GW, 'model.provider.trim() === "") return true;', 'model.provider.trim() === "") return false;', GATEWAY],
  ["M31", "fail-open uten servedLocally-predikat", GW, 'if (typeof local !== "function") return true;', 'if (typeof local !== "function") return false;', GATEWAY],
  ["M32", "fail-open når predikatet kaster", GW, "      return local(model) !== true;\n    } catch {\n      return true;", "      return local(model) !== true;\n    } catch {\n      return false;", GATEWAY],
  ["M33", "ikke-true tolkes som lokal", GW, "return local(model) !== true;", "return local(model) === false;", GATEWAY],
  ["M34", "utførelseslåsen fjernet", GW, "if (this.options?.financeExecutionLock !== undefined && isFinancialNamespace(request.tool_id)", "if (false && this.options?.financeExecutionLock !== undefined && isFinancialNamespace(request.tool_id)", GATEWAY],
  ["M35", "over-lås: uten servingModel nektes også", GW, "if (model === undefined) return false;", "if (model === undefined) return true;", GATEWAY],
  ["M36", "navnerom-mønsteret svekket", MAN, "const FINANCIAL_NAMESPACES = /^(finance|finance_[a-z]+)$/;", "const FINANCIAL_NAMESPACES = /^(finance)$/;", GATEWAY],
  ["M40", "markRestricted uten sesjonsavgrensning", STORE, "WHERE message_id = $1 AND tenant_id = $2 AND session_id = $3 AND restricted = false", "WHERE message_id = $1 AND tenant_id = $2 AND ($3::text IS NOT NULL) AND restricted = false", STORE_TESTS],
  ["M41", "markRestricted ikke idempotent", STORE, "AND session_id = $3 AND restricted = false`", "AND session_id = $3`", STORE_TESTS],
  ["M42", "save ignorerer {restricted: true}", STORE, "if (restricted) {", "if (false && restricted) {", STORE_TESTS],
  ["M43", "history() returnerer ikke restricted", STORE, "SELECT message_id, role, content, created_at, restricted FROM messages", "SELECT message_id, role, content, created_at, false AS restricted FROM messages", STORE_TESTS],
  ["M44", "enveis-triggeren fjernet fra migrasjonen", MIG, "CREATE TRIGGER messages_restricted_monotonic\n  BEFORE UPDATE ON messages\n  FOR EACH ROW EXECUTE FUNCTION messages_restricted_monotonic();", "", STORE_TESTS],
  ["M45", "kolonne-nivå UPDATE utvidet til hele tabellen", MIG, "GRANT UPDATE (restricted) ON messages TO jarvis_app;", "GRANT UPDATE ON messages TO jarvis_app;", STORE_TESTS],
  ["M46", "revisjonen bærer innhold", STORE, "payload: { message_id: messageId }", 'payload: { message_id: messageId, content: "lekk" }', STORE_TESTS],
  ["M47", "markRestricted uten eksplisitt tenant-klausul (kun RLS)", STORE, "WHERE message_id = $1 AND tenant_id = $2 AND session_id = $3 AND restricted = false", "WHERE message_id = $1 AND ($2::text IS NOT NULL) AND session_id = $3 AND restricted = false", STORE_TESTS],
  ["M49", "verdirapporten merkes ikke", GUARD, "  value_report: true,", "  value_report: false,", ENGINE],
  ["M50", "flagg AV: assistentlagring får et fjerde argument", CONV, 'else await this.deps.messages.save(identity, "assistant", content);', 'else await this.deps.messages.save(identity, "assistant", content, { restricted: false });', ENGINE],
  ["M51", "flagg AV: brukerlagring får et fjerde argument", CONV, 'const userMessageId = await this.deps.messages.save(identity, "user", text);', 'const userMessageId = await this.deps.messages.save(identity, "user", text, {});', ENGINE],
  ["M52", "main.ts gir motoren vakten ubetinget", "apps/api/src/main.ts", "...(restrictedContextGuard.enabled ? { restrictedContextGuard: true } : {}),", "...{ restrictedContextGuard: true },", ENGINE],
  ["M53", "parseren godtar også «true»", GUARD, 'return { enabled: env[RESTRICTED_CONTEXT_GUARD_FLAG] === "on" };', 'return { enabled: env[RESTRICTED_CONTEXT_GUARD_FLAG] === "on" || env[RESTRICTED_CONTEXT_GUARD_FLAG] === "true" };', ENGINE],
  ["M54", "flagget fjernet fra SERVICE_ENV.api", "infra/local/service-env.mjs", '    "JARVIS_RESTRICTED_CONTEXT_GUARD"],', "    ],", ENGINE],
  // ---- Fiks-runde 1 (F-B1, F-B2/F-A1, F-A2, F-A3, F-A4, F-A5, F-A6b, F-A8, F-B4): mutanter for den NYE koden ----
  ["M60", "F-B1: statusavlesningen ignorerer withholdFinance (nøstet finance-kall gjøres alltid)", EXEC_SVC, 'requireData<{ paused: string[] }>(this.gateway, identity, "situations", "get_pause_state"),\n      withholdFinance ? Promise.resolve(null) :', 'requireData<{ paused: string[] }>(this.gateway, identity, "situations", "get_pause_state"),\n      false ? Promise.resolve(null) :', NEST],
  ["M61", "F-B1: delegeringstavlen ignorerer withholdFinance", EXEC_SVC, 'requireData<OwnerControlState>(this.gateway, identity, "owner_controls", "get_control_state"),\n      withholdFinance ? Promise.resolve(null) :', 'requireData<OwnerControlState>(this.gateway, identity, "owner_controls", "get_control_state"),\n      false ? Promise.resolve(null) :', NEST],
  ["M62", "F-B1: transporten sender ikke withholdFinance for statusen", EXEC_TR, "? await this.service.getControlSurfaceStatus(identity, { withholdFinance: true })", "? await this.service.getControlSurfaceStatus(identity)", NEST],
  ["M63", "F-B1: transporten sender ikke withholdFinance for tavlen", EXEC_TR, "? await this.service.getDelegationBoard(identity, { withholdFinance: true })", "? await this.service.getDelegationBoard(identity)", NEST],
  ["M64", "F-B1: withholdsFinanceFromCloud er alltid false", EXEC_SVC, "return this.options.withholdFinanceFromCloud === true && this.isCloudServed(model);", "return false;", NEST],
  ["M65", "F-B1: withholdsFinanceFromCloud invertert (lokal holdes tilbake, sky slipper)", EXEC_SVC, "return this.options.withholdFinanceFromCloud === true && this.isCloudServed(model);", "return this.options.withholdFinanceFromCloud === true && !this.isCloudServed(model);", NEST],
  ["M66", "F-B1: withholdsFinanceFromCloud ignorerer valget (alltid på for sky, også med vakten AV)", EXEC_SVC, "return this.options.withholdFinanceFromCloud === true && this.isCloudServed(model);", "return this.isCloudServed(model);", NEST],
  ["M67", "F-B1: «holdt tilbake»-merket fjernet (null ser ut som «ingen nødbryter»)", EXEC_SVC, "finance_kill_switch: financeKillSwitch, ...(withholdFinance ? { finance_kill_switch_withheld: true as const } : {}) };", "finance_kill_switch: financeKillSwitch };", NEST],
  ["M68", "F-B2: lokalitetsprediktatet invertert", GUARD, "return !servedByCloudModel({ provider: model.provider });", "return servedByCloudModel({ provider: model.provider });", PRED],
  ["M69", "F-B2: lokalitetsprediktatet alltid lokal (låsen inert)", GUARD, "return !servedByCloudModel({ provider: model.provider });", "return true;", PRED],
  ["M70", "F-B2: lokalitetsprediktatet alltid sky", GUARD, "return !servedByCloudModel({ provider: model.provider });", "return false;", PRED],
  ["M71", "F-A2: restricted_origin skrives aldri i jobbkontrakten", CJ, "...(context?.restrictedOrigin === true ? { restricted_origin: true } : {})", "", DELIV],
  ["M72", "F-A2: sveipet leser aldri restricted_origin", CJ, 'if (row.restricted_origin === "true") await this.options.saveMessage(', 'if (false && row.restricted_origin === "true") await this.options.saveMessage(', DELIV],
  ["M73", "F-A2: leveringslagringen ignorerer vakten (flagg AV lagrer begrenset)", GUARD, "guardEnabled && opts?.restricted === true ? store.save(", "opts?.restricted === true ? store.save(", DELIV],
  ["M74", "F-A2: gatewayen videreformidler ikke restrictedOrigin til transporten", GW, "...(request.restrictedOrigin === true ? { restrictedOrigin: true as const } : {}),", "", DELIV],
  ["M75", "F-A2: MeshToolExecutor videreformidler ikke turbildets restricted", MESH, "...(this.turn?.restricted === true ? { restrictedOrigin: true as const } : {})", "", DELIV],
  ["M76", "F-A2: motoren gir executoren et ulåst turbilde i en låst tur", CONV, "marker?.locked === true ? { ...turn, restricted: true as const } : turn", "turn", ENGINE],
  ["M77", "F-A2: hurtigbanen sender ikke restricted til delegateBackground.run", CONV, "...(cloud.restricted === true ? { restricted: true as const } : {}) }).catch(() => null)", " }).catch(() => null)", FAST],
  ["M78", "F-A6b: hurtigbanen låser ETTER jobbstarten", CONV, 'if (marker && cloud.restricted === true) await marker.lock(["fast_intent:delegate_background"]);\n        const started = this.deps.delegateBackground\n          ? await this.deps.delegateBackground.run(identity, intent.prompt, { cloudAllowed: cloud.allowed, ...(cloud.restricted === true ? { restricted: true as const } : {}) }).catch(() => null)\n          : null;', 'const started = this.deps.delegateBackground\n          ? await this.deps.delegateBackground.run(identity, intent.prompt, { cloudAllowed: cloud.allowed, ...(cloud.restricted === true ? { restricted: true as const } : {}) }).catch(() => null)\n          : null;\n        if (marker && cloud.restricted === true) await marker.lock(["fast_intent:delegate_background"]);', FAST],
  ["M79", "F-A4: slo_report merkes ikke", GUARD, "  slo_report: true,", "  slo_report: false,", ENGINE],
  ["M80", "F-A4: self_diagnosis merkes ikke", GUARD, "  self_diagnosis: true,", "  self_diagnosis: false,", ENGINE],
  ["M81", "F-A4: system_status merkes ikke", GUARD, "  system_status: true,", "  system_status: false,", ENGINE],
  ["M82", "F-B4/I2: save normaliserer fail-open (kun eksakt true er begrenset)", STORE, "const restricted = opts?.restricted !== undefined && opts.restricted !== false;", "const restricted = opts?.restricted === true;", [...STORE_TESTS, "modules/core/test/wpn1-message-store-sql.test.ts"]],
  ["M83", "F-A8: servingModel stemples ikke av MeshToolExecutor", MESH, "servingModel: { provider: call.provider, model: call.model },", "", ["apps/api/test/wpn1-stamping-structure.test.ts", ...GATEWAY]],
  ["M84", "F-A2: main.ts gir leveringslagringen vakten ubetinget", MAIN, "createDeliverySaver(new MessageStore(pool), restrictedContextGuard.enabled)", "createDeliverySaver(new MessageStore(pool), true)", DELIV],
  ["M85", "F-B1: main.ts gir executive-tjenesten withholdFinanceFromCloud ubetinget", MAIN, "...(restrictedContextGuard.enabled ? { withholdFinanceFromCloud: true } : {}),", "withholdFinanceFromCloud: true,", ENGINE],
  ["M86", "F-B2: main.ts gir gatewayen en svak inline-lås i stedet for FINANCE_EXECUTION_LOCK", MAIN, "{ financeExecutionLock: FINANCE_EXECUTION_LOCK }", "{ financeExecutionLock: { servedLocally: () => true } }", ENGINE],
  ["M87", "F-A6b: kost-/selvdiagnose-rapportene låses ETTER at intensjonen er kjørt", CONV, "if (marker && FAST_INTENT_RESTRICTED[intent.kind]) await marker.lock([`fast_intent:${intent.kind}`]);\n      const result = await this.handleFastIntent(identity, intent, text, surface, provider, marker);", "const result = await this.handleFastIntent(identity, intent, text, surface, provider, marker);\n      if (marker && FAST_INTENT_RESTRICTED[intent.kind]) await marker.lock([`fast_intent:${intent.kind}`]);", FAST],
  ["M88", "F-A5: history:restricted-merknaden lover usann varighet («til emnet er borte»)", TTR, '? " Samtalen holdes lokal så lenge en begrenset melding er blant de siste meldingene."', '? " Dette varer til emnet ikke lenger er blant de siste meldingene."', FAST],
  ["M89", "F-A2: restricted levering lagres uten merke (tre argumenter)", CJ, 'await this.options.saveMessage({ ...base, session_id: sessionId }, "assistant", text, { restricted: true });', 'await this.options.saveMessage({ ...base, session_id: sessionId }, "assistant", text);', DELIV],
  ["M90", "F-A5/X01: turer låst KUN av et arvet merke (history:restricted) merkes ikke (alternativ (b) lekker)", CONV, 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED") await marker.lock(primaryView.sensitivityDecision.reasons);', 'if (marker && primaryView.sensitivityDecision.sensitivity === "SECRET_RESTRICTED" && primaryView.sensitivityDecision.reasons.some((r) => r !== "history:restricted")) await marker.lock(primaryView.sensitivityDecision.reasons);', ENGINE],
  // Ekvivalent (dybdeforsvar): `withholdSensitiveMessages` tar allerede ALLE merkede rader, så belt-og-seler-sjekken i `cloudVariantFor` kan ikke observeres utenfra.
  ["M48", "[ekvivalent] cloudVariantFor uten belt-og-seler-sjekken", CONV, "if (this.deps.restrictedContextGuard === true && cleanHistory.some((m) => m.restricted === true)) return undefined;", "", ENGINE, true]
];

if (process.argv.includes("--list")) {
  for (const [id, description, file, , , tests, equivalent] of MUTANTS) console.log(`${id}\t${equivalent ? "ekvivalent" : "skal drepes"}\t${file}\t${description}\t${tests.join(",")}`);
  process.exit(0);
}

const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("--")));
const runAs = process.env["N1_RUN_AS"];
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
    const vitest = `pnpm exec vitest run --maxWorkers=2 --bail=1 ${tests.join(" ")}`;
    const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", npm_config_manage_package_manager_versions: "false" };
    const proc = runAs
      ? spawnSync("su", [runAs, "-s", "/bin/bash", "-c", `export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=${process.env["PATH"]} NODE_OPTIONS=--max-old-space-size=2048; cd ${ROOT} && timeout -k 5 600 ${vitest}`], { encoding: "utf8" })
      : spawnSync("bash", ["-c", `timeout -k 5 600 ${vitest}`], { encoding: "utf8", env });
    // Fiks-runde 1: skill assertion-drap (minst én test feilet) fra tekniske brudd (kompilering/innlasting/tidsavbrudd uten en feilet test) - kun det første er et ekte drap.
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
console.log(`\nTOTALT ${results.length}  DREPT (assertion) ${killed}  TEKNISKE BRUDD ${JSON.stringify(results.filter((r) => r.status === "TECHNICAL").map((r) => r.id))}  OVERLEVDE ${JSON.stringify(survivors.map((r) => r.id))}  UGYLDIGE ${JSON.stringify(results.filter((r) => r.status === "INVALID").map((r) => r.id))}`);
process.exit(results.some((r) => r.status === "INVALID" || r.status === "TECHNICAL" || (r.status === "SURVIVED" && !r.equivalent) || r.status === "ERROR") ? 1 : 0);
