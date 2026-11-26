import { describe, expect, it } from "vitest";
import { currentModelScope, currentServingModel, detachFromCallSignal, runWithCallSignal, withholdFinanceFromCurrentModel } from "../src/index.ts";
// setteren er IKKE offentlig API (fiks-runde 1, FIX-4: `index.ts` eksporterer kun lesere og typer) - testen importerer den direkte fra modulen
import { runWithModelScope } from "../src/model-scope.ts";

/**
 * WP-N1b (K1): AsyncLocalStorage-hjelperne bak den modell-stemplede konteksten (`model-scope.ts`), uten gateway og uten DB.
 *  - leserne gir `undefined`/`false` uten skop (eierens kode, vakten AV);
 *  - skopet følger den asynkrone kjeden (await, timere, setImmediate, mikrotasks, Promise.all) og KUN den;
 *  - mange samtidige kall med ulike modeller krysser aldri;
 *  - setteren er fail-closed (`cloud` er sky med mindre kalleren sier eksplisitt `false`) og fryser skopet;
 *  - skopet er uavhengig av `call-signal`-kontekstene (egen AsyncLocalStorage).
 */
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = { provider: "gemma_local", model: "gemma3:4b" };

describe("lesere uten skop", () => {
  it("ingen modell: `undefined`, `undefined`, `false`", () => {
    expect(currentModelScope()).toBeUndefined();
    expect(currentServingModel()).toBeUndefined();
    expect(withholdFinanceFromCurrentModel()).toBe(false);
  });
});

describe("setteren", () => {
  it("sky: lesere ser modellen og `withhold = true`; lokal: modellen og `withhold = false`", () => {
    runWithModelScope({ servingModel: CLOUD, cloud: true }, () => {
      expect(currentServingModel()).toEqual(CLOUD);
      expect(withholdFinanceFromCurrentModel()).toBe(true);
    });
    runWithModelScope({ servingModel: LOCAL, cloud: false }, () => {
      expect(currentServingModel()).toEqual(LOCAL);
      expect(withholdFinanceFromCurrentModel()).toBe(false);
    });
  });

  it("FAIL-CLOSED: en utelatt, `undefined`, `null`, 0, «false»-streng eller ikke-boolsk `cloud` regnes som sky - kun eksakt `false` gir lokal", () => {
    for (const bad of [undefined, null, 0, "", "false", "no", {}, [], 1, "true"]) {
      runWithModelScope({ servingModel: LOCAL, cloud: bad as never }, () => expect(withholdFinanceFromCurrentModel(), JSON.stringify(bad)).toBe(true));
    }
    runWithModelScope({ servingModel: LOCAL }, () => expect(withholdFinanceFromCurrentModel(), "utelatt").toBe(true));
    runWithModelScope({ servingModel: LOCAL, cloud: false }, () => expect(withholdFinanceFromCurrentModel()).toBe(false));
  });

  it("lesingen krever eksakt `true`: et skop hvis `cloud` (mot typen) ikke er `true` er IKKE sky for leseren - men setteren normaliserer alt annet enn `false` til `true`, så et slikt skop kan ikke oppstå via API-et", () => {
    // (kun en direkte manipulasjon av det frosne objektet kunne gitt det, og objektet er frosset)
    runWithModelScope({ servingModel: CLOUD, cloud: true }, () => {
      const scope = currentModelScope();
      expect(Object.isFrozen(scope)).toBe(true);
      expect(() => { (scope as { cloud: boolean }).cloud = false; }).toThrow();
      expect(withholdFinanceFromCurrentModel()).toBe(true);
    });
  });

  it("setteren returnerer fn sitt resultat (også et løfte) og skopet lekker ikke ut - heller ikke når fn kaster eller avviser", async () => {
    expect(runWithModelScope({ servingModel: CLOUD, cloud: true }, () => 42)).toBe(42);
    expect(await runWithModelScope({ servingModel: CLOUD, cloud: true }, async () => { await Promise.resolve(); return "x"; })).toBe("x");
    expect(() => runWithModelScope({ servingModel: CLOUD, cloud: true }, () => { throw new Error("boom"); })).toThrow("boom");
    await expect(runWithModelScope({ servingModel: CLOUD, cloud: true }, async () => { await Promise.resolve(); throw new Error("async-boom"); })).rejects.toThrow("async-boom");
    expect(currentModelScope()).toBeUndefined();
    expect(withholdFinanceFromCurrentModel()).toBe(false);
  });

  it("nøstet setter skygger den ytre og gir tilbake den ytre etterpå (selve helperen tillater det; gatewayen sørger for at et skyskop aldri løsnes)", () => {
    runWithModelScope({ servingModel: CLOUD, cloud: true }, () => {
      runWithModelScope({ servingModel: LOCAL, cloud: false }, () => expect(currentServingModel()).toEqual(LOCAL));
      expect(currentServingModel()).toEqual(CLOUD);
      expect(withholdFinanceFromCurrentModel()).toBe(true);
    });
  });
});

describe("skopet følger den asynkrone kjeden", () => {
  it("overlever await, setTimeout, setImmediate, queueMicrotask, process.nextTick, Promise.all og async-generatorer", async () => {
    await runWithModelScope({ servingModel: CLOUD, cloud: true }, async () => {
      const seen: string[] = [];
      const note = (label: string): void => { seen.push(`${label}:${currentServingModel()?.provider}:${withholdFinanceFromCurrentModel()}`); };
      await Promise.resolve(); note("await");
      await new Promise<void>((r) => setTimeout(() => { note("timeout"); r(); }, 2));
      await new Promise<void>((r) => setImmediate(() => { note("immediate"); r(); }));
      await new Promise<void>((r) => queueMicrotask(() => { note("microtask"); r(); }));
      await new Promise<void>((r) => process.nextTick(() => { note("tick"); r(); }));
      await Promise.all([1, 2, 3].map(async (i) => { await new Promise((r) => setTimeout(r, i)); note(`all${i}`); }));
      async function* gen(): AsyncGenerator<number> { await Promise.resolve(); yield 1; await Promise.resolve(); yield 2; }
      for await (const n of gen()) note(`gen${n}`);
      expect(seen.length).toBe(10); // await, timeout, immediate, microtask, tick, all1-3, gen1-2
      expect(new Set(seen.map((s) => s.split(":").slice(1).join(":")))).toEqual(new Set(["anthropic:true"]));
    });
  });

  it("200 samtidige kjeder med blandede modeller og ulike asynkrone mekanismer krysser aldri (hver ser KUN sin egen modell hele veien)", async () => {
    const models = [{ m: CLOUD, cloud: true }, { m: LOCAL, cloud: false }, { m: { provider: "hermes", model: "h" }, cloud: true }, { m: { provider: "ollama", model: "o" }, cloud: false }];
    const wait = async (i: number): Promise<void> => {
      switch (i % 5) {
        case 0: await new Promise((r) => setTimeout(r, i % 7)); break;
        case 1: await new Promise((r) => setImmediate(r)); break;
        case 2: await Promise.resolve(); break;
        case 3: await new Promise<void>((r) => process.nextTick(r)); break;
        default: await Promise.all([Promise.resolve(), new Promise((r) => setTimeout(r, 1))]);
      }
    };
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => {
      const pick = models[i % models.length] as (typeof models)[number];
      // hvert tredje kall er et «eierkall» UTEN skop, mellom skopede kall
      if (i % 3 === 0) return (async () => { await wait(i); const a = currentServingModel(); await wait(i + 1); return { i, expect: undefined as undefined, got: [a, currentServingModel()], withheld: withholdFinanceFromCurrentModel(), wantCloud: false }; })();
      return runWithModelScope({ servingModel: pick.m, cloud: pick.cloud }, async () => {
        const first = currentServingModel();
        await wait(i);
        const second = currentServingModel();
        await Promise.all([wait(i + 2), wait(i + 3)]);
        const third = currentServingModel();
        await wait(i + 4);
        return { i, expect: pick.m, got: [first, second, third, currentServingModel()], withheld: withholdFinanceFromCurrentModel(), wantCloud: pick.cloud };
      });
    }));
    for (const r of results) {
      for (const g of r.got) expect(g, `kall ${r.i}`).toEqual(r.expect);
      expect(r.withheld, `kall ${r.i}`).toBe(r.wantCloud);
    }
    expect(results.filter((r) => r.expect === undefined).length).toBe(67);
    expect(currentServingModel()).toBeUndefined();
  });

  it("delt, ÅPEN løftet-oppgave: arbeid startet i ÉN kallers skop kjører i DET skopet for alle som venter på det - derfor skal delt arbeid aldri lese skopet (dokumentert atferd, kildevakten i wpn1b-structure låser lesernes plassering)", async () => {
    let shared: Promise<string | undefined> | undefined;
    const start = (): Promise<string | undefined> => (shared ??= (async () => { await new Promise((r) => setTimeout(r, 3)); return currentServingModel()?.provider; })());
    const a = runWithModelScope({ servingModel: CLOUD, cloud: true }, start);
    const b = runWithModelScope({ servingModel: LOCAL, cloud: false }, start);
    const c = start();
    // alle tre får den FØRSTE kallerens modell - nettopp faren som lesere i delt arbeid ville hatt
    expect(await Promise.all([a, b, c])).toEqual(["anthropic", "anthropic", "anthropic"]);
  });
});

describe("uavhengig av call-signal-konteksten (egen AsyncLocalStorage)", () => {
  it("`runWithCallSignal` og `detachFromCallSignal` endrer ikke modell-skopet, og motsatt", async () => {
    await runWithModelScope({ servingModel: CLOUD, cloud: true }, async () => {
      const ac = new AbortController();
      await runWithCallSignal(ac.signal, async () => {
        expect(currentServingModel()).toEqual(CLOUD);
        await detachFromCallSignal(async () => {
          await Promise.resolve();
          expect(currentServingModel()).toEqual(CLOUD);
          expect(withholdFinanceFromCurrentModel()).toBe(true);
        });
      });
    });
    await runWithCallSignal(new AbortController().signal, async () => {
      expect(currentServingModel()).toBeUndefined();
      await runWithModelScope({ servingModel: LOCAL, cloud: false }, async () => { await Promise.resolve(); expect(currentServingModel()).toEqual(LOCAL); });
      expect(currentServingModel()).toBeUndefined();
    });
  });
});
