import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURFACE_TOOL_GRANTS, firstWaveTools, type ToolTransport } from "@jarvis/tool-gateway";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import { BLANK_MODEL, CLOUD, LOCAL, OWNER, TENANT, UNKNOWN_MODEL, buildWorld, run, type ModelArg, type World } from "./support/n1b-finance-world.ts";

/**
 * WP-N1b fiks-runde 1 (FIX-6): leverandørverktøy som returnerer SALDO/KOSTNAD/FORBRUK/FAKTURERING/KVOTE. Beløp og saldo er finansavledet metadata (Q-64 pkt 1, strengeste regel), også når de kommer fra en leverandør i stedet for fra `finance*`.
 *  A. `telnyx.get_account_info` (`GET /v2/balance`: kontoens saldo, på chattens lese-nivå) holdes tilbake fra sky/ukjent modell VED UTFØRELSE, og leverandøren KALLES IKKE (spion). Lokal modell, eierens ruter (inkl. livetesten i `/connectors`) og vakten AV
 *     får saldoen som før.
 *  B. SYSTEMATISK gjennomgang: hver handling på en modellflate hvis beskrivelse har penge-/forbruksord er klassifisert her (tilbakeholdt / DEFERRED / akseptert, med begrunnelse). En NY slik handling feller testen til noen har vurdert den - aldri en stille utelatelse.
 *     (Kodegjennomgangen av transportene fant kun én som selv leser en saldo: `telnyx` `/balance`; øvrige leverandører gir råsvar uten egen pengelesing - se runbooken for de som kan BÆRE beløp i leverandørens egne felt.)
 */
let db: H0Db;
let on: World;
let off: World;
const calls: Array<{ action: string }> = [];
const BALANCE = { balance: "N1B-SALDO-1234.56", credit_limit: "N1B-KREDITT-500.00", available_credit: "N1B-TILGJENGELIG-1734.56", currency: "USD", record_type: "balance" };
const spy: ToolTransport = { async invoke(action) { calls.push({ action }); return { data: BALANCE as never }; } };

beforeAll(async () => {
  db = await startH0Db("n1bprov");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  on = buildWorld({ pool: db.appPool, guard: true, transports: { telnyx: spy } });
  off = buildWorld({ pool: db.appPool, guard: false, transports: { telnyx: spy } });
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

const text = (r: { ok: boolean; reason?: string; data?: unknown }): string => JSON.stringify(r.ok ? r.data : { denied: r.reason });
const MODELS_WITHHELD: Array<[string, ModelArg]> = [["sky", CLOUD], ["ukjent leverandør", UNKNOWN_MODEL], ["blank leverandør", BLANK_MODEL]];
const MODELS_FULL: Array<[string, ModelArg]> = [["lokal modell", LOCAL], ["eierens rute (ingen modell)", undefined]];

describe("A: telnyx.get_account_info (kontosaldo) - tilbakeholdt VED UTFØRELSE for sky/ukjent, leverandøren kalles ikke", () => {
  for (const [label, model] of MODELS_WITHHELD) {
    it(`${label}: kun det nøytrale merket (ingen saldo, ingen kredittgrense, ingen valuta, ingen feltnavn), og transporten er IKKE kalt`, async () => {
      const before = calls.length;
      const r = await run(on.gateway, "telnyx", "get_account_info", {}, model);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(calls.length, "leverandøren ble kalt for en sky-modell").toBe(before);
      const t = text(r);
      for (const m of ["N1B-SALDO", "N1B-KREDITT", "N1B-TILGJENGELIG", "USD", "balance", "credit_limit", "available_credit", "currency"]) expect(t, `lekket: ${m}`).not.toContain(m);
      expect(t).toContain('"finance_withheld":true');
      expect(r.external_id, "external_id").toBeUndefined();
    });
  }
  for (const [label, model] of MODELS_FULL) {
    it(`${label}: saldoen som før (leverandøren kalles), uten merke`, async () => {
      const before = calls.length;
      const r = await run(on.gateway, "telnyx", "get_account_info", {}, model);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(calls.length).toBe(before + 1);
      expect(text(r)).toContain("N1B-SALDO-1234.56");
      expect(text(r)).not.toContain("finance_withheld");
    });
  }
  it("FLAGG AV (ingen lås, ingen sentral kontekst): en skymodell får saldoen som på main - ingen innpakning som endrer svaret", async () => {
    const before = calls.length;
    const r = await run(off.gateway, "telnyx", "get_account_info", {}, CLOUD);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(calls.length).toBe(before + 1);
    expect(text(r)).toContain("N1B-SALDO-1234.56");
    expect(text(r)).not.toContain("finance_withheld");
  });
  it("de ANDRE telnyx-/twilio-handlingene er urørt for sky: `twilio.get_account_info` (kontoidentitet, ingen beløp) går til leverandøren", async () => {
    const seen: string[] = [];
    const w = buildWorld({ pool: db.appPool, guard: true, transports: { twilio: { async invoke(action) { seen.push(action); return { data: { friendly_name: "konto", status: "active" } as never }; } } } });
    const r = await run(w.gateway, "twilio", "get_account_info", {}, CLOUD);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(seen).toEqual(["get_account_info"]);
    expect(text(r)).toContain("friendly_name");
  });
});

describe("B: penge-/forbruksord i beskrivelsene av modell-tildelte handlinger er klassifisert (ingen stille utelatelse)", () => {
  type Status = "withheld" | "deferred" | "accepted";
  const CLASSIFIED: Readonly<Record<string, readonly [Status, string]>> = {
    "telnyx.get_account_info": ["withheld", "kontosaldo (`GET /v2/balance`): holdt tilbake for sky/ukjent, leverandøren kalles ikke (A over)"],
    "googleads.sync_spend": ["deferred", "synker annonseutgift inn i Growth-kjernens egne tabeller; svaret er antall/status. Eierbeslutning om annonseutgift er finans (Q-N1b-2), samme som `growth.*`"],
    "metaads.sync_spend": ["deferred", "som `googleads.sync_spend`"],
    "growth.list_spend_events": ["deferred", "utgiftshistorikk per kampanje (Growth-kjernen, egne tabeller): Q-N1b-2 (begrensning 21)"],
    "growth.record_spend_event": ["deferred", "skriving bak bekreftelseskortet; ekkoer raden: Q-N1b-2"],
    "growth.set_budget": ["deferred", "skriving bak bekreftelseskortet; ekkoer raden: Q-N1b-2"],
    "growth.generate_execution_command": ["deferred", "beregner en budsjettkommando fra en godkjent anbefaling (`current_budget_ore`): Q-N1b-2"],
    "business.get_churn_overview": ["accepted", "ANTALL forfalte kundefakturaer fra produktbruk-fakturasignalet (ikke `finance*`), ingen beløp: kartlagt, hører med i samme eierbeslutning (Q-N1b-6)"],
    "business.link_product_account": ["accepted", "kun ordet «produktbruk» i beskrivelsen: en skrivehandling bak bekreftelseskortet uten beløp"],
    "product.create_item": ["accepted", "kun ordet «usage feedback» (en type produktpunkt): ingen beløp"]
  };
  const MONEY_WORDS = /(saldo|balance|kostnad|cost|spend|utgift|forbruk|faktura|invoice|billing|kvote|quota|credit|kreditt|beløp|amount|budsjett|budget|\bpris|price|revenue|omsetning|betaling|payment|\børe\b|\bnok\b|\busd\b|inntekt|income|abonnement|subscription|usage|bruk\b)/i;

  it("hver handling på en modellflate (utenom `finance*`) med et penge-/forbruksord i beskrivelsen står i klassifiseringen, og ingen oppføring er foreldet", () => {
    const granted = new Set(Object.values(SURFACE_TOOL_GRANTS).flat().map((g) => `${g.tool_id}.${g.action}`));
    const hits = firstWaveTools({})
      .filter((d) => granted.has(`${d.tool_id}.${d.action}`) && !d.tool_id.startsWith("finance") && MONEY_WORDS.test(d.description))
      .map((d) => `${d.tool_id}.${d.action}`).sort();
    expect(hits, "en ny handling med penge-/forbruksord i beskrivelsen: vurder den (tilbakehold ved utførelse, eller dokumentert DEFERRED/akseptert) og legg den inn her").toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("`telnyx.get_account_info` er den ENESTE `withheld`-oppføringen og er faktisk pakket (kallet til leverandøren skjer ikke for sky) - se A", () => {
    expect(Object.entries(CLASSIFIED).filter(([, v]) => v[0] === "withheld").map(([k]) => k)).toEqual(["telnyx.get_account_info"]);
  });
});
