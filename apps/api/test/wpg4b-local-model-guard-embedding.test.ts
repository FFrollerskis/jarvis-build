import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILES, type ModelProfile } from "@jarvis/model-gateway";
import { embeddingEndpointFromEnv } from "@jarvis/memory";
import { MEMORY_EMBEDDING_URL_ENV_CHAIN, MemoryEmbeddingNotLocalError, enforceLocalModelEndpoints } from "../src/local-model-endpoints.ts";

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
    // den stabile koden står FØRST i meldingen (FIX-D la et kort hint bak den; se «FIX-D» nederst)
    expect((out.error as Error).message).toMatch(/^memory_embedding_must_be_local:local_url_not_local(?: |$)/);
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

/**
 * FIX-D (delta-review, brukervennlighet): med vakten PÅ og en tailnet-adresse (100.64.0.0/10) som embedding-URL uten `JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE=on` STOPPER api OG worker oppstart, og compose har `restart: unless-stopped` - en omstartsløkke der
 * feilen verken nevnte variabelen eller tailnet-flagget. Meldingen beholder den stabile koden `memory_embedding_must_be_local:<kode>` FØRST og har et kort hint bak: NAVNET (aldri verdien) på variabelen som er avvist, og at en tailnet-adresse krever
 * flagget. Meldingen bygges kun av konstanter: den skal ALDRI inneholde URL, vert, port, sti, query eller brukerinfo (sentinel-testene under legger en gjenkjennelig verdi i HVER del av URL-en).
 */
describe("FIX-D: feilmeldingen har et kort hint (variabelnavn + tailnet-flagget) bak den stabile koden - og aldri URL, vert eller hemmelighet", () => {
  const PREFIX = "memory_embedding_must_be_local:";
  const TAILNET_FLAG = "JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE";
  const failure = async (env: Record<string, string>, lookup: (h: string) => Promise<ReadonlyArray<{ address: string }>> = noLookup): Promise<{ error: MemoryEmbeddingNotLocalError; lines: Out["lines"] }> => {
    const out = await run(env, lookup);
    expect(out.error, JSON.stringify(Object.keys(env))).toBeInstanceOf(MemoryEmbeddingNotLocalError);
    return { error: out.error as MemoryEmbeddingNotLocalError, lines: out.lines };
  };
  const ollama = (name: string, url: string, extra: Record<string, string> = {}) => ({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3", [name]: url, ...extra });

  it("stabil kode FØRST (`memory_embedding_must_be_local:<kode>` + mellomrom) og `code` som egen egenskap; hintet bak navngir NØYAKTIG variabelen URL-en kom fra og tailnet-flagget, for hver av de tre variablene", async () => {
    for (const name of MEMORY_EMBEDDING_URL_ENV_CHAIN) {
      const { error } = await failure(ollama(name, "http://8.8.8.8:11434"));
      expect(error.code, name).toBe("local_url_not_local");
      expect(error.source, name).toBe(name);
      expect(error.message.startsWith(`${PREFIX}local_url_not_local `), name).toBe(true);
      expect(error.message, name).toContain(`${name} er avvist`);
      for (const other of MEMORY_EMBEDDING_URL_ENV_CHAIN.filter((n) => n !== name)) expect(error.message, `${name}: nevner ikke ${other}`).not.toContain(other);
      expect(error.message, name).toContain(`${TAILNET_FLAG}=on`);
      expect(error.message, name).toContain("100.64.0.0/10");
      expect(error.message, name).toContain("JARVIS_LOCAL_MODEL_URL_GUARD");
      expect(error.name).toBe("MemoryEmbeddingNotLocalError");
    }
  });

  it("eierens dokumenterte tailnet-eksempel (Tailscale-IP som JARVIS_EMBEDDING_URL, vakt PÅ, uten flagget) stopper oppstarten MED hintet - og er godtatt med flagget", async () => {
    const tailnetIp = ["100", "86", "89", "57"].join(".");
    const url = `http://${tailnetIp}:11434`;
    const { error } = await failure(ollama("JARVIS_EMBEDDING_URL", url));
    expect(error.message).toMatch(new RegExp(`^${PREFIX}local_url_not_local `));
    expect(error.message).toContain("JARVIS_EMBEDDING_URL er avvist");
    expect(error.message).toContain(`${TAILNET_FLAG}=on`);
    expect(error.message).not.toContain(tailnetIp);
    const withFlag = await run(ollama("JARVIS_EMBEDDING_URL", url, { JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" }));
    expect(withFlag.error).toBeUndefined();
  });

  it("variabelen i hintet følger prioritetsrekkefølgen provideren faktisk bruker (JARVIS_EMBEDDING_URL -> JARVIS_OLLAMA_URL -> JARVIS_GEMMA_LOCAL_URL): første SATTE variabel avvises, ikke de bak", async () => {
    const bad = (n: number) => `http://8.8.8.${n}:11434`;
    const first = await failure({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_URL: bad(1), JARVIS_OLLAMA_URL: bad(2), JARVIS_GEMMA_LOCAL_URL: bad(3) });
    expect(first.error.source).toBe("JARVIS_EMBEDDING_URL");
    const second = await failure({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_URL: "", JARVIS_OLLAMA_URL: bad(2), JARVIS_GEMMA_LOCAL_URL: bad(3) });
    expect(second.error.source).toBe("JARVIS_OLLAMA_URL");
    expect(second.error.message).toContain("JARVIS_OLLAMA_URL er avvist");
    expect(second.error.message).not.toContain("JARVIS_EMBEDDING_URL");
    expect(second.error.message).not.toContain("JARVIS_GEMMA_LOCAL_URL");
    const third = await failure({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_GEMMA_LOCAL_URL: bad(3) });
    expect(third.error.source).toBe("JARVIS_GEMMA_LOCAL_URL");
  });

  it("kjeden i feilmeldingen er LÅST mot `embeddingEndpointFromEnv` (minnets egen URL-velger): for alle 7 kombinasjoner av satte variabler er den avviste variabelen den samme som provideren faktisk leser", async () => {
    const names = [...MEMORY_EMBEDDING_URL_ENV_CHAIN];
    expect(names).toEqual(["JARVIS_EMBEDDING_URL", "JARVIS_OLLAMA_URL", "JARVIS_GEMMA_LOCAL_URL"]);
    for (let mask = 1; mask < 8; mask++) {
      const env: Record<string, string> = { JARVIS_EMBEDDING_PROVIDER: "ollama" };
      names.forEach((n, i) => { if ((mask & (1 << i)) !== 0) env[n] = `http://8.8.8.${i + 1}:11434`; });
      const { error } = await failure(env);
      expect(env[error.source ?? ""], `maske ${mask}`).toBe(embeddingEndpointFromEnv(env));
    }
    // et variabel med KUN mellomrom er «satt» for provideren (`||`) og gir ingen URL: ingenting sjekkes, ingenting kastes (kjeden gir samme svar som minnets velger)
    const blank = { JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_URL: "   ", JARVIS_OLLAMA_URL: "http://8.8.8.2:11434" };
    expect(embeddingEndpointFromEnv(blank)).toBeNull();
    const blankRun = await run(blank);
    expect(blankRun.error).toBeUndefined();
    expect(blankRun.verdicts?.map((v) => v.identity)).not.toContain("memory_embedding");
  });

  it("DNS-avvisning (`local_url_resolves_nonlocal`) har samme hint som en direkte ikke-lokal adresse; med tailnet-flagget PÅ nevnes ikke flagget (det hjelper ikke), kun at URL-en må være lokal", async () => {
    const viaDns = await failure(ollama("JARVIS_EMBEDDING_URL", "http://gpu.lan:11434"), async () => PUBLIC);
    expect(viaDns.error.code).toBe("local_url_resolves_nonlocal");
    expect(viaDns.error.message).toContain(`${TAILNET_FLAG}=on`);
    const flagOn = await failure(ollama("JARVIS_EMBEDDING_URL", "http://8.8.8.8:11434", { JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" }));
    expect(flagOn.error.code).toBe("local_url_not_local");
    expect(flagOn.error.message).toMatch(new RegExp(`^${PREFIX}local_url_not_local `));
    expect(flagOn.error.message).not.toContain(TAILNET_FLAG);
    expect(flagOn.error.message).not.toContain("100.64.0.0/10");
    expect(flagOn.error.message).toContain("URL-en må være lokal");
  });

  it("syntaksfeil (`local_url_credentials`/`scheme`/`malformed`) får variabelnavnet men ikke tailnet-rådet (tailnet-flagget hjelper ikke); rådet er å rette URL-en", async () => {
    for (const [url, code] of [["http://u:p@10.0.0.1:11434", "local_url_credentials"], ["ftp://10.0.0.1:11434", "local_url_scheme"], ["http://10.0.0.1:99999", "local_url_malformed"]] as const) {
      const { error } = await failure(ollama("JARVIS_OLLAMA_URL", url));
      expect(error.code, url).toBe(code);
      expect(error.message.startsWith(`${PREFIX}${code} `), url).toBe(true);
      expect(error.message, url).toContain("JARVIS_OLLAMA_URL er avvist");
      expect(error.message, url).not.toContain(TAILNET_FLAG);
      expect(error.message, url).not.toContain("100.64.0.0/10");
      expect(error.message, url).toContain("Rett URL-en");
    }
  });

  it("SENTINEL: ingen del av URL-en (bruker, passord, vert, port, sti, query) står i meldingen, navnet, stakken, egenskapene eller loggen - for hver feilkode og hver av de tre variablene", async () => {
    const parts = ["SENTINEL-USER", "SENTINEL-PW", "SENTINEL-HOST", "SENTINEL-PATH", "SENTINEL-TOKEN", "34567", "example.com"];
    const urls: Array<[string, string, ReadonlyArray<{ address: string }>]> = [
      [`http://SENTINEL-USER:SENTINEL-PW@SENTINEL-HOST.example.com:34567/SENTINEL-PATH?token=SENTINEL-TOKEN`, "local_url_credentials", PUBLIC],
      [`https://SENTINEL-HOST.example.com:34567/SENTINEL-PATH?token=SENTINEL-TOKEN`, "local_url_not_local", PUBLIC],
      [`ftp://SENTINEL-HOST.example.com:34567/SENTINEL-PATH?token=SENTINEL-TOKEN`, "local_url_scheme", PUBLIC],
      [`http://SENTINEL-HOST:99999/SENTINEL-PATH?token=SENTINEL-TOKEN`, "local_url_malformed", PUBLIC],
      [`http://SENTINEL-HOST.lan:34567/SENTINEL-PATH?token=SENTINEL-TOKEN`, "local_url_resolves_nonlocal", PUBLIC],
      [`http://:SENTINEL-PW@SENTINEL-HOST.lan:34567/SENTINEL-PATH`, "local_url_credentials", PRIVATE]
    ];
    for (const name of MEMORY_EMBEDDING_URL_ENV_CHAIN) {
      for (const [url, code, answer] of urls) {
        const { error, lines } = await failure(ollama(name, url), async () => answer);
        expect(error.code, `${name} ${code}`).toBe(code);
        const everything = JSON.stringify([error.message, error.name, error.code, error.source, String(error.stack), lines, Object.entries(error)]);
        for (const part of parts) expect(everything, `${name} ${code}: lekker «${part}»`).not.toContain(part);
        expect(error.message.startsWith(`${PREFIX}${code} `), `${name} ${code}`).toBe(true);
      }
    }
  });

  it(".env.example: eksempel-URL-en til JARVIS_EMBEDDING_URL utløser IKKE omstartsløkka (godtas av vakten uten tailnet-flagget), og kommentaren nevner tailnet-flagget", async () => {
    const env = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
    const lines = env.split("\n");
    const at = lines.findIndex((l) => l === "JARVIS_EMBEDDING_URL=");
    expect(at, "JARVIS_EMBEDDING_URL= finnes i .env.example").toBeGreaterThan(0);
    const urlLine = lines.slice(0, at).reverse().find((l) => l.startsWith("# URL:")) ?? "";
    const example = /f\.eks\. (http:\/\/[^\s)]+)/.exec(urlLine)?.[1];
    expect(example, "# URL:-linjen har et eksempel («f.eks. http://...»)").toBeDefined();
    const out = await run(ollama("JARVIS_EMBEDDING_URL", example!), async () => PRIVATE);
    expect(out.error, "eksempelet må ikke stoppe oppstart med vakten PÅ og flagget AV").toBeUndefined();
    // kommentarblokken rett over variabelen (kommentarlinjer og `JARVIS_EMBEDDING_PROVIDER=`) forklarer tailnet-flagget og at oppstarten ellers stopper
    let top = at;
    while (top > 0 && (lines[top - 1]!.startsWith("#") || lines[top - 1] === "JARVIS_EMBEDDING_PROVIDER=")) top -= 1;
    const block = lines.slice(top, at).join("\n");
    expect(block).toContain("JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE=on");
    expect(block).toContain("memory_embedding_must_be_local");
    expect(block).toContain("restart: unless-stopped");
  });
});
