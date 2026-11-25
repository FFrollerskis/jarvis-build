import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILES } from "@jarvis/model-gateway";
import { CHAT_READ_TIER_KEYS, SURFACE_TOOL_GRANTS, isFinancialNamespace } from "@jarvis/tool-gateway";
import { CENTER_ROWS, ROWS } from "./support/n1b-rows.ts";

/**
 * WP-N1b (K1 iii + K4 e): strukturtester og kildevakter for den modell-stemplede konteksten (`model-scope.ts`) og for «nye nøstede finansoppslag uten sentral lesning».
 *  A. Skopet SETTES på ÉTT sted (`ToolGateway.execute()`) og LESES kun av en kjent liste filer. En ny leser må vurderes: delt arbeid (single-flight, cache, felt-`Promise`) kjører i den FØRSTE kallerens skop, så en leser
 *     der ville gitt en senere kaller det første kallerens avgjørelse (lekkasje den ene veien, utilgjengelighet den andre).
 *  B. Gatewayens `execute()`: vakt AV går rett til den uendrede kroppen; et skyskop løsnes aldri; lokalitetsvedtaket tas én gang med den ene regelen; kroppen leser den EFFEKTIVE modellen.
 *  C. Ingen produksjonskode overstyrer/fjerner modellen på et nøstet kall.
 *  D. Hvem som overhodet kan nå finansmodulens kjøretid (`@jarvis/finance`) uten om `ToolGateway`: kun komposisjonsroten, eierens ruter og workeren - ingen modellnåbar modul. Et nytt importsted må vurderes mot utførelseslåsen.
 *  E. `personal.finance_read` (eierens HTTP-rute, ingen modell i løkka, Q-9) har ingen modellflate og får aldri en: en kildevakt feller det hvis den noen gang kobles til verktøyregisteret, flatene eller en modellløkke.
 *  F. K2-KLASSIFISERINGEN dekker HELE modellflaten: hvert verktøynavnerom på en flate er klassifisert (et nytt navnerom feller testen til noen har vurdert om det kan bære finansavledet innhold), og i de fire navnerommene med
 *     håndtert innhold er HVER handling plassert nøyaktig ett sted (håndtert med en rad i kartleggingstabellen / skrive-handling bak bekreftelseskortet / vurdert uten finans). Ukjent = finans (strengeste regel).
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, "utf8");
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "test" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
const files = ["apps", "modules", "packages"].flatMap((top) =>
  readdirSync(`${root}${top}`, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => { try { return walk(`${root}${top}/${e.name}/src`); } catch { return []; } })
);
const SCOPE_FILE = "modules/tool-gateway/src/model-scope.ts";
const countBy = (re: RegExp, exclude: readonly string[] = []): Record<string, number> =>
  Object.fromEntries(files.flatMap((f) => {
    const rel = f.slice(root.length);
    if (exclude.includes(rel)) return [];
    const n = (code(readFileSync(f, "utf8")).match(re) ?? []).length;
    return n > 0 ? [[rel, n]] : [];
  }).sort());

describe("A: modell-skopet settes ett sted og leses kun av kjente filer", () => {
  it("skanneren ser produksjonskoden (ikke tom) og skop-modulen finnes", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(SCOPE_FILE))).toBe(true);
  });

  it("`runWithModelScope(` kalles nøyaktig ÉN gang i produksjonskoden: ToolGateway.execute() (modellen stemples av adapteren og går inn der, ingen annen kode kan sette skopet)", () => {
    expect(countBy(/\brunWithModelScope\s*\(/g, [SCOPE_FILE])).toEqual({ "modules/tool-gateway/src/gateway.ts": 1 });
  });

  it("FIX-4: ALLE forekomster av setteren (import, alias, re-eksport, kall) er pinnet: kun gatewayens import + ett kall; `index.ts` eksporterer den ikke (en alias-import uten ordet `servingModel` ville ellers sluppet forbi kallvakten)", () => {
    expect(countBy(/\brunWithModelScope\b/g, [SCOPE_FILE])).toEqual({ "modules/tool-gateway/src/gateway.ts": 2 });
    const index = code(read("modules/tool-gateway/src/index.ts"));
    expect(index).not.toMatch(/export\s*\*\s*from\s*"\.\/model-scope\.ts"/);
    expect(index).toMatch(/export\s*\{\s*currentModelScope,\s*currentServingModel,\s*withholdFinanceFromCurrentModel\s*\}\s*from\s*"\.\/model-scope\.ts";/);
    expect(index).toMatch(/export\s+type\s*\{\s*ModelScope,\s*ScopedServingModel\s*\}\s*from\s*"\.\/model-scope\.ts";/);
    // ingen `export *` fra pakker/filer som kan eksportere setteren videre, og ingen annen fil importerer fra `model-scope.ts` enn gatewayen (setteren + leseren), leverandør-innpakningen (kun leseren) og indeksen
    expect(Object.keys(countBy(/model-scope\.ts/g, [SCOPE_FILE])).sort()).toEqual(["modules/tool-gateway/src/finance-withheld.ts", "modules/tool-gateway/src/gateway.ts", "modules/tool-gateway/src/index.ts"]);
  });

  it("de SENTRALE LESERNE (`currentModelScope`, `currentServingModel`, `withholdFinanceFromCurrentModel`): ALLE forekomster (import, alias, re-eksport, kall) er pinnet per fil - en ny leser, en alias-import eller en ny gjenbruk må vurderes (aldri i delt arbeid som deles av flere kallere)", () => {
    // FIX-4: pinner navnet (`\bnavn\b`), ikke bare kall (`navn(`): en alias-import (`import { withholdFinanceFromCurrentModel as w }`) har navnet i importsetningen og felles teller også uten et synlig kall
    expect(countBy(/\b(?:currentModelScope|currentServingModel|withholdFinanceFromCurrentModel)\b/g, [SCOPE_FILE])).toEqual({
      "apps/api/src/run-rate.ts": 3, // import + `get_cost_overview` (kun merket) og `list_connector_maintenance` (finanskoblinger filtrert i SQL)
      "modules/business/src/transport.ts": 6, // import + åpne løkker, enkeltoppslag, oppmerksomhetskø, brief (daglig/ukentlig, én avlesning) og kalibreringsrapport
      "modules/conversation-graph/src/transport.ts": 3, // import + tverr-kanal-kø og identitetsvisning
      "modules/executive/src/service.ts": 3, // import + K1: nøstede finansavlesninger (`getControlSurfaceStatus`/`getDelegationBoard`)
      "modules/executive/src/transport.ts": 13, // import + senter-svar, oversikt, kø/enkeltoppslag, kapabilitet/connector, SLO, verdi, selvdiagnose, AI Mesh, evolusjon, driftsbilde (FIX-2)
      "modules/tool-gateway/src/finance-withheld.ts": 2, // import + `withheldFromCloudTransport` (FIX-6: leverandørsaldo)
      "modules/tool-gateway/src/gateway.ts": 2, // import + `execute()`: arver et ytre skop
      "modules/tool-gateway/src/index.ts": 3 // eksporten av de tre leserne (setteren eksporteres ikke, FIX-4)
    });
    // og kallene alene (dokumenterer hvor mange avlesninger som faktisk skjer per fil)
    expect(countBy(/\b(?:currentModelScope|currentServingModel|withholdFinanceFromCurrentModel)\s*\(/g, [SCOPE_FILE])).toEqual({
      "apps/api/src/run-rate.ts": 2, "modules/business/src/transport.ts": 5, "modules/conversation-graph/src/transport.ts": 2, "modules/executive/src/service.ts": 2, "modules/executive/src/transport.ts": 12,
      "modules/tool-gateway/src/finance-withheld.ts": 1, "modules/tool-gateway/src/gateway.ts": 1
    });
  });

  it("skop-modulen eksporterer lesere og setter, og setteren er fail-closed (`cloud` er sky med mindre kalleren eksplisitt sier `false`) og fryser skopet", () => {
    const src = code(read(SCOPE_FILE));
    expect(src).toContain("cloud: scope.cloud !== false");
    expect(src).toContain("Object.freeze(");
    expect(src).toContain("store.getStore()?.cloud === true");
    expect(src).not.toMatch(/process\.env/);
  });
});

describe("B: ToolGateway.execute() - vakt AV er identisk, et skyskop løsnes aldri, ett lokalitetsvedtak", () => {
  const gateway = code(read("modules/tool-gateway/src/gateway.ts"));
  const execute = gateway.slice(gateway.indexOf("  execute(request: ToolExecuteRequest): Promise<ToolResult> {"), gateway.indexOf("  private async executeCall(request: ToolExecuteRequest)"));

  it("`execute()` finnes som en tynn omslag, og `executeCall` er den ENE kroppen (privat, kalt kun fra execute)", () => {
    expect(execute.length).toBeGreaterThan(100);
    expect(gateway).toContain("private async executeCall(request: ToolExecuteRequest): Promise<ToolResult> {");
    expect((gateway.match(/this\.executeCall\(/g) ?? []).length).toBe(3);
    expect((execute.match(/this\.executeCall\(/g) ?? []).length).toBe(3);
  });

  it("VAKT AV: uten `financeExecutionLock` går kallet rett til den uendrede kroppen - FØR noe skop leses eller settes", () => {
    // FIX-9: HELE omslaget står i `try` (en løsrevet `execute` uten `this` avvises i stedet for å kaste synkront); første setning inni er likevel lås-avlesningen og returen av kroppens eget løfte
    const firstStatement = execute.slice(execute.indexOf("{") + 1).trimStart();
    expect(firstStatement.startsWith("try {")).toBe(true);
    expect(execute).toMatch(/try \{\s*const lock = this\.options\?\.financeExecutionLock;\s*if \(lock === undefined\) return this\.executeCall\(request\);\s*const ambient = currentModelScope\(\);/);
    expect(execute.indexOf("if (lock === undefined) return this.executeCall(request);")).toBeLessThan(execute.indexOf("currentModelScope()"));
    expect(execute.indexOf("if (lock === undefined) return this.executeCall(request);")).toBeLessThan(execute.indexOf("runWithModelScope("));
  });

  it("et skyskop LØSNES aldri: er det ytre kallet sky/ukjent gjelder den modellen, ellers eksplisitt, ellers arvet; vedtaket tas med `servedByCloud` (den ene regelen) eller arves", () => {
    // FIX-3: `!== undefined` (ikke `??`): en `null`/uleselig verdi er en MODELL som regnes som sky - ikke «ingen modell»
    expect(execute).toContain("const model = ambient?.cloud === true ? ambient.servingModel : (request.servingModel !== undefined ? request.servingModel : ambient?.servingModel);");
    expect(execute).not.toMatch(/request\.servingModel\s*\?\?/);
    expect(execute).toContain("const cloud = ambient?.cloud === true || this.servedByCloud(model, lock);");
    expect(execute).toContain("runWithModelScope({ servingModel: model, cloud }, () => this.executeCall(effective));");
    // ingen ny lokalitetsregel i gatewayen: bare `servedByCloud` (som igjen kun kaller den injiserte `servedLocally`)
    expect((gateway.match(/\bservedByCloud\(/g) ?? []).length).toBe(3); // definisjonen + execute + lås-sjekken i executeCall
    expect((gateway.match(/\.servedLocally\b|\bservedLocally\b/g) ?? []).length).toBeGreaterThan(0);
  });

  it("kroppen bruker den EFFEKTIVE modellen: utførelseslåsen sjekker `request.servingModel` (arvet for nøstede kall), og den samme verdien går til transportens kontekst", () => {
    expect(gateway).toContain("this.servedByCloud(request.servingModel, this.options.financeExecutionLock)");
    expect(gateway).toContain("...(request.servingModel !== undefined ? { servingModel: request.servingModel } : {})");
  });

  it("en feil i omslaget er en AVVISNING (som før N1b: `execute` var async), aldri et synkront kast", () => {
    expect(execute).toContain("return Promise.reject(err);");
  });
});

describe("C: ingen produksjonskode overstyrer eller fjerner modellen på et nøstet kall", () => {
  it("ingen `servingModel: undefined`, `delete ….servingModel` eller `servingModel: null` i produksjonskoden", () => {
    expect(countBy(/\bservingModel:\s*(?:undefined|null)\b|\bdelete\s+[\w.]*servingModel\b/g)).toEqual({});
  });

  it("`servingModel` settes eksplisitt på et `execute()`-kall på kun to steder i produksjonskoden: adapter-stemplingen i MeshToolExecutor og den arvede/effektive kopien i gatewayen selv", () => {
    // (selve stemplingen er pinnet av wpn1-stamping-structure.test.ts; her pinnes at ingen NY kode angir en modell på et gateway-kall)
    expect(countBy(/\bexecute\(\{[^}]*\bservingModel\b/g)).toEqual({});
    const hits = countBy(/\bservingModel:\s*[^,\n}]+/g);
    expect(Object.keys(hits)).toEqual(expect.arrayContaining(["modules/tool-gateway/src/mesh-bridge.ts"]));
  });
});

describe("D: hvem kan nå finansmodulens kjøretid uten om ToolGateway-låsen", () => {
  it("kun komposisjonsroten, eierens ruter, workeren, personlig-økonomi-ledningen og Finans-senteret importerer VERDIER fra `@jarvis/finance` (typeimporter er fri); ingen modellnåbar modul gjør det", () => {
    expect(countBy(/import\s+(?!type\b)[^;]*?from\s+"@jarvis\/finance"/gs)).toEqual({
      "apps/api/src/control-center/finance.ts": 1,
      "apps/api/src/main.ts": 1,
      "apps/api/src/personal-wiring.ts": 1,
      "apps/api/src/server.ts": 1,
      "apps/api/src/worker-main.ts": 1
    });
  });

  it("ingen annen modul under `modules/*/src` (utenom finans-modulen selv) importerer `@jarvis/finance` som verdi: executive/business/situations/growth/... går KUN via ToolGateway", () => {
    const hits = Object.keys(countBy(/import\s+(?!type\b)[^;]*?from\s+"@jarvis\/finance"/gs)).filter((f) => f.startsWith("modules/") && !f.startsWith("modules/finance/"));
    expect(hits).toEqual([]);
  });
});

describe("E: personal.finance_read (eierens HTTP-rute) har ingen modellflate - og feller hvis den får en", () => {
  const FINANCE_READ_FILE = "apps/api/src/personal-finance-read.ts";

  it("`personal-finance-read.ts` importeres kun av rute-ledningen (`personal-routes.ts`) og oppstartsledningen (`personal-wiring.ts`)", () => {
    expect(Object.keys(countBy(/from\s+"\.\/personal-finance-read\.ts"/g)).sort()).toEqual(["apps/api/src/personal-routes.ts", "apps/api/src/personal-wiring.ts"]);
  });

  it("filen importerer verken ToolGateway, MeshToolExecutor, samtalemotoren eller en modellgateway (ingen modell kan være i løkka), og kjører kun bak eier + step-up", () => {
    const src = code(read(FINANCE_READ_FILE));
    expect(src).not.toMatch(/\b(?:ToolGateway|MeshToolExecutor|ConversationEngine|ModelGateway|completeWithTools|executorFor)\b/);
    expect(src).toContain("ctx.requireOwner(");
    expect(src).toContain("ctx.stepUpDenial(");
  });

  it("verktøyregisteret og ALLE modellflater har ingen `personal`-oppføring (ingen `personal.finance_read` som verktøy), og navnet står ikke i noen tildeling", () => {
    for (const [surface, grants] of Object.entries(SURFACE_TOOL_GRANTS)) {
      expect(grants.filter((g) => g.tool_id === "personal" || /finance_read/.test(g.action)), surface).toEqual([]);
    }
    // navnet står kun i selve rutehåndtereren (eier-porten `requireOwner`) og som et loggfelt i oppstartsledningen - aldri i en verktøydefinisjon eller tildeling
    expect(countBy(/["'`]finance_read["'`]/g)).toEqual({ "apps/api/src/personal-finance-read.ts": 1, "apps/api/src/personal-wiring.ts": 1 });
  });
});

describe("F: K2-klassifiseringen dekker hele modellflaten (ukjent = finans: et nytt navnerom eller en ny handling må vurderes)", () => {
  type NsClass = "locked_finance" | "handled_k2" | "handled_n1" | "own_domain" | "external" | "deferred";
  /**
   * ALLE verktøynavnerom som står på en modellflate (`SURFACE_TOOL_GRANTS`), med hvorfor det er plassert der. `handled_k2`/`handled_n1`/`locked_finance` er håndhevet VED UTFØRELSE og bevist av tabelltesten/N1-testene.
   * `own_domain` = Jarvis' egne forretningsdomener, kartlagt: leser ikke `finance_*`, ingen beløpsfelt avledet av finansdata (kontrakter/driftsoppgaver/produkt/support har ingen beløpsfelt i det hele tatt).
   * `external` = leverandørens innhold (EXTERNAL_CANONICAL, ubetrodd data): ikke Jarvis-avledet finansmetadata. `deferred` = KJENT ÅPEN, med begrunnelse i runbooken (vokter: ingen sentral leser finnes i modulen, test A).
   */
  const NAMESPACE_CLASS: Readonly<Record<string, NsClass>> = {
    finance_neonomics: "locked_finance", finance_spend: "locked_finance", finance_stripe: "locked_finance", finance_vipps: "locked_finance", finance_wallester: "locked_finance",
    business: "handled_k2", conversation_graph: "handled_k2", executive: "handled_k2", run_rate: "handled_k2",
    tasks: "handled_n1",
    contract: "own_domain", operations: "own_domain", product: "own_domain", support: "own_domain",
    growth: "deferred", // annonseutgift/budsjett/CAC/ROAS i øre i Growth-kjernens egne tabeller (ikke `finance_*`): eierbeslutning (Q), se runbooken
    knowledge: "deferred", memory: "deferred", // JARVIS-116 (d) / Q-52 / D-386: lagret tekst kan bære finansavledet innhold - utenfor denne WP-en
    brave_search: "external", calendar: "external", discord: "external", drive: "external", dropbox: "external", email: "external", exa: "external", github: "external", google_maps: "external",
    google_places: "external", google_routes: "external", google_sheets: "external", googleads: "external", grafana: "external", "home-assistant": "external", hubspot: "external", jira: "external",
    linear: "external", make: "external", metaads: "external", microsoft_outlook: "external", n8n: "external", notion: "external", onedrive: "external", pipedrive: "external", prometheus: "external",
    sentry: "external", slack: "external", spotify: "external", tavily: "external", telegram: "external", telnyx: "external", todoist: "external", trello: "external", twilio: "external", vercel: "external",
    whatsapp: "external"
  };
  const grants = Object.values(SURFACE_TOOL_GRANTS).flat();
  const namespaces = [...new Set(grants.map((g) => g.tool_id))].sort();
  const actionsOf = (toolId: string): string[] => [...new Set(grants.filter((g) => g.tool_id === toolId).map((g) => g.action))].sort();

  it("hvert verktøynavnerom på en modellflate er klassifisert, og ingen oppføring er foreldet", () => {
    expect(namespaces.length).toBe(54);
    expect(Object.keys(NAMESPACE_CLASS).sort()).toEqual(namespaces);
  });

  it("finansnavnerommene (`isFinancialNamespace`) er NØYAKTIG de som er låst av utførelseslåsen - ingen finans-id med annen klasse, og ingen låst id som ikke er finans", () => {
    expect(namespaces.filter((n) => isFinancialNamespace(n))).toEqual(Object.keys(NAMESPACE_CLASS).filter((n) => NAMESPACE_CLASS[n] === "locked_finance").sort());
  });

  /** De fire navnerommene der finansavledet innhold ER håndtert: HVER handling står nøyaktig ett sted. */
  const K2_PLACEMENT: Readonly<Record<string, { handled: readonly string[]; handled_h2: readonly string[]; read_no_finance: readonly string[] }>> = {
    business: {
      handled: ["list_open_loops", "read_open_loop", "get_attention_queue", "get_business_brief", "get_calibration_report"],
      handled_h2: [],
      // CRM/scoring: ingen `finance_*`-avledning. `get_churn_overview` bærer ANTALL forfalte kundefakturaer fra produktbruk-fakturasignalet (ikke `finance*`) og `read_metrics`/`get_customer_overview` pipeline-verdi (CRM): kartlagt, se runbooken.
      read_no_finance: ["explain_score", "find_companies", "find_contacts", "get_churn_overview", "get_customer_overview", "get_lead_score", "get_opportunity_score", "list_overdue_followups", "rank_leads", "rank_opportunities", "read_company_timeline", "read_metrics"]
    },
    conversation_graph: {
      handled: ["read_cross_channel_attention", "read_cross_channel_commitment_view"],
      handled_h2: [],
      read_no_finance: ["list_channel_links", "read_cross_channel_commitments", "read_identity", "read_identity_timeline", "resolve_effective_identity", "resolve_identity"]
    },
    executive: {
      // fiks-runde 1: `get_security_center` (FIX-1: frosne koblinger/-credentials) og `get_infra_status` (FIX-2: hendelsestitler) er flyttet hit fra `handled_h2`/`read_no_finance` - begge viste seg å bære finansavledede navn
      handled: ["get_ai_mesh_status", "get_attention_item", "get_attention_queue", "get_capability_status", "get_connector_status", "get_control_center", "get_control_surface_status", "get_delegation_board", "get_evolution_report", "get_infra_status", "get_security_center", "get_self_diagnosis", "get_slo_report", "get_value_report"],
      // WP-H1/H2: finans-/verdi-/evolusjonssenteret holdt tilbake helt, øvrige sentre bygget uten finansavledet tilstand (`restrictFinance`) - uendret av N1b (K1 gir dem bare den arvede modellen). Data-sveipet over disse (orakel-testen + sveip med sådd finanstilstand): 0 finansnavn.
      handled_h2: ["get_agent_center", "get_evolution_center", "get_finance_center", "get_memory_center", "get_operations_center", "get_privacy_center", "get_value_center"],
      read_no_finance: []
    },
    run_rate: { handled: ["get_cost_overview", "list_connector_maintenance"], handled_h2: [], read_no_finance: [] }
  };

  for (const [ns, placement] of Object.entries(K2_PLACEMENT)) {
    it(`${ns}: hver handling er plassert nøyaktig ett sted; alt som ikke er klassifisert som lesing er en skrive-/kontrollhandling UTENFOR chattens lese-nivå (bak bekreftelseskortet, modellen ser aldri resultatet)`, () => {
      const all = actionsOf(ns);
      const placed = [...placement.handled, ...placement.handled_h2, ...placement.read_no_finance];
      expect(new Set(placed).size, "dublett i plasseringen").toBe(placed.length);
      for (const a of placed) expect(all, `foreldet oppføring ${ns}.${a}`).toContain(a);
      const rest = all.filter((a) => !placed.includes(a));
      for (const a of rest) expect(CHAT_READ_TIER_KEYS.has(`${ns}.${a}`), `${ns}.${a} er en LESE-handling uten klassifisering (ukjent = finans)`).toBe(false);
    });
  }

  it("hver K2-håndtert handling har en rad i kartleggingstabellen (og omvendt): tabellen er den eneste kilden til hva som er bevist mot ekte kode", () => {
    const handled = Object.entries(K2_PLACEMENT).flatMap(([ns, p]) => p.handled.map((a) => `${ns}.${a}`)).sort();
    const rowKeys = [...new Set([...ROWS.map((r) => `${r.tool}.${r.action}`), ...(CENTER_ROWS.length > 0 ? ["executive.get_control_center"] : [])])].sort();
    expect(rowKeys).toEqual(handled);
  });

  it("hver rad i tabellen er en handling en modell faktisk kan nå: tildelt på minst én modellflate (ellers er raden et bevis for ingenting)", () => {
    for (const r of ROWS) expect(grants.some((g) => g.tool_id === r.tool && g.action === r.action), `${r.id} ${r.tool}.${r.action}`).toBe(true);
  });

  it("`deferred`-navnerommene har INGEN sentral leser: lukkes et av dem, må klassifiseringen og runbooken endres samtidig", () => {
    const deferred = Object.keys(NAMESPACE_CLASS).filter((n) => NAMESPACE_CLASS[n] === "deferred");
    expect(deferred.sort()).toEqual(["growth", "knowledge", "memory"]);
    const readers = Object.keys(countBy(/\b(?:currentModelScope|currentServingModel|withholdFinanceFromCurrentModel)\s*\(/g, [SCOPE_FILE]));
    for (const f of readers) expect(f, "en leser i et deferred-domene").not.toMatch(/^modules\/(growth|knowledge|memory)\//);
  });
});

describe("G: ÉN lokalitetsregel (fiks-runde 1, FIX-7/A80): ingen ny leverandør-/lokalitetsliste utenfor `financeLockServedLocally`", () => {
  /**
   * Lokalitetsregelen har ÉN definisjon (`financeLockServedLocally` i `restricted-context-guard.ts`, som bygger på leverandørregisterets `locality`). En FJERDE kopi (en liste over lokale leverandørnavn i en tjeneste, f.eks.
   * `["gemma_local", "ollama"].includes(provider)` i executive) ville kunne avvike fra regelen og gi en annen avgjørelse enn låsen og de sentrale leserne. Vakten pinner HVOR de lokale leverandørnavnene (utledet fra
   * `DEFAULT_PROFILES` + `local_vision`) står som streng-literal i produksjonskoden: nøyaktig disse filene, med disse antallene. Dukker et navn opp i en ny fil (eller flere ganger i en kjent), feller testen - vurder da om koden
   * tar en LOKALITETSbeslutning (bruk i så fall `financeLockServedLocally`/`servedByCloud`, aldri en egen liste) før du legger filen inn her.
   */
  const ALLOWED: Readonly<Record<string, number>> = {
    "apps/api/src/chat-candidates.ts": 1, "apps/api/src/control-center/ai.ts": 3, "apps/api/src/conversation.ts": 1, "apps/api/src/evolution-source.ts": 4, "apps/api/src/golden-suite.ts": 1, "apps/api/src/main.ts": 2,
    "apps/api/src/run-rate.ts": 5, "apps/api/src/self-model-readers.ts": 1, "apps/api/src/vision-runtime.ts": 1, "apps/api/src/worker-main.ts": 1, "modules/executive/src/ai-mesh/report.ts": 1, "modules/memory/src/embedding.ts": 2,
    "modules/model-gateway/src/capability-registry.ts": 5, "modules/model-gateway/src/council.ts": 3, "modules/model-gateway/src/mesh-smoke.ts": 3, "modules/model-gateway/src/model-gateway.ts": 1,
    "modules/model-gateway/src/override-parser.ts": 1, "modules/situations/src/assist.ts": 3, "modules/vision/src/classifier.ts": 1,
    "packages/provider-adapters/src/local-llm.ts": 1, "packages/provider-adapters/src/ollama.ts": 1, "packages/provider-adapters/src/scripted.ts": 1
  };
  const localProviders = (): string[] => [...new Set([...DEFAULT_PROFILES.filter((p) => p.locality === "local").map((p) => p.provider), "local_vision"])].sort();

  it("de lokale leverandørnavnene fra modellregisteret er de forventede (endres registeret, må vakten vurderes)", () => {
    expect(localProviders()).toEqual(["gemma_local", "local_llm", "local_vision", "ollama", "scripted"]);
  });

  it("leverandørnavnene står som literal kun i den kjente listen filer (en ny provider-/lokalitetsliste, f.eks. i `modules/executive/src/service.ts`, feller testen)", () => {
    const re = new RegExp(`["'\`](?:${localProviders().join("|")})["'\`]`, "g");
    expect(countBy(re)).toEqual(ALLOWED);
  });

  it("de tre kjente lokalitetsavgjørelsene er ÉN funksjon: gatewayen og executive-tjenesten tar `servedLocally` (= `financeLockServedLocally`) som INNDATA - ingen av dem har en leverandørliste", () => {
    for (const rel of ["modules/tool-gateway/src/gateway.ts", "modules/executive/src/service.ts", "modules/tool-gateway/src/finance-withheld.ts", "modules/business/src/transport.ts", "modules/conversation-graph/src/transport.ts"]) {
      expect(code(read(rel)), rel).not.toMatch(new RegExp(`["'\`](?:${localProviders().join("|")})["'\`]`));
    }
  });
});
