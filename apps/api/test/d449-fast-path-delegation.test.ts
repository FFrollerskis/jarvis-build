import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { CompleteInput } from "@jarvis/model-gateway";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import { jobLocalOnlyNote, stripSystemNotes } from "../src/tool-turn-route.ts";
import { STARTED, baseIdentity as base, buildEngine as build, captureLogs, type Row } from "./support/fast-path-harness.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 2, 3 og 4): hurtigbanen «… i bakgrunnen» hopper over modellen og dermed over alt chatten bruker for å velge rute. Den første rettelsen kopierte deler av chattens
 * avgjørelse (siste meldinger, ruteoverstyring), og gjennomgang 3 fant at resten manglet (verktøyutvalgets finansnivå D-381, minnemetadata, eksplisitt `provider`). Nå bruker begge SAMME beregning
 * (`ConversationEngine.resolveTurnRouting`). Denne filen låser det med en PARITETSTEST: den samme meldingen sendt som vanlig chat og som «… i bakgrunnen» må ende på samme side av sky/lokalt -
 * for hver rad i tabellen, kjørt over PRODUKSJONENS verktøyoverflate (`support/fast-path-harness.ts`, ikke et håndplukket utsnitt). Gjennomgang 4 fant tre steder der hurtigbanen likevel var løsere
 * (frasen midt i en ruteinstruksjon, linjeskift som endrer verktøyutvalget, en leveringsmelding som forskyver vinduet) og én stille nedgradering; de er låst nederst.
 */
const PR_ASK = "list åpne PR-er på tsworkflow/jarvisbuild";
const BG = " i bakgrunnen";

type Meta = { text: string; spaces: string[]; sensitivities: string[] };

let logs: ReturnType<typeof captureLogs> | undefined;
/** Stillegger loggen og gir en henter for loggede linjer; gjenopprettes etter hver test. */
function capture(): (msg: string) => Array<{ msg: string; reasons?: string[] }> {
  logs = captureLogs();
  return logs.lines;
}
afterEach(() => { logs?.restore(); logs = undefined; });

/** Chattens skyrute = `providerPreference` starter med anthropic, uten «ikke bruk betalte modeller» og uten at turen er låst (SECRET_RESTRICTED). */
const goesCloud = (input: CompleteInput | undefined): boolean =>
  input !== undefined && input.sensitivity !== "SECRET_RESTRICTED" && input.providerPreference?.[0] === "anthropic" && input.paid_models_allowed !== false;

const FINANCE_PRIOR: Row = { role: "user", content: "Saldoen min er 45 000 kr og lånet er på 2 mill" };
const HEALTH_PRIOR: Row = { role: "user", content: "Jeg hadde legetime i dag og fikk en ny diagnose" };
const BANK_PRIOR: Row = { role: "user", content: "vis bank-transaksjonene mine" };
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ role: "assistant" as const, content: `greit ${i}` }));

interface Case {
  name: string;
  message: string;
  prior?: Row[];
  meta?: Meta;
  provider?: string;
  cloud: boolean;
}

/** Hver rad: samme melding som vanlig chat og som «… i bakgrunnen» må ende på samme side - og på den forventede. */
const CASES: Case[] = [
  { name: "nøytral GitHub-forespørsel", message: PR_ASK, cloud: true },
  { name: "nøytral forespørsel etter småprat", message: PR_ASK, prior: [{ role: "user", content: "hei" }, { role: "assistant", content: "Hei!" }], cloud: true },
  { name: "bank/e-post (finansverktøy valgt, D-381) - ingen ord klassifiseringen kjenner", message: "Finn alle e-postene fra banken forrige måned og oppsummer dem", cloud: false },
  { name: "utgifter/abonnement (finansverktøy valgt)", message: "Gå gjennom utgiftene og abonnementene mine i e-posten", cloud: false },
  { name: "kontoutskrift (finansverktøy valgt)", message: "Sjekk kontoutskriften fra DNB i e-posten min", cloud: false },
  { name: "kontoen/banken (finansverktøy valgt)", message: "Hva står på kontoen min ifølge e-postene fra banken", cloud: false },
  // Q-51 D (D-450): en følsom melding i historikken låser ikke lenger hele turen - skyturen sendes UTEN den meldingen (se d450-routing-q51-q53-228.test.ts for hva som faktisk sendes). Samme i hurtigbanen.
  { name: "finans nylig i samtalen (D-384-vinduet): skyturen sendes uten meldingen (Q-51 D)", message: PR_ASK, prior: [FINANCE_PRIOR], cloud: true },
  { name: "helse nylig i samtalen: skyturen sendes uten meldingen (Q-51 D)", message: PR_ASK, prior: [HEALTH_PRIOR], cloud: true },
  { name: "finans i selve meldingen låser fortsatt (kan ikke utelates)", message: "Sjekk saldoen min i e-posten", cloud: false },
  { name: "helse i selve meldingen låser fortsatt", message: "Sjekk legetimen min i kalenderen", cloud: false },
  { name: "sensitiv melding eldre enn vinduet låser ikke", message: PR_ASK, prior: [FINANCE_PRIOR, ...filler(4)], cloud: true },
  { name: "finansverktøy arves fra eierens tidligere melding (D-389), eldre enn vinduet", message: "og den neste da?", prior: [BANK_PRIOR, ...filler(4)], cloud: false },
  { name: "eksplisitt provider (API/tale-enhet)", message: PR_ASK, provider: "gemma_local", cloud: false },
  { name: "«kun lokale modeller» i teksten", message: `Kun lokale modeller: ${PR_ASK}`, cloud: false },
  { name: "«ikke bruk betalte modeller» i teksten", message: `Ikke bruk betalte modeller, men ${PR_ASK}`, cloud: false },
  { name: "minnetreff merket special (direkte treff)", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["personal"], sensitivities: ["special"] }, cloud: false },
  { name: "minnetreff i helse-rommet", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["health"], sensitivities: ["normal"] }, cloud: false },
  { name: "vanlig personlig minnetreff", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["personal"], sensitivities: ["normal"] }, cloud: true }
];

describe("D-449: paritet - hurtigbanen og chatten treffer samme ruteavgjørelse (produksjonens verktøyoverflate)", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.cloud ? "sky" : "lokalt"} i begge`, async () => {
      capture();
      // Chatten: samme melding uten «i bakgrunnen» (modellturen). Skyruten = providerPreference ["anthropic"].
      const chat = build({ prior: c.prior ?? [], ...(c.meta ? { meta: c.meta } : {}) });
      await chat.engine.handle(base, c.message, undefined, undefined, c.provider);
      expect(chat.captured.length, "chatturen må ha brukt verktøy for at paritet er meningsfull").toBe(1);
      // «Ikke bruk betalte modeller» sender fortsatt skyruten som preferanse, men med `paid_models_allowed: false` - ruteren avviser da Anthropic og turen faller lokalt (D-354).
      const chatCloud = goesCloud(chat.captured[0]);
      expect(chatCloud, "chattens avgjørelse").toBe(c.cloud);

      // Hurtigbanen: samme melding + «i bakgrunnen».
      const fast = build({ prior: c.prior ?? [], ...(c.meta ? { meta: c.meta } : {}) });
      await fast.engine.handle(base, `${c.message}${BG}`, undefined, undefined, c.provider);
      expect(fast.runs, "hurtigbanen må ha delegert").toHaveLength(1);
      expect(fast.captured, "hurtigbanen bruker ingen modell").toHaveLength(0);
      expect(fast.runs[0]!.options, "hurtigbanens avgjørelse").toEqual({ cloudAllowed: chatCloud });
    });
  }
});

describe("D-449: hurtigbanens øvrige regler", () => {
  it("lokalt-tvang gir synlig merknad (ikke på tale) med kategorier, og logglinjen d449_fast_delegate_local uten innhold", async () => {
    const lines = capture();
    // Q-51 D (D-450): en følsom melding i historikken kan utelates fra skyturen, så låsen må komme fra selve meldingen (som ikke kan utelates).
    const ask = "Sjekk saldoen min i e-posten";
    const t = build({});
    const result = await t.engine.handle(base, `${ask}${BG}`);
    expect(result.reply).toContain(STARTED);
    expect(result.reply).toContain("Jobben kjører på den lokale modellen");
    expect(result.reply).toContain("økonomi");
    const local = lines("d449_fast_delegate_local");
    expect(local).toHaveLength(1);
    expect(local[0]!.reasons).toContain("text:finance");
    expect(JSON.stringify(local)).not.toMatch(/saldo|e-posten/i);

    const voice = build({});
    const spoken = await voice.engine.handle({ ...base, channel: "voice" }, `${ask}${BG}`);
    expect(voice.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(spoken.reply).toBe(STARTED);
  });

  it("Q-51 D: en følsom melding i historikken (ikke i selve meldingen) gir skyjobb uten merknad - jobben får bare oppgaveteksten, aldri samtalen", async () => {
    const lines = capture();
    const t = build({ prior: [FINANCE_PRIOR] });
    const result = await t.engine.handle(base, `${PR_ASK}${BG}`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: true });
    expect(result.reply).toBe(STARTED);
    expect(lines("d449_fast_delegate_local")).toEqual([]);
  });

  it("verktøyutvalgets finansnivå gir kategorien «økonomitjenester» i merknaden (uten ord klassifiseringen kjenner)", async () => {
    capture();
    const t = build({});
    const result = await t.engine.handle(base, `Finn alle e-postene fra banken forrige måned og oppsummer dem${BG}`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("meldingen peker på økonomitjenester");
  });

  it("innlimt tekst (e-posthoder, lange tekster) regnes ikke som eierens egne ord → lokalt, med merknad", async () => {
    capture();
    const t = build({});
    const result = await t.engine.handle(base, `Fra: noen@example.com\nEmne: Rapport\n\nHei, kan du list åpne PR-er${BG}?`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("innlimt tekst regnes ikke som dine egne ord");
  });

  it("ruteavgjørelsen kan ikke beregnes (historikk eller minne feiler) → lokalt (fail-closed) med merknad", async () => {
    capture();
    for (const failing of [{ historyThrows: true }, { metaThrows: true }] as const) {
      const t = build({ ...failing });
      const result = await t.engine.handle(base, `${PR_ASK}${BG}`);
      expect(t.runs[0]!.options, JSON.stringify(failing)).toEqual({ cloudAllowed: false });
      expect(result.reply).toContain("samtalen kunne ikke kontrolleres");
    }
  });

  it("minnet leses uten å oppdatere «sist brukt» (touch: false) - hurtigbanen bruker ikke minnet, den vurderer bare ruten", async () => {
    capture();
    const t = build({});
    await t.engine.handle(base, `${PR_ASK}${BG}`);
    expect(t.memCalls.length).toBeGreaterThan(0);
    for (const call of t.memCalls) expect((call.options as { touch?: boolean } | undefined)?.touch).toBe(false);
  });

  it("jobben ble ikke startet (for mange aktive jobber o.l.) → forklaringen vises uten merknad om lokal modell; uten delegering leses ingenting", async () => {
    capture();
    const full = build({ prior: [FINANCE_PRIOR], runResult: { started: false, reply: "Det kjører allerede 5 bakgrunnsjobber. Vent til en er ferdig.", cloud: false } });
    const r1 = await full.engine.handle(base, `${PR_ASK}${BG}`);
    expect(r1.reply).toBe("Det kjører allerede 5 bakgrunnsjobber. Vent til en er ferdig.");

    const failed = build({ runResult: null });
    expect((await failed.engine.handle(base, `${PR_ASK}${BG}`)).reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");

    const none = build({ withDelegate: false, historyThrows: true });
    expect((await none.engine.handle(base, `${PR_ASK}${BG}`)).reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");
  });

  it("merknaden (som lagres i samtalen) kan aldri selv låse samtalen lokalt: den fjernes strukturelt fra historikken (Q-52 A: «helse» står i ordforrådet, så teksten kan ikke garanteres nøytral)", () => {
    const combos = [
      ["text:finance"], ["text:health"], ["text:secret"], ["memory_space:health"], ["memory_sensitivity:special"], ["tool_selection:SECRET_RESTRICTED"],
      ["text:finance", "text:health", "text:secret", "memory_space:health", "memory_sensitivity:special", "tool_selection:SECRET_RESTRICTED", "job_text_gate"],
      ["owner_routing_override"], ["explicit_provider"], ["pasted_content"], ["routing_unreadable"], ["job_text_gate"],
      ["owner_routing_override", "text:finance"], ["pasted_content", "text:health", "memory_space:health"], []
    ];
    for (const reasons of combos) {
      const note = jobLocalOnlyNote(reasons);
      expect(note).toContain("Jobben kjører på den lokale modellen");
      const stored = `${STARTED}${note}`;
      expect(stripSystemNotes(stored), reasons.join(",")).toBe(STARTED);
      expect(classifyContentSensitivity({ texts: [stripSystemNotes(stored)] }).sensitivity, reasons.join(",")).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
  });
});

describe("D-449 gjennomgang nr. 4: hurtigbanen er aldri løsere enn chatten", () => {
  /** Chatten får forespørselen UTEN delegeringsfrasen; hurtigbanen får den MED. */
  async function bothWays(opts: { chat: string; fast: string; prior?: Row[]; afterUserSave?: string; channel?: IdentityContext["channel"] }) {
    capture();
    const identity = opts.channel ? { ...base, channel: opts.channel } : base;
    const chat = build({ prior: opts.prior ?? [], ...(opts.afterUserSave ? { afterUserSave: opts.afterUserSave } : {}) });
    await chat.engine.handle(identity, opts.chat);
    const fast = build({ prior: opts.prior ?? [], ...(opts.afterUserSave ? { afterUserSave: opts.afterUserSave } : {}) });
    const result = await fast.engine.handle(identity, opts.fast);
    expect(fast.runs, "hurtigbanen må ha delegert").toHaveLength(1);
    return { chat, fast, result };
  }

  it("ruteinstruksjon delt av frasen («bruk i bakgrunnen bare lokale modeller») → lokalt, som «bruk bare lokale modeller» i chatten", async () => {
    const { chat, fast, result } = await bothWays({ chat: "Sjekk e-posten min, og bruk bare lokale modeller", fast: "Sjekk e-posten min, og bruk i bakgrunnen bare lokale modeller" });
    expect(goesCloud(chat.captured[0]), "chatten").toBe(false);
    expect(fast.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(fast.runs[0]!.cloud).toBe(false);
    expect(result.reply).toContain("meldingen har en egen instruks om modellvalg");
  });

  it("«ikke bruk betalte modeller», «bruk Gemma» og «bare lokale modeller» delt av frasen → lokalt", async () => {
    for (const [chat, fast] of [
      ["Sjekk e-posten min, men ikke bruk betalte modeller", "Sjekk e-posten min, men ikke bruk i bakgrunnen betalte modeller"],
      ["Sjekk e-posten min og bruk Gemma", "Sjekk e-posten min og bruk i bakgrunnen Gemma"],
      ["Sjekk e-posten min, bruk bare lokale modeller", "Sjekk e-posten min, bruk bare lokale i bakgrunnen modeller"]
    ] as const) {
      const run = await bothWays({ chat, fast });
      expect(goesCloud(run.chat.captured[0]), chat).toBe(false);
      expect(run.fast.runs[0]!.options, fast).toEqual({ cloudAllowed: false });
    }
  });

  it("innlimt tekst avsløres også av en fjerning av frasen: «Fra: …⏎i bakgrunnen Emne: …» har én overskriftslinje slik den står, men to uten frasen", async () => {
    const { chat, fast, result } = await bothWays({
      chat: "Fra: noen@example.com\nEmne: Rapport - list åpne PR-er",
      fast: "Fra: noen@example.com\ni bakgrunnen Emne: Rapport - list åpne PR-er"
    });
    expect(chat.captured.length, "chatten behandlet den som en vanlig verktøytur").toBe(1);
    expect(fast.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("innlimt tekst regnes ikke som dine egne ord");
  });

  it("linjeskift endrer verktøyutvalget: «hvor lang tid tar det⏎dit i bakgrunnen» arver finansverktøy fra eierens tidligere melding, som chatten gjør", async () => {
    const { chat, fast } = await bothWays({ chat: "hvor lang tid tar det\ndit", fast: "hvor lang tid tar det\ndit i bakgrunnen", prior: [BANK_PRIOR, ...filler(4)] });
    expect(goesCloud(chat.captured[0]), "chatten").toBe(false);
    expect(fast.runs[0]!.options).toEqual({ cloudAllowed: false });
  });

  it("en leveringsmelding som lagres rett etter eierens melding forskyver ikke eier-vinduet (siste BRUKERrad omskrives, ikke siste rad)", async () => {
    const prior: Row[] = [BANK_PRIOR, { role: "assistant", content: "ok" }, { role: "user", content: "fint" }, { role: "assistant", content: "ok" }, { role: "user", content: "flott" }, { role: "assistant", content: "ok" }];
    const delivery = "Bakgrunnsjobben «PR-er» er ferdig: tre åpne PR-er";
    for (const afterUserSave of [undefined, delivery]) {
      const { chat, fast } = await bothWays({ chat: "og den neste da?", fast: `og den neste da?${BG}`, prior, ...(afterUserSave ? { afterUserSave } : {}) });
      expect(goesCloud(chat.captured[0]), `chatten (${afterUserSave ? "med levering" : "uten"})`).toBe(false);
      expect(fast.runs[0]!.options, `hurtigbanen (${afterUserSave ? "med levering" : "uten"})`).toEqual({ cloudAllowed: false });
    }
  });

  it("transporten nekter selve jobbteksten selv om motoren sa ja → jobben kjører lokalt MED merknad (aldri en stille nedgradering), ikke på tale", async () => {
    const lines = capture();
    // Telegram og tale har ingen finansverktøy, så motoren (D-381/D-389) ser ingenting; transportens kontroll av jobbteksten (`financeToolIntent`) fanger «banken».
    const telegram = build({});
    const result = await telegram.engine.handle({ ...base, channel: "telegram" }, `sjekk e-post fra banken${BG}`);
    expect(telegram.runs[0]!.options, "motoren sa ja").toEqual({ cloudAllowed: true });
    expect(telegram.runs[0]!.cloud, "transporten nektet").toBe(false);
    expect(result.reply).toContain(STARTED);
    expect(result.reply).toContain("Jobben kjører på den lokale modellen");
    expect(result.reply).toContain("selve jobbteksten berører økonomi");
    expect(lines("d449_fast_delegate_local")[0]?.reasons).toEqual(["job_text_gate"]);

    const voice = build({});
    const spoken = await voice.engine.handle({ ...base, channel: "voice" }, `sjekk e-post fra banken${BG}`);
    expect(voice.runs[0]!.cloud).toBe(false);
    expect(spoken.reply, "ingen merknad på tale").toBe(STARTED);

    // Kontroll: en ren forespørsel gir skyflagget fra begge ledd og ingen merknad.
    const clean = build({});
    const ok = await clean.engine.handle({ ...base, channel: "telegram" }, `${PR_ASK}${BG}`);
    expect(clean.runs[0]!.cloud).toBe(true);
    expect(ok.reply).toBe(STARTED);
  });

  it("transporten melder at skyflagget IKKE ble satt (cloud: false) selv om motoren sa ja → merknad; flagget er det som teller, ikke motorens ja", async () => {
    capture();
    const t = build({ runResult: { started: true, reply: STARTED, cloud: false } });
    const result = await t.engine.handle(base, `${PR_ASK}${BG}`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: true });
    expect(result.reply).toContain("Jobben kjører på den lokale modellen");
  });
});
