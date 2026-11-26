import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILES, type ModelProfile } from "@jarvis/model-gateway";
import { MemoryEmbeddingNotLocalError, enforceLocalModelEndpoints } from "../src/local-model-endpoints.ts";

/**
 * WP-G4b fiks-runde 1, FIX-1: K4-vakten dekker ogsa MINNETS embedding (`JARVIS_EMBEDDING_URL` -> `JARVIS_OLLAMA_URL` -> `JARVIS_GEMMA_LOCAL_URL`, kun nar leverandoren er Ollama). Embedding er IKKE en modellprofil som kan
 * demoteres til sky (D-386: minnets vektorrom MA vaere lokalt), sa en ikke-lokal URL stopper oppstarten (`memory_embedding_must_be_local:<kode>`), med SAMME syntaks- og DNS-sjekk som de tre chat-identitetene. Flagg AV = som main.
 * Loggen og feilen har aldri URL, vert eller hemmeligheter.
 */
const ORIGINAL = new Map(DEFAULT_PROFILES.map((p) => [p.provider, p.locality] as const));
afterEach(() => { for (const p of DEFAULT_PROFILES) { const o = ORIGINAL.get(p.provider); if (o !== undefined) p.locality = o; } });

const profilesCopy = (): ModelProfile[] => DEFAULT_PROFILES.map((p) => ({ ...p }));
const PUBLIC = [{ address: "93.184.216.34" }];
const PRIVATE = [{ address: "192.168.1.20" }];
const SECRET = ["ikke", "en", "ekte", "verdi"].join("-");
const noLookup = async (): Promise<Array<{ address: string }>> => { throw new Error("lookup skulle ikke vaert kalt"); };

interface Out { verdicts: Awaited<ReturnType<typeof enforceLocalModelEndpoints>>; lines: Array<{ line: Record<string, unknown>; level: string }>; error: unknown }
async function run(env: Record<string, string>, lookup: (h: string) => Promise<ReadonlyArray<{ address: string }>> = noLookup): Promise<Out> {
  const lines: Out["lines"] = [];
  try {
    const verdicts = await enforceLocalModelEndpoints({ JARVIS_LOCAL_MODEL_URL_GUARD: "on", ...env }, { lookup, profiles: profilesCopy(), log: (line, level) => lines.push({ line, level }) });
    return { verdicts, lines, error: undefined };
  } catch (error) {
    return { verdicts: null, lines, error };
  }
}
const embedding = (url: string, extra: Record<string, string> = {}) => ({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3", JARVIS_EMBEDDING_URL: url, ...extra });
const codeOf = (out: Out): string | undefined => (out.error instanceof MemoryEmbeddingNotLocalError ? out.error.code : undefined);

describe("HULL-1: en offentlig embedding-URL stopper oppstarten (minnetekst sendes aldri dit)", () => {
  it("vakt PA + JARVIS_OLLAMA_URL=offentlig + Ollama-embedding: chat-profilen demoteres OG embedding avvises (`memory_embedding_must_be_local:local_url_not_local`)", async () => {
    const out = await run({ JARVIS_OLLAMA_URL: "http://example.com:11434", JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3" }, async () => PUBLIC);
    expect(out.error).toBeInstanceOf(MemoryEmbeddingNotLocalError);
    expect((out.error as Error).message).toBe("memory_embedding_must_be_local:local_url_not_local");
    expect(codeOf(out)).toBe("local_url_not_local");
    // loggen sier hvilken identitet og hvilken kode - aldri URL/vert
    expect(out.lines.filter((l) => l.line["msg"] === "local_model_endpoint_rejected")).toEqual([{ line: { msg: "local_model_endpoint_rejected", identity: "memory_embedding", code: "local_url_not_local" }, level: "warn" }]);
  });

  it("alle URL-kjeder som provideren faktisk bruker dekkes: JARVIS_EMBEDDING_URL forst, sa JARVIS_OLLAMA_URL, sa JARVIS_GEMMA_LOCAL_URL", async () => {
    for (const name of ["JARVIS_EMBEDDING_URL", "JARVIS_OLLAMA_URL", "JARVIS_GEMMA_LOCAL_URL"]) {
      const out = await run({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3", [name]: "http://8.8.8.8:11434" });
      expect(codeOf(out), name).toBe("local_url_not_local");
    }
  });

  it("URL-en provideren IKKE bruker avgjor ikke: lokal JARVIS_EMBEDDING_URL med offentlig JARVIS_OLLAMA_URL = embedding OK (chat-identiteten `ollama` demoteres som for), og omvendt avvises", async () => {
    const okEmbedding = await run({ ...embedding("http://192.168.1.50:11434"), JARVIS_OLLAMA_URL: "http://8.8.8.8:11434" });
    expect(okEmbedding.error).toBeUndefined();
    expect(okEmbedding.verdicts?.find((v) => v.identity === "ollama")).toEqual({ identity: "ollama", status: "demoted", code: "local_url_not_local" });
    expect(okEmbedding.verdicts?.find((v) => v.identity === "memory_embedding")).toEqual({ identity: "memory_embedding", status: "local", code: null });
    const bad = await run({ ...embedding("http://8.8.8.8:11434"), JARVIS_OLLAMA_URL: "http://192.168.1.50:11434" });
    expect(codeOf(bad)).toBe("local_url_not_local");
  });
});

describe("samme vakt som chat-identitetene (syntaks + DNS), tailnet kun med flagget", () => {
  const LOCAL = ["http://localhost:11434", "http://127.0.0.1:11434/v1", "http://[::1]:11434", "http://10.0.0.5:11434", "http://192.168.1.10:11434", "http://172.16.0.1:11434", "http://ollama:11434", "http://pc.lan:11434", "http://nas.local:11434"];
  it("lokale URL-former godtas og gir verdikt `local` (uten oppslag for IP-literaler; navn gar via oppslaget)", async () => {
    for (const url of LOCAL) {
      const out = await run(embedding(url), async () => PRIVATE);
      expect(out.error, url).toBeUndefined();
      expect(out.verdicts?.find((v) => v.identity === "memory_embedding"), url).toMatchObject({ status: "local", code: null });
    }
  });

  it("ikke-lokale og ugyldige URL-er avvises med stabile koder: offentlig IP/vert, brukerinfo (ogsa kun passord), skjema, ugyldig syntaks, 172.32, link-lokal/skymetadata, 0.0.0.0", async () => {
    const cases: Array<[string, string]> = [
      ["http://8.8.8.8", "local_url_not_local"], ["http://example.com", "local_url_not_local"], ["https://api.openai.com/v1", "local_url_not_local"], ["http://172.32.0.1", "local_url_not_local"],
      ["http://169.254.169.254/", "local_url_not_local"], ["http://0.0.0.0:11434", "local_url_not_local"], ["http://user:pw@10.0.0.1", "local_url_credentials"], ["http://:pw@10.0.0.1", "local_url_credentials"],
      ["ftp://10.0.0.1", "local_url_scheme"], ["file:///etc/passwd", "local_url_scheme"], ["ikke en url", "local_url_malformed"], ["http://10.0.0.1:99999", "local_url_malformed"]
    ];
    for (const [url, code] of cases) expect(codeOf(await run(embedding(url), async () => PRIVATE)), url).toBe(code);
  });

  it("Tailscale (100.64/10 og *.ts.net) avvises uten JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE=on og godtas med", async () => {
    for (const url of ["http://100.101.102.103:11434", "http://pc.tail1234.ts.net:11434"]) {
      expect(codeOf(await run(embedding(url), async () => [{ address: "100.101.102.103" }])), `${url} uten flagget`).toBe("local_url_not_local");
      const withFlag = await run(embedding(url, { JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" }), async () => [{ address: "100.101.102.103" }]);
      expect(withFlag.error, `${url} med flagget`).toBeUndefined();
      expect(withFlag.verdicts?.find((v) => v.identity === "memory_embedding")).toMatchObject({ status: "local" });
    }
  });

  it("DNS: et navn som lopes til en offentlig adresse avvises (`local_url_resolves_nonlocal`); blandet svar ogsa; et navn som ikke kan lopes (tomt/feil/tidsavbrudd) beholdes med en advarsel (ingen forbindelse kan opprettes)", async () => {
    expect(codeOf(await run(embedding("http://gpu.lan:11434"), async () => PUBLIC))).toBe("local_url_resolves_nonlocal");
    expect(codeOf(await run(embedding("http://gpu.lan:11434"), async () => [...PRIVATE, ...PUBLIC]))).toBe("local_url_resolves_nonlocal");
    for (const lookup of [async () => [], async () => { throw new Error("ENOTFOUND"); }]) {
      const out = await run(embedding("http://gpu.lan:11434"), lookup);
      expect(out.error).toBeUndefined();
      expect(out.verdicts?.find((v) => v.identity === "memory_embedding")).toEqual({ identity: "memory_embedding", status: "unresolved", code: null });
      expect(out.lines.filter((l) => l.line["msg"] === "local_model_endpoint_unresolved" && l.line["identity"] === "memory_embedding")).toHaveLength(1);
    }
  });
});

describe("kun nar embedding-leverandoren faktisk er Ollama; flagg AV = som main", () => {
  it("uten Ollama-embedding (lokal hash / ingen leverandor) sjekkes ingenting ekstra: ingen 4. verdikt, ingen feil, ingen DNS", async () => {
    for (const env of [{}, { JARVIS_EMBEDDING_PROVIDER: "local-hash", JARVIS_OLLAMA_URL: "http://8.8.8.8:11434" }, { JARVIS_EMBEDDING_PROVIDER: "ollama" }]) {
      const out = await run(env);
      expect(out.error, JSON.stringify(env)).toBeUndefined();
      expect(out.verdicts?.map((v) => v.identity)).not.toContain("memory_embedding");
    }
  });

  it("flagg AV (alt unntatt eksakt `on`): ingenting leses, ingenting kastes, ingenting logges - ogsa med offentlig embedding-URL", async () => {
    for (const v of [undefined, "", "off", "true", "1", "ON", " on"]) {
      const lines: unknown[] = [];
      const env: Record<string, string | undefined> = { ...embedding("http://8.8.8.8:11434"), ...(v === undefined ? {} : { JARVIS_LOCAL_MODEL_URL_GUARD: v }) };
      expect(await enforceLocalModelEndpoints(env, { lookup: noLookup, profiles: profilesCopy(), log: (l) => lines.push(l) }), String(v)).toBeNull();
      expect(lines).toEqual([]);
    }
  });
});

describe("ingen lekkasje: aldri URL, vert eller hemmelighet i feil eller logg", () => {
  it("URL med brukerinfo, query og hemmelighet i alle felt gir kun identitet og kode", async () => {
    const url = `http://bruker:${SECRET}@evil-host.example.com:11434/path?token=${SECRET}`;
    const out = await run(embedding(url), async () => PUBLIC);
    expect(codeOf(out)).toBe("local_url_credentials");
    const everything = JSON.stringify([out.lines, (out.error as Error).message, (out.error as Error).name]);
    for (const leaked of [SECRET, "evil-host", "example.com", "bruker", "token="]) expect(everything, leaked).not.toContain(leaked);
  });

  it("oppstartsloggen `local_model_endpoint_guard` nevner embedding-identiteten og sier ærlig hva vakten fortsatt IKKE dekker (`not_covered`)", async () => {
    const out = await run(embedding("http://192.168.1.50:11434"));
    const guard = out.lines.find((l) => l.line["msg"] === "local_model_endpoint_guard")!.line;
    expect((guard["identities"] as Array<{ identity: string }>).map((i) => i.identity)).toEqual(["local_llm", "gemma_local", "ollama", "memory_embedding"]);
    expect(Array.isArray(guard["not_covered"])).toBe(true);
    // dekket na: minnets embedding-URL (FIX-1) og omdirigeringer (FIX-5); gjenstaaende hull staar i loggen (FIX-6: DNS etter oppstart, uloest embedding-navn)
    expect(guard["not_covered"]).toEqual(["dns_rebinding_after_startup", "memory_embedding_unresolved_name"]);
    expect(guard["not_covered"]).not.toContain("memory_embedding");
    expect(guard["not_covered"]).not.toContain("redirects");
  });
});

describe("struktur: samme vakt (ingen kopi) og kalt FOER embedding-leverandoren opprettes", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  it("local-model-endpoints.ts bruker `embeddingEndpointFromEnv` fra minnet og de SAMME assert/resolve-funksjonene som de ovrige identitetene", () => {
    const src = read("src/local-model-endpoints.ts");
    expect(src).toContain('import { embeddingEndpointFromEnv');
    expect(src).toContain('from "@jarvis/memory"');
    expect(src.match(/assertLocalEndpoint\(/g)?.length).toBe(1); // ett kall, delt av alle identiteter (hjelperen)
    expect(src.match(/resolveEndpointLocality\(/g)?.length).toBe(1);
  });

  it("api og worker kaller vakten FOER `createEmbeddingProviderFromEnv(...)`", () => {
    for (const file of ["src/main.ts", "src/worker-main.ts"]) {
      const src = read(file);
      const guard = src.indexOf("await enforceLocalModelEndpoints(");
      const firstEmbedding = src.search(/createEmbeddingProviderFromEnv\(/);
      expect(guard, file).toBeGreaterThan(0);
      expect(firstEmbedding, file).toBeGreaterThan(guard);
    }
  });
});

/**
 * FIX-A (delta-review, testhull; mutantene D41/D58): en ikke-lokal embedding-URL STOPPER oppstarten fordi `enforceLocalModelEndpoints` KASTER - men ingen test pinnet at kastet faktisk når helt fram. En senere «gjør oppstart robust»-endring
 * (`.catch(() => undefined)`, en tom `catch`, et ikke-`await`et kall) ville latt oppstarten fortsette, og minneteksten (helse/økonomi) ville gått til en offentlig URL uten at noe feilet. Strukturen leses som AST (ikke regex), slik at
 * omformatering ikke gir falsk grønt/rødt, og pinner at:
 *  1. kallet er `await`et DIREKTE (ingen `.catch`/`.then`/`void`/`Promise.allSettled` rundt) og står som egen setning;
 *  2. kastet svelges ikke: api = setningen står rett i kroppen til `async function buildDeps()` (ingen `try`/`if` rundt) og `buildDeps().catch(...)` avslutter prosessen med `process.exit(<≠0>)`;
 *     worker = setningen står alene i en `try` på toppnivå hvis `catch` kun kaller `failStartup(<feilen>)`, og `failStartup` returnerer `never` og avslutter med `process.exit(<≠0>)`;
 *  3. kallet står FØR hver `createEmbeddingProviderFromEnv(...)` (ingenting rekker å bygge en embedding-leverandør, og dermed sende noe, før vakten har sagt ja).
 */
describe("struktur (AST): oppstart STOPPER når embedding-vakten kaster - kastet svelges aldri", () => {
  const parse = (rel: string): ts.SourceFile => ts.createSourceFile(rel, readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const collect = <T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] => {
    const out: T[] = [];
    const visit = (n: ts.Node): void => { if (pred(n)) out.push(n); ts.forEachChild(n, visit); };
    visit(root);
    return out;
  };
  const callsTo = (root: ts.Node, name: string): ts.CallExpression[] =>
    collect(root, (n): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);
  /** `process.exit(<tall ≠ 0>);` som egen setning. */
  const isProcessExitNonZero = (s: ts.Node): boolean => {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) return false;
    const callee = s.expression.expression;
    const arg = s.expression.arguments[0];
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "process" && callee.name.text === "exit"
      && s.expression.arguments.length === 1 && arg !== undefined && ts.isNumericLiteral(arg) && Number(arg.text) !== 0;
  };
  /** Setningen kallet er `await`et direkte i (`await f(...);` eller `const x = await f(...);`); `null` hvis kallet er pakket inn i noe annet (`.catch`, `.then`, `void`, parentes, `Promise.allSettled`, ...). */
  const awaitedStatement = (call: ts.CallExpression): ts.Node | null => {
    const aw = call.parent;
    if (!ts.isAwaitExpression(aw)) return null;
    const p = aw.parent;
    if (ts.isExpressionStatement(p)) return p;
    if (ts.isVariableDeclaration(p) && ts.isVariableDeclarationList(p.parent) && ts.isVariableStatement(p.parent.parent)) return p.parent.parent;
    return null;
  };
  const guardCall = (sf: ts.SourceFile): ts.CallExpression => {
    const calls = callsTo(sf, "enforceLocalModelEndpoints");
    expect(calls, "nøyaktig ett kall til `enforceLocalModelEndpoints`").toHaveLength(1);
    return calls[0]!;
  };
  const expectBeforeEmbeddingProviders = (sf: ts.SourceFile, call: ts.CallExpression, file: string): void => {
    const providers = callsTo(sf, "createEmbeddingProviderFromEnv");
    expect(providers.length, `${file}: minst ett kall til createEmbeddingProviderFromEnv`).toBeGreaterThanOrEqual(1);
    for (const p of providers) expect(p.getStart(sf), `${file}: vakten står FØR createEmbeddingProviderFromEnv`).toBeGreaterThan(call.getStart(sf));
  };

  it("api (main.ts): kallet er en direkte, `await`et setning i `async function buildDeps()`, og `buildDeps().catch(...)` avslutter prosessen med kode ≠ 0", () => {
    const sf = parse("src/main.ts");
    const call = guardCall(sf);
    const stmt = awaitedStatement(call);
    expect(stmt, "kallet er `await`et direkte (ikke `.catch(...)`, `.then(...)`, `void`, `Promise.allSettled`)").not.toBeNull();
    const block = stmt!.parent;
    const fn = ts.isBlock(block) ? block.parent : undefined;
    expect(fn !== undefined && ts.isFunctionDeclaration(fn) && fn.name?.text === "buildDeps" && (fn.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      "setningen står rett i kroppen til `async function buildDeps()` (ingen try/if/løkke rundt som kan svelge kastet)").toBe(true);
    // kastet forplanter seg ut av buildDeps til toppnivåbehandleren, som skal avslutte prosessen
    const handled = collect(sf, (n): n is ts.CallExpression => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch"
      && ts.isCallExpression(n.expression.expression) && ts.isIdentifier(n.expression.expression.expression) && n.expression.expression.expression.text === "buildDeps");
    expect(handled, "nøyaktig ett `buildDeps().catch(...)`").toHaveLength(1);
    const handler = handled[0]!.arguments[0];
    expect(handler !== undefined && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && ts.isBlock(handler.body) && handler.body.statements.some(isProcessExitNonZero),
      "behandleren kaller `process.exit(<≠0>)` som egen setning").toBe(true);
    expectBeforeEmbeddingProviders(sf, call, "src/main.ts");
  });

  it("worker (worker-main.ts): kallet står alene i en `try` på toppnivå hvis eneste `catch`-setning er `failStartup(<feilen>)`; `failStartup` returnerer `never` og avslutter med kode ≠ 0", () => {
    const sf = parse("src/worker-main.ts");
    const call = guardCall(sf);
    const stmt = awaitedStatement(call);
    expect(stmt, "kallet er `await`et direkte (ikke `.catch(...)`, `.then(...)`, `void`, `Promise.allSettled`)").not.toBeNull();
    const tryBlock = stmt!.parent;
    if (!ts.isBlock(tryBlock)) throw new Error("kallet må stå i en blokk");
    const tryStmt = tryBlock.parent;
    if (!ts.isTryStatement(tryStmt) || tryStmt.tryBlock !== tryBlock) throw new Error("kallet må stå i try-blokken til en try-setning");
    expect(ts.isSourceFile(tryStmt.parent), "try-setningen står på toppnivå (ikke inne i en betingelse/funksjon)").toBe(true);
    expect(tryStmt.finallyBlock, "ingen finally").toBeUndefined();
    expect(tryBlock.statements, "try-blokken inneholder kun vakten").toHaveLength(1);
    const clause = tryStmt.catchClause;
    if (clause === undefined) throw new Error("try-setningen mangler catch");
    const binder = clause.variableDeclaration?.name;
    if (binder === undefined || !ts.isIdentifier(binder)) throw new Error("catch må binde feilen");
    expect(clause.block.statements, "catch gjør KUN `failStartup(feilen)` (ingen tom catch, ingen logging uten stopp)").toHaveLength(1);
    const only = clause.block.statements[0]!;
    const onlyCall = ts.isExpressionStatement(only) && ts.isCallExpression(only.expression) ? only.expression : undefined;
    const arg = onlyCall?.arguments[0];
    expect(onlyCall !== undefined && ts.isIdentifier(onlyCall.expression) && onlyCall.expression.text === "failStartup" && onlyCall.arguments.length === 1 && arg !== undefined && ts.isIdentifier(arg) && arg.text === binder.text,
      "catch kaller `failStartup(<den fangede feilen>)`").toBe(true);
    const fail = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "failStartup");
    expect(fail?.type?.kind, "`failStartup(...)`: never").toBe(ts.SyntaxKind.NeverKeyword);
    expect(fail?.body?.statements.some(isProcessExitNonZero), "`failStartup` avslutter prosessen med `process.exit(<≠0>)` som egen setning").toBe(true);
    expectBeforeEmbeddingProviders(sf, call, "src/worker-main.ts");
  });
});
