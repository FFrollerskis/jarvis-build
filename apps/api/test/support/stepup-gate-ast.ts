import ts from "typescript";

/**
 * WP-S1 fiks-runde 1 (B-M1, JARVIS-111): STRUKTURELL (AST-basert) vakt for step-up-porten. Den gamle vakten (`wps1-stepup-gate-wiring.test.ts`, A og D) leste kildeteksten med regex-er og fanget kun bokstavelig
 * `process.env["FLAGG"]` og eksakte tekststrenger i `main.ts`; reviewer B viste 7 av 8 omgåelser som slapp gjennom (spredning `{...process.env}`, alias, mal-literal-nøkler, import-alias i en annen fil, og en parser med
 * standardparameter `= process.env`). Denne analysen leser den ekte syntakstreet (TypeScript-kompilatoren, allerede i repoet) og håndhever:
 *
 *  L1  De ni parser-/wiring-funksjonene for de fire flaggfamiliene (`GUARDED_CALLS`) kalles KUN fra en eksakt tillatelsesliste av filer, med eksakt antall kall (ingen nye kall, ingen foreldet liste). Import-alias,
 *      navneromsimport og destrukturering i en annen fil gir ingen unntak, og en bruk som verdi (`.call`, `.apply`, `.bind`, videresending) er et brudd.
 *  L2  Miljø-argumentet på hvert tillatt kallsted har en eksakt, forventet opprinnelse (`stepUpGate.env` i `main.ts`, parameteren videresendt i wiringfilene). En import av et rått miljø fra en annen fil kan dermed heller
 *      ikke gjøre noe.
 *  L3  INGEN argument inneholder noen form for rått prosessmiljø: `process.env`, `process["env"]`, mal-literal-nøkkel, `globalThis.process.env`, spredning, alias (`const e = process.env`), destrukturering
 *      (`const { env } = process`), `import { env } from "node:process"`, `Object.assign({}, process.env)`, en funksjon som returnerer det. Porten (`applyStepUpBindingGate`) er den ENESTE som renser: resultatet er trygt.
 *  L4  Parser-/wiringfilene for de fire familiene (`ENV_FREE_FILES`) nevner aldri `process` i det hele tatt: de får miljøet kun som parameter.
 *  L5  En guardet funksjons definisjon har et OBLIGATORISK første parameter uten standardverdi (`= process.env` var den innebygde omgåelsen i `parseCommsConfig`).
 *  L6  Porten bygges nøyaktig ÉN gang i hele produksjonskoden, i `main.ts`, av det rå prosessmiljøet.
 *  L7  Ingen kode leser en bundet flaggfamilie direkte fra rått prosessmiljø, uansett form (literal nøkkel, mal-literal, alias, destrukturering).
 *
 * KJENTE GRENSER (dokumentert, ikke skjult): en nøkkel som er bygget dynamisk (`process.env["JARVIS_" + "COMMS_OUTBOUND"]`) eller en lesing via `Reflect`/`Object.entries` ses ikke av L7; L1-L6 holder likevel parserne og wiringen
 * lukket, så en slik lesing ville måtte være en ny, egen parser. Analysen er ren (ingen I/O): `scanSource` tar kildeteksten, så omgåelsene kan prøves mot den ekte koden i minnet.
 */

export type ExpectedCalls = number | "some";

export interface GateRules {
  /** Guardet funksjon -> (fil -> forventet antall direkte kall). `"some"` = minst ett. */
  readonly guardedCalls: Readonly<Record<string, Readonly<Record<string, ExpectedCalls>>>>;
  /** Eksakt kilde-tekst for miljø-argumentet på et tillatt kallsted: `arg0` = første argument, `env-prop` = egenskapen `env` i objekt-argumentet. */
  readonly envArgs: ReadonlyArray<{ readonly fn: string; readonly file: string; readonly position: "arg0" | "env-prop"; readonly allowed: readonly string[] }>;
  readonly envFreeFiles: readonly string[];
  readonly gateFunction: string;
  readonly gateFile: string;
  readonly boundFlagNames: ReadonlySet<string>;
}

export interface ScanResult {
  readonly file: string;
  readonly violations: string[];
  readonly guardedCalls: Record<string, number>;
  readonly gateCalls: number;
}

const PROCESS_MODULES: ReadonlySet<string> = new Set(["node:process", "process"]);
const INDIRECT = new Set(["call", "apply", "bind"]);

export function scanSource(file: string, text: string, rules: GateRules): ScanResult {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const violations: string[] = [];
  const guardedCalls: Record<string, number> = {};
  let gateCalls = 0;
  const guarded = new Map<string, string>(); // lokalt navn -> guardet funksjon
  const processNames = new Set<string>(["process"]);
  const taintedNames = new Set<string>();
  const where = (n: ts.Node): string => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const fail = (n: ts.Node, rule: string, message: string): void => { violations.push(`${where(n)} [${rule}] ${message}`); };
  const isGuardedName = (name: string): boolean => Object.hasOwn(rules.guardedCalls, name);

  const unwrap = (n: ts.Node): ts.Node => {
    let cur = n;
    while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
    return cur;
  };
  const literalKey = (n: ts.Node | undefined): string | undefined => {
    if (n === undefined) return undefined;
    const u = unwrap(n);
    return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined;
  };
  /** `process`, et alias for det, eller `globalThis.process` / `global.process` / `globalThis["process"]`. */
  const isProcessRef = (n: ts.Node): boolean => {
    const u = unwrap(n);
    if (ts.isIdentifier(u)) return processNames.has(u.text);
    if (ts.isPropertyAccessExpression(u)) return u.name.text === "process" && ts.isIdentifier(u.expression) && (u.expression.text === "globalThis" || u.expression.text === "global");
    if (ts.isElementAccessExpression(u)) return literalKey(u.argumentExpression) === "process" && ts.isIdentifier(u.expression) && (u.expression.text === "globalThis" || u.expression.text === "global");
    return false;
  };
  const isEnvSource = (n: ts.Node): boolean => {
    const u = unwrap(n);
    if (ts.isPropertyAccessExpression(u)) return u.name.text === "env" && isProcessRef(u.expression);
    if (ts.isElementAccessExpression(u)) return literalKey(u.argumentExpression) === "env" && isProcessRef(u.expression);
    return false;
  };
  const isGateCall = (n: ts.Node): boolean => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === rules.gateFunction;

  /**
   * Er verdien av uttrykket (en del av) det rå prosessmiljøet? Taint følger ALIAS, kopier og spredning, men ikke vilkårlige utledninger: `createPool(process.env)` er en pool, ikke et miljø. Porten (`applyStepUpBindingGate`) er den
   * eneste som renser. Alt som ikke gjenkjennes her fanges av L2 (eksakt, positiv opprinnelse for miljø-argumentet), som er den egentlige låsen.
   */
  const COPY_CALLEES = new Set(["Object.assign", "Object.freeze", "Object.fromEntries", "Object.entries", "Object.values", "structuredClone", "JSON.parse", "JSON.stringify", "Array.from", "Reflect.get"]);
  const taintedFunctions = new Set<string>(); // lokale funksjoner som returnerer rått miljø
  const tainted = (n: ts.Node): boolean => {
    if (isGateCall(n)) return false;
    if (isEnvSource(n)) return true;
    if (ts.isTypeNode(n)) return false;
    if (ts.isIdentifier(n)) return taintedNames.has(n.text);
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return tainted(n.expression);
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n) || ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) return tainted(n.expression);
    if (ts.isPropertyAssignment(n)) return tainted(n.initializer);
    if (ts.isShorthandPropertyAssignment(n)) return taintedNames.has(n.name.text);
    if (ts.isObjectLiteralExpression(n)) return n.properties.some((p) => tainted(p));
    if (ts.isArrayLiteralExpression(n)) return n.elements.some((e) => tainted(e));
    if (ts.isConditionalExpression(n)) return tainted(n.whenTrue) || tainted(n.whenFalse);
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.CommaToken) return tainted(n.left) || tainted(n.right);
      if (k === ts.SyntaxKind.EqualsToken) return tainted(n.right);
      return false;
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (COPY_CALLEES.has(callee.getText(sf))) return n.arguments.some((a) => tainted(a));
      return ts.isIdentifier(callee) && taintedFunctions.has(callee.text);
    }
    if (ts.isNewExpression(n)) return ts.isIdentifier(n.expression) && (n.expression.text === "Map" || n.expression.text === "Set") && (n.arguments ?? []).some((a) => tainted(a));
    return false;
  };
  /** Returnerer funksjonen rått miljø? (uttrykkskropp, eller en `return` som ikke ligger i en nøstet funksjon) */
  const returnsTainted = (fn: ts.FunctionLikeDeclaration): boolean => {
    if (fn.body === undefined) return false;
    if (!ts.isBlock(fn.body)) return tainted(fn.body);
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined && tainted(n.expression)) { found = true; return; }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn.body, walk);
    return found;
  };

  const boundNames = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
  };
  const moduleOf = (init: ts.Expression): string | undefined => {
    const u = unwrap(init);
    if (!ts.isCallExpression(u)) return undefined;
    const callee = u.expression;
    const isRequire = ts.isIdentifier(callee) && callee.text === "require";
    if (!isRequire && callee.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
    return literalKey(u.arguments[0]);
  };

  // ---------- 1. importer ----------
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause === undefined) continue;
    const isProc = PROCESS_MODULES.has(st.moduleSpecifier.text);
    const clause = st.importClause;
    if (clause.name !== undefined && isProc) processNames.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb) && isProc) processNames.add(nb.name.text);
    if (nb !== undefined && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (isProc && imported === "env") taintedNames.add(el.name.text);
        if (isProc && imported === "default") processNames.add(el.name.text);
        if (isGuardedName(imported)) guarded.set(el.name.text, imported);
      }
    }
  }

  // ---------- 2. deklarasjoner til fast punkt: alias for process, for guardede funksjoner og for rått miljø ----------
  const decls: ts.VariableDeclaration[] = [];
  const params: ts.ParameterDeclaration[] = [];
  const assigns: ts.BinaryExpression[] = [];
  const fns: Array<{ name: string | undefined; node: ts.FunctionLikeDeclaration }> = [];
  const collect = (n: ts.Node): void => {
    // funksjoner DEFINERT i denne filen (f.eks. `parseGrowthWritePlatforms` i sin egen modul) regnes som lokale navn, så interne kall telles og kontrolleres på samme måte
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && isGuardedName(n.name.text)) guarded.set(n.name.text, n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isGuardedName(n.name.text)) guarded.set(n.name.text, n.name.text);
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) fns.push({ name: n.name.text, node: n });
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fns.push({ name: n.name.text, node: init });
    }
    if (ts.isVariableDeclaration(n)) decls.push(n);
    else if (ts.isParameter(n)) params.push(n);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assigns.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (let changed = true; changed;) {
    changed = false;
    const addTo = (set: Set<string>, name: string): void => { if (!set.has(name)) { set.add(name); changed = true; } };
    for (const d of decls) {
      if (d.initializer === undefined) continue;
      const init = unwrap(d.initializer);
      if (ts.isIdentifier(d.name)) {
        if (isProcessRef(init)) addTo(processNames, d.name.text);
        if (ts.isIdentifier(init) && guarded.has(init.text) && !guarded.has(d.name.text)) { guarded.set(d.name.text, guarded.get(init.text) as string); changed = true; }
      }
      if (ts.isObjectBindingPattern(d.name)) {
        const mod = moduleOf(d.initializer);
        for (const el of d.name.elements) {
          const key = el.propertyName ?? el.name;
          const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
          if (keyText === undefined || !ts.isIdentifier(el.name)) continue;
          if (isProcessRef(init) && keyText === "env") addTo(taintedNames, el.name.text);
          if (mod !== undefined && PROCESS_MODULES.has(mod) && keyText === "env") addTo(taintedNames, el.name.text);
          if (isGuardedName(keyText) && !guarded.has(el.name.text)) { guarded.set(el.name.text, keyText); changed = true; }
        }
      }
      if (tainted(d.initializer)) for (const name of boundNames(d.name)) addTo(taintedNames, name);
    }
    for (const f of fns) if (f.name !== undefined && !taintedFunctions.has(f.name) && returnsTainted(f.node)) { taintedFunctions.add(f.name); changed = true; }
    for (const p of params) if (p.initializer !== undefined && tainted(p.initializer)) for (const name of boundNames(p.name)) addTo(taintedNames, name);
    for (const a of assigns) if (ts.isIdentifier(a.left) && tainted(a.right)) addTo(taintedNames, a.left.text);
  }

  // ---------- 3. L4: parser-/wiringfiler nevner aldri `process` ----------
  if (rules.envFreeFiles.includes(file)) {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && (n.text === "process" || n.text === "globalThis")) fail(n, "L4", `«${n.text}» i en parser-/wiringfil for en flaggfamilie (miljøet skal kun komme som parameter)`);
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && PROCESS_MODULES.has(n.moduleSpecifier.text)) fail(n, "L4", "import av node:process i en parser-/wiringfil");
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ---------- 4. kall, definisjoner, bruk som verdi og direkte flaggleser ----------
  const argTextOf = (call: ts.CallExpression, position: "arg0" | "env-prop"): string | undefined => {
    const first = call.arguments[0];
    if (first === undefined) return undefined;
    if (position === "arg0") return first.getText(sf);
    const obj = unwrap(first);
    if (!ts.isObjectLiteralExpression(obj)) return undefined;
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === "env") return prop.initializer.getText(sf);
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "env") return "env";
    }
    return undefined;
  };
  const calleeFunction = (expr: ts.Expression): string | undefined => {
    const u = unwrap(expr);
    if (ts.isIdentifier(u)) return guarded.get(u.text);
    if (ts.isPropertyAccessExpression(u) && isGuardedName(u.name.text)) return u.name.text; // navneromsimport: ns.parseCommsConfig(...)
    return undefined;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (isGateCall(n)) {
        gateCalls += 1;
        if (n.arguments.length !== 1 || n.arguments[0]?.getText(sf) !== "process.env") fail(n, "L6", `${rules.gateFunction} må bygges av det rå prosessmiljøet (eksakt «process.env»), ikke av «${n.arguments.map((a) => a.getText(sf)).join(", ")}»`);
      }
      const fn = calleeFunction(n.expression);
      if (fn !== undefined) {
        guardedCalls[fn] = (guardedCalls[fn] ?? 0) + 1;
        if (n.arguments.length === 0) fail(n, "L2", `${fn}() uten miljø-argument (en standardverdi ville lest rått miljø)`);
        for (const arg of n.arguments) if (tainted(arg)) fail(n, "L3", `${fn} får rått prosessmiljø som argument («${arg.getText(sf).slice(0, 80)}»)`);
        for (const rule of rules.envArgs) {
          if (rule.fn !== fn || rule.file !== file) continue;
          const text = argTextOf(n, rule.position);
          if (text === undefined || !rule.allowed.includes(text)) fail(n, "L2", `${fn}: miljø-argumentet er «${text ?? "(mangler)"}», forventet ${rule.allowed.map((a) => `«${a}»`).join(" eller ")}`);
        }
      }
    }
    // indirekte kall og bruk som verdi: hver referanse til en guardet funksjon må være et direkte kall
    if (ts.isIdentifier(n) && (guarded.has(n.text) || (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n && isGuardedName(n.text)))) {
      const parent = n.parent;
      const isDeclarationPosition =
        ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) ||
        (ts.isFunctionDeclaration(parent) && parent.name === n) || (ts.isVariableDeclaration(parent) && parent.name === n) || ts.isBindingElement(parent) ||
        (ts.isPropertyAssignment(parent) && parent.name === n) || (ts.isParameter(parent) && parent.name === n) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
      const isCallee = (ts.isCallExpression(parent) && parent.expression === n) || (ts.isPropertyAccessExpression(parent) && parent.name === n && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
      if (!isDeclarationPosition && !isCallee) fail(n, "L1", `«${n.text}» brukes som verdi (ikke et direkte kall): kan omgå miljø-kontrollen`);
    }
    // `fn.call/.apply/.bind` er indirekte kall
    if (ts.isPropertyAccessExpression(n) && INDIRECT.has(n.name.text)) {
      const base = unwrap(n.expression);
      if ((ts.isIdentifier(base) && guarded.has(base.text)) || (ts.isPropertyAccessExpression(base) && isGuardedName(base.name.text))) fail(n, "L1", `${n.name.text} på en guardet funksjon`);
    }
    // L5: definisjoner
    const defName = ts.isFunctionDeclaration(n) ? n.name?.text : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : undefined;
    if (defName !== undefined && isGuardedName(defName)) {
      const fnNode = ts.isVariableDeclaration(n) ? (n.initializer !== undefined && (ts.isArrowFunction(unwrap(n.initializer)) || ts.isFunctionExpression(unwrap(n.initializer))) ? (unwrap(n.initializer) as ts.ArrowFunction | ts.FunctionExpression) : undefined) : n;
      if (fnNode !== undefined && (ts.isFunctionDeclaration(fnNode) || ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode) || ts.isMethodDeclaration(fnNode))) {
        const first = fnNode.parameters[0];
        if (first === undefined) fail(n, "L5", `${defName} har ingen miljø-parameter`);
        else if (first.initializer !== undefined || first.questionToken !== undefined) fail(n, "L5", `${defName}: første parameter (miljøet) må være obligatorisk og uten standardverdi (var «${first.initializer?.getText(sf) ?? "?"}»)`);
      }
    }
    // L7: direkte lesing av en bundet flagg fra rått miljø
    if (ts.isPropertyAccessExpression(n) && rules.boundFlagNames.has(n.name.text) && tainted(n.expression)) fail(n, "L7", `direkte lesing av ${n.name.text} fra rått prosessmiljø`);
    if (ts.isElementAccessExpression(n)) {
      const key = literalKey(n.argumentExpression);
      if (key !== undefined && rules.boundFlagNames.has(key) && tainted(n.expression)) fail(n, "L7", `direkte lesing av ${key} fra rått prosessmiljø`);
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined && tainted(n.initializer)) {
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name;
        const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
        if (keyText !== undefined && rules.boundFlagNames.has(keyText)) fail(el, "L7", `destrukturering av ${keyText} fra rått prosessmiljø`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return { file, violations, guardedCalls, gateCalls };
}

/** Samler per-fil-resultatene: tillatelseslistene (L1) og ÉN port (L6). */
export function aggregate(results: Iterable<ScanResult>, rules: GateRules): string[] {
  const out: string[] = [];
  const perFunction = new Map<string, Map<string, number>>();
  let gateTotal = 0;
  const gateFiles: string[] = [];
  for (const r of results) {
    out.push(...r.violations);
    for (const [fn, n] of Object.entries(r.guardedCalls)) {
      if (!perFunction.has(fn)) perFunction.set(fn, new Map());
      perFunction.get(fn)?.set(r.file, n);
    }
    if (r.gateCalls > 0) { gateTotal += r.gateCalls; gateFiles.push(r.file); }
  }
  for (const [fn, allowed] of Object.entries(rules.guardedCalls)) {
    const seen = perFunction.get(fn) ?? new Map<string, number>();
    for (const [file, n] of seen) {
      const expected = allowed[file];
      if (expected === undefined) out.push(`${file} [L1] ${fn} kalles ${n} gang(er) fra en fil som ikke står på tillatelseslisten`);
      else if (expected !== "some" && expected !== n) out.push(`${file} [L1] ${fn} kalles ${n} ganger, forventet ${expected}`);
    }
    for (const file of Object.keys(allowed)) if (!seen.has(file)) out.push(`${file} [L1] ${fn} kalles ikke lenger herfra: tillatelseslisten er foreldet, eller kallet er flyttet til en fil som ikke er vurdert`);
  }
  if (gateTotal !== 1 || gateFiles.length !== 1 || gateFiles[0] !== rules.gateFile) out.push(`[L6] ${rules.gateFunction} skal kalles nøyaktig én gang, i ${rules.gateFile} (fant ${gateTotal} kall i: ${gateFiles.join(", ") || "ingen filer"})`);
  return out;
}
