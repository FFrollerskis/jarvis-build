import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SURFACE_TOOL_GRANTS } from "@jarvis/tool-gateway";

/**
 * WP-N1b (K1 iii + K4 e): strukturtester og kildevakter for den modell-stemplede konteksten (`model-scope.ts`) og for «nye nøstede finansoppslag uten sentral lesning».
 *  A. Skopet SETTES på ÉTT sted (`ToolGateway.execute()`) og LESES kun av en kjent liste filer. En ny leser må vurderes: delt arbeid (single-flight, cache, felt-`Promise`) kjører i den FØRSTE kallerens skop, så en leser
 *     der ville gitt en senere kaller det første kallerens avgjørelse (lekkasje den ene veien, utilgjengelighet den andre).
 *  B. Gatewayens `execute()`: vakt AV går rett til den uendrede kroppen; et skyskop løsnes aldri; lokalitetsvedtaket tas én gang med den ene regelen; kroppen leser den EFFEKTIVE modellen.
 *  C. Ingen produksjonskode overstyrer/fjerner modellen på et nøstet kall.
 *  D. Hvem som overhodet kan nå finansmodulens kjøretid (`@jarvis/finance`) uten om `ToolGateway`: kun komposisjonsroten, eierens ruter og workeren - ingen modellnåbar modul. Et nytt importsted må vurderes mot utførelseslåsen.
 *  E. `personal.finance_read` (eierens HTTP-rute, ingen modell i løkka, Q-9) har ingen modellflate og får aldri en: en kildevakt feller det hvis den noen gang kobles til verktøyregisteret, flatene eller en modellløkke.
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

  it("de SENTRALE LESERNE (`currentModelScope`, `currentServingModel`, `withholdFinanceFromCurrentModel`) brukes kun av gatewayen og de kjente nøstede/begrensede oppslagene - en ny leser må vurderes (aldri i delt arbeid som deles av flere kallere)", () => {
    expect(countBy(/\b(?:currentModelScope|currentServingModel|withholdFinanceFromCurrentModel)\s*\(/g, [SCOPE_FILE])).toEqual({
      "modules/executive/src/service.ts": 2, // K1: nøstede finansavlesninger (`getControlSurfaceStatus`/`getDelegationBoard`)
      "modules/tool-gateway/src/gateway.ts": 1 // `execute()`: arver et ytre skop
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
    const firstStatement = execute.slice(execute.indexOf("{") + 1).trimStart();
    expect(firstStatement.startsWith("const lock = this.options?.financeExecutionLock;")).toBe(true);
    expect(execute).toMatch(/if \(lock === undefined\) return this\.executeCall\(request\);\s*try \{/);
    expect(execute.indexOf("if (lock === undefined) return this.executeCall(request);")).toBeLessThan(execute.indexOf("currentModelScope()"));
    expect(execute.indexOf("if (lock === undefined) return this.executeCall(request);")).toBeLessThan(execute.indexOf("runWithModelScope("));
  });

  it("et skyskop LØSNES aldri: er det ytre kallet sky/ukjent gjelder den modellen, ellers eksplisitt, ellers arvet; vedtaket tas med `servedByCloud` (den ene regelen) eller arves", () => {
    expect(execute).toContain("const model = ambient?.cloud === true ? ambient.servingModel : (request.servingModel ?? ambient?.servingModel);");
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
