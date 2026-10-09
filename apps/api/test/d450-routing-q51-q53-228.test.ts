import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import { ProviderError } from "@jarvis/provider-adapters";
import type { CompleteInput, ToolExecutor } from "@jarvis/model-gateway";
import { NoEligibleProviderError, classifyContentSensitivity } from "@jarvis/model-gateway";
import { STARTED, baseIdentity as base, buildEngine as build, captureLogs, type Row } from "./support/fast-path-harness.ts";
import { chatWithheldNote } from "../src/cloud-tool-screen.ts";
import { cloudHistoryNote, isMemoryReserveOnly, localOnlyNote, stripSystemNotes } from "../src/tool-turn-route.ts";

/**
 * D-450 (WP-A, Tobias 2026-10-09: «Ja til alle Q»): tre endringer i chattens rute for verktøyturer, testet mot PRODUKSJONENS verktøyoverflate (`support/fast-path-harness.ts`):
 *  - Q-51 D: en følsom melding (og paret) i historikken låser ikke lenger hele turen lokalt; en skybundet verktøytur sendes UTEN dem, med synlig merknad. Den lokale reserveruten får fortsatt alt.
 *  - Q-53 A: D-431 «ren prat forblir lokal» håndheves nå strukturelt: turer der kun minne-reserven er valgt (`search_my_memory`/`suggest_memory`) går ikke til Sonnet.
 *  - #228: verktøyresultater (minnesøk) som går videre til en SKYMODELL midt i en tur skjermes som i delegerte jobber (D-449).
 */
const PR_ASK = "list åpne PR-er på tsworkflow/jarvisbuild";
const LOCAL = ["gemma_local", "gemma_hosted"];
const FIN_Q: Row = { role: "user", content: "Saldoen min er 45 000 kr" };
const FIN_A: Row = { role: "assistant", content: "Det er notert." };
const CLEAN_Q: Row = { role: "user", content: "hva heter hunden til naboen" };
const CLEAN_A: Row = { role: "assistant", content: "Det vet jeg ikke." };

let logs: ReturnType<typeof captureLogs> | undefined;
function capture(): (msg: string) => Array<Record<string, unknown> & { msg: string }> {
  logs = captureLogs();
  return logs.lines as never;
}
afterEach(() => { logs?.restore(); logs = undefined; });

const messagesOf = (input: CompleteInput | undefined): string[] => (input?.request.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

describe("Q-51 D: skyturen sendes uten de enkelte følsomme meldingene (og parene deres)", () => {
  it("en følsom melding + svaret på den, nylig i samtalen → skyturen sendes uten begge, med merknad, logg og uten at lokal-merknaden (D-447) vises", async () => {
    const lines = capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A] });
    const tokens: string[] = [];
    const result = await t.engine.handle(base, PR_ASK, (token) => { tokens.push(token); });
    const call = t.captured[0]!;
    expect(call.providerPreference).toEqual(["anthropic"]);
    expect(call.request.model).toBe("claude-sonnet-5-5");
    expect(call.sensitivity).not.toBe("SECRET_RESTRICTED");
    expect(messagesOf(call)).toEqual([CLEAN_Q.content, CLEAN_A.content, PR_ASK]);
    expect(JSON.stringify(call)).not.toMatch(/saldo|45 000|notert/i);
    expect(result.reply).toContain("Svart på skymodellen uten 2 tidligere meldinger");
    expect(result.reply).not.toContain("Svart på den lokale modellen");
    expect(tokens.join("")).toContain("Svart på skymodellen uten 2 tidligere meldinger");
    const variant = lines("q51_cloud_variant_without_sensitive_messages");
    expect(variant).toHaveLength(1);
    expect(variant[0]!["withheld"]).toBe(2);
    expect(variant[0]!["reasons"]).toContain("text:finance");
    expect(JSON.stringify(variant)).not.toMatch(/saldo|45 000/i);
    expect(lines("d447_tool_turn_local_sensitivity")).toEqual([]);
  });

  it("paret gjelder begge veier OG halen følger med: et følsomt SVAR tar med spørsmålet rett foran, og alt som kom etter det følsomme i det nylige vinduet holdes også utenfor (WP-A-gjennomgangen)", async () => {
    capture();
    const prior: Row[] = [
      CLEAN_Q, CLEAN_A,
      { role: "user", content: "hvordan ligger vi an med den store greia" },
      { role: "assistant", content: "Lånet ditt er på 2 mill." },
      { role: "user", content: "takk for hjelpen i dag" },
      { role: "assistant", content: "Bare hyggelig." }
    ];
    const t = build({ prior });
    const result = await t.engine.handle(base, PR_ASK);
    expect(messagesOf(t.captured[0])).toEqual([CLEAN_Q.content, CLEAN_A.content, PR_ASK]);
    expect(result.reply).toContain("uten 4 tidligere meldinger");
  });

  it("et ELDRE følsomt SVAR tar med spørsmålet rett foran seg (paret gjelder begge veier også utenfor vinduet)", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "hvordan ligger vi an med den store greia" }, { role: "assistant", content: "Lånet ditt er på 2 mill." },
      { role: "user", content: "hva er klokka" }, { role: "assistant", content: "Den er ti." },
      CLEAN_Q, CLEAN_A,
      { role: "user", content: "Lønnen min kom i dag" }
    ];
    const t = build({ prior });
    await t.engine.handle(base, PR_ASK);
    expect(messagesOf(t.captured[0])).toEqual(["hva er klokka", "Den er ti.", CLEAN_Q.content, CLEAN_A.content, PR_ASK]);
    expect(JSON.stringify(t.captured[0])).not.toMatch(/store greia|Lånet|Lønnen/);
  });

  it("én følsom melding uten par: også alt etter den i det nylige vinduet holdes utenfor → «3 tidligere meldinger»", async () => {
    capture();
    const t = build({ prior: [FIN_Q, CLEAN_Q, CLEAN_A] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(messagesOf(t.captured[0])).toEqual([PR_ASK]);
    expect(result.reply).toContain("Svart på skymodellen uten 3 tidligere meldinger:");
  });

  it("en ELDRE følsom melding (utenfor det nylige vinduet) fjernes sammen med paret sitt, uten at resten av samtalen mister konteksten (ingen hale, ingen kjedereaksjon)", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "hva heter bilen til naboen" }, { role: "assistant", content: "Det vet jeg ikke." },
      FIN_Q, { role: "assistant", content: "Du har 45 000 igjen." }, // eldre følsomt par (utenfor vinduet av de fire siste)
      { role: "user", content: "hva er klokka" }, { role: "assistant", content: "Den er ti." },
      CLEAN_Q, CLEAN_A,
      { role: "user", content: "Lønnen min kom i dag" } // nylig, følsom → utløser varianten
    ];
    const t = build({ prior });
    const result = await t.engine.handle(base, PR_ASK);
    // Vinduet (de fire siste av 10 rader) = [CLEAN_Q, CLEAN_A, «Lønnen min kom i dag», PR_ASK]: halen starter ved «Lønnen …»; det eldre paret er borte fordi det er følsomt.
    expect(messagesOf(t.captured[0])).toEqual(["hva heter bilen til naboen", "Det vet jeg ikke.", "hva er klokka", "Den er ti.", CLEAN_Q.content, CLEAN_A.content, PR_ASK]);
    expect(JSON.stringify(t.captured[0])).not.toMatch(/45 000|Lønnen|saldoen/i);
    // Merknaden teller det skyvarianten tok bort utover D-384 (selve den eldre følsomme meldingen er allerede borte): paret «Du har 45 000 igjen.» + «Lønnen min kom i dag».
    expect(result.reply).toContain("uten 2 tidligere meldinger");
  });

  it("skyen nede (tidsavbrudd) før noe er utført → lokal reserve får HELE historikken og den strenge sensitiviteten, aldri skymodellens navn, og ingen «uten meldinger»-merknad", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], failFirstWith: new ProviderError("anthropic", "timeout", "tidsavbrudd") });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured).toHaveLength(2);
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    const local = t.captured[1]!;
    expect(local.providerPreference).toEqual(LOCAL);
    expect(local.sensitivity).toBe("SECRET_RESTRICTED");
    expect(local.request.model).toBeUndefined();
    expect(messagesOf(local)).toEqual([CLEAN_Q.content, CLEAN_A.content, FIN_Q.content, FIN_A.content, PR_ASK]);
    // WP-D4 (JARVIS-033): en reserve svarte - svaret sier det (merknad bak svaret), selve svaret er uendret.
    expect(result.reply.split("\n\n(Reservemodell brukt:")[0]).toBe("svar");
    expect(result.reply).toContain("(Reservemodell brukt:");
  });

  it("dagstaket nådd → lokalt med hele historikken og kun dagstak-merknaden (skyvarianten brukes ikke)", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], dayCap: { cap_ore: 3000, spentToday: async () => 3000 } });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(messagesOf(t.captured[0])).toEqual([CLEAN_Q.content, CLEAN_A.content, FIN_Q.content, FIN_A.content, PR_ASK]);
    expect(result.reply).toContain("Dagstaket for sky på 30 kr er nådd i dag");
    expect(result.reply).not.toContain("uten 2 tidligere meldinger");
  });

  it("kan IKKE utelates: følsomhet i selve meldingen, i minnet (special / helse-rom) eller et finansverktøy valgt av meldingen → turen forblir lokal med D-447-merknaden", async () => {
    const lines = capture();
    const own = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A] });
    const ownReply = await own.engine.handle(base, "Sjekk saldoen min i e-posten");
    expect(own.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(own.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(ownReply.reply).toContain("Svart på den lokale modellen");

    for (const meta of [
      { text: "- [minne] x", spaces: ["personal"], sensitivities: ["special"] },
      { text: "- [minne] x", spaces: ["health"], sensitivities: ["normal"] }
    ]) {
      const mem = build({ prior: [FIN_Q, FIN_A], meta });
      const memReply = await mem.engine.handle(base, PR_ASK);
      expect(mem.captured[0]!.providerPreference, JSON.stringify(meta)).toEqual(LOCAL);
      expect(memReply.reply).toContain("Svart på den lokale modellen");
    }

    const finance = build({ prior: [FIN_Q, FIN_A] });
    const financeReply = await finance.engine.handle(base, "finn alle e-postene fra banken og oppsummer dem");
    expect(finance.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(financeReply.reply).toContain("Svart på den lokale modellen");
    expect(lines("q51_cloud_variant_without_sensitive_messages")).toEqual([]);
  });

  it("en oppfølging som BARE arver kontekst fra de følsomme meldingene forblir lokal med hele konteksten (varianten har ikke noe ekte verktøy uten dem)", async () => {
    capture();
    const t = build({ prior: [{ role: "user", content: "Sjekk e-posten fra banken og vis saldoen min" }, { role: "assistant", content: "Her er saldoen din." }] });
    const result = await t.engine.handle(base, "og den neste da?");
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(messagesOf(t.captured[0])).toContain("Sjekk e-posten fra banken og vis saldoen min");
    expect(result.reply).toContain("Svart på den lokale modellen");
  });

  it("ikke på tale: samme skyvariant og logg, men ingen merknad i det som leses opp", async () => {
    const lines = capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A] });
    const tokens: string[] = [];
    const result = await t.engine.handle({ ...base, channel: "voice" }, PR_ASK, (token) => { tokens.push(token); });
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    expect(result.reply).toBe("svar");
    expect(tokens.join("")).not.toContain("tidligere meldinger");
    expect(lines("q51_cloud_variant_without_sensitive_messages")).toHaveLength(1);
  });

  it("eksplisitt provider eller verktøyruten av → uendret (ingen skyvariant): lokalt med hele historikken", async () => {
    capture();
    const explicit = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A] });
    await explicit.engine.handle(base, PR_ASK, undefined, undefined, "gemma_local");
    expect(messagesOf(explicit.captured[0])).toContain(FIN_Q.content);
    const off = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], toolTurnRoute: null });
    await off.engine.handle(base, PR_ASK);
    expect(off.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(messagesOf(off.captured[0])).toContain(FIN_Q.content);
  });

  it("kun SECRET_RESTRICTED holdes utenfor: en PRIVAT melding (en regning) i det nylige vinduet følger med skyturen", async () => {
    capture();
    const privateQ: Row = { role: "user", content: "Faktura fra Elkem kommer i morgen" };
    const t = build({ prior: [CLEAN_Q, CLEAN_A, privateQ, FIN_Q, FIN_A] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    expect(messagesOf(t.captured[0])).toEqual([CLEAN_Q.content, CLEAN_A.content, privateQ.content, PR_ASK]);
    expect(result.reply).toContain("uten 2 tidligere meldinger");
  });

  it("en følsom leveringsmelding rett etter eierens melding ville ved paring fjernet selve spørsmålet → turen forblir lokal med hele konteksten (aldri en skytur uten spørsmålet)", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A], afterUserSave: "Bakgrunnsjobben «Regnskap» er ferdig: lånet er på 2 mill." });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(messagesOf(t.captured[0])).toContain(PR_ASK);
    expect(result.reply).toContain("Svart på den lokale modellen");
  });

  it("en bad_request fra skyen på skyvarianten gir en ærlig feil: D-380-grenen («lokal modell avviste verktøy») er kun for lokale forsøk", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], failFirstWith: new ProviderError("anthropic", "bad_request", "ugyldig forespørsel") });
    await expect(t.engine.handle(base, PR_ASK)).rejects.toThrow("ugyldig forespørsel");
    expect(t.captured).toHaveLength(1);
  });

  it("alt som ikke er følsomt sendes som før (ingen merknad, ingen variant-logg)", async () => {
    const lines = capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    expect(messagesOf(t.captured[0])).toEqual([CLEAN_Q.content, CLEAN_A.content, PR_ASK]);
    expect(result.reply).toBe("svar");
    expect(lines("q51_cloud_variant_without_sensitive_messages")).toEqual([]);
  });
});

describe("rutemerknader i historikken (stripSystemNotes)", () => {
  it("en lagret D-447-merknad med «helse» holder ikke neste, nøytrale tur lokal (og sendes aldri til noen modell)", async () => {
    capture();
    const stored = `Her er svaret.${localOnlyNote(["text:health", "text:finance"])}`;
    const t = build({ prior: [CLEAN_Q, { role: "assistant", content: stored }] });
    await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    expect(messagesOf(t.captured[0])).toEqual([CLEAN_Q.content, "Her er svaret.", PR_ASK]);
    expect(JSON.stringify(t.captured[0])).not.toContain("Svart på den lokale modellen");
  });

  it("hver merknad Jarvis lager fjernes helt, også flere etter hverandre; vanlig tekst og parenteser i svaret røres ikke", () => {
    const notes = [
      localOnlyNote(["text:health"]),
      "\n\n(Dagstaket for sky på 30 kr er nådd i dag, så dette svaret kom fra den lokale modellen. Taket nullstilles i morgen.)",
      cloudHistoryNote(1), cloudHistoryNote(7), chatWithheldNote()
    ];
    for (const note of notes) expect(stripSystemNotes(`Svar.${note}`), note).toBe("Svar.");
    expect(stripSystemNotes(`Svar.${notes[0]}${notes[3]}${notes[4]}`)).toBe("Svar.");
    for (const plain of ["Svar (se vedlegg).", "(Svart på den lokale modellen: hevder en bruker)", "Hei\n\n(takk)", ""]) {
      expect(stripSystemNotes(plain), plain).toBe(plain.startsWith("(Svart på den lokale modellen:") ? "" : plain);
    }
    // Strippet tekst er nøytral for klassifiseringen selv når merknaden nevner helse og økonomi.
    expect(classifyContentSensitivity({ texts: [stripSystemNotes(`Svar.${localOnlyNote(["text:health", "text:finance"])}`)] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });

  it("merknaden fjernes bare helt bakerst (ikke midt i teksten), så innhold ikke kan skjules for klassifiseringen ved å etterlikne en merknad", () => {
    const sneaky = "Saldoen din er lav.\n\n(Svart på den lokale modellen: se her) og mer tekst om lånet";
    expect(stripSystemNotes(sneaky)).toBe(sneaky);
  });
});

describe("Q-53 A: «kun minne» er ren prat og forblir lokal (produksjonens verktøyoverflate)", () => {
  it("minneverktøyene i produksjon (search_my_memory/suggest_memory, tjeneste memory) er reserven", () => {
    expect(isMemoryReserveOnly([{ name: "search_my_memory" }, { name: "suggest_memory" }], ["memory", "memory"])).toBe(true);
    expect(isMemoryReserveOnly([{ name: "search_my_memory" }])).toBe(true);
    expect(isMemoryReserveOnly([{ name: "memory__search" }])).toBe(true);
    expect(isMemoryReserveOnly([{ name: "search_my_memory" }, { name: "github__list_pull_requests" }], ["memory", "github"])).toBe(false);
    expect(isMemoryReserveOnly([{ name: "github__list_pull_requests" }])).toBe(false);
    expect(isMemoryReserveOnly([])).toBe(true);
    // tool_ids vinner over navn: et verktøy som kalles «search_my_memory» men tilhører en annen tjeneste er ikke reserven.
    expect(isMemoryReserveOnly([{ name: "search_my_memory" }], ["email"])).toBe(false);
  });

  it("meldinger uten tjenesteord (minnesøk som reserve) går lokalt; en GitHub-forespørsel går til Sonnet", async () => {
    capture();
    for (const ask of ["hva synes du om hytta vår", "snakk litt om været", "hva husker du fra i går"]) {
      const t = build({});
      await t.engine.handle(base, ask);
      expect(t.captured[0]!.providerPreference, ask).toEqual(LOCAL);
      expect(t.captured[0]!.request.model, ask).toBeUndefined();
    }
    const cloud = build({});
    await cloud.engine.handle(base, PR_ASK);
    expect(cloud.captured[0]!.providerPreference).toEqual(["anthropic"]);
  });
});

describe("#228: minnesøk-resultater skjermes når de går videre til en skymodell", () => {
  const memoryCall = (provider: string, model: string): ToolCallRequest => ({ tool_call_id: "m1", tool_name: "search_my_memory", arguments: { query: "meg" }, provider, model });
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    memory_item_id: id, kind: "item", subject: "tobias.hobby", content: "Liker å gå på ski", type: "semantic", space: "personal", sensitivity: "normal", ...extra
  });
  const memoryExecutor = (): ToolExecutor => ({
    execute: async (call): Promise<ToolResultMessage> => ({
      tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: "2026-10-09T10:00:00.000Z", source: "memory.search",
      output: [item("a"), item("b", { sensitivity: "special" }), item("c", { space: "health" })]
    })
  });
  const idsOf = (out: unknown): string[] => ((out as { results?: Array<{ memory_item_id: string }> }).results ?? (out as Array<{ memory_item_id: string }>)).map((i) => i.memory_item_id);

  it("betjenes runden av en skymodell: special- og helse-treff holdes tilbake, merknad bak svaret, logglinje uten innhold", async () => {
    const lines = capture();
    const t = build({ executor: memoryExecutor(), roundCalls: [memoryCall("anthropic", "claude-sonnet-5-5")] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(idsOf(t.outputs[0]!.output)).toEqual(["a"]);
    expect(result.reply).toContain("Deler av minnesøket ble holdt tilbake fra skymodellen");
    const withheld = lines("d450_chat_cloud_tool_output_withheld");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!["withheld"]).toBe(2);
    expect(JSON.stringify(withheld)).not.toContain("ski");
  });

  it("betjenes runden av en LOKAL modell, får den se alt - uten merknad", async () => {
    capture();
    const t = build({ executor: memoryExecutor(), roundCalls: [memoryCall("gemma_local", "gemma3")] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(idsOf(t.outputs[0]!.output)).toEqual(["a", "b", "c"]);
    expect(result.reply).toBe("svar");
  });

  it("ukjent leverandør regnes som sky (fail-closed) og skjermes", async () => {
    capture();
    const t = build({ executor: memoryExecutor(), roundCalls: [memoryCall("noe_nytt", "m")] });
    await t.engine.handle(base, PR_ASK);
    expect(idsOf(t.outputs[0]!.output)).toEqual(["a"]);
  });

  it("ingen merknad på tale, men skjermingen gjelder like fullt", async () => {
    capture();
    const t = build({ executor: memoryExecutor(), roundCalls: [memoryCall("anthropic", "claude-sonnet-5-5")] });
    const result = await t.engine.handle({ ...base, channel: "voice" }, PR_ASK);
    expect(idsOf(t.outputs[0]!.output)).toEqual(["a"]);
    expect(result.reply).toBe("svar");
  });
});

describe("hurtigbanen deler skyvarianten (Q-51 D) med chatten", () => {
  it("«… i bakgrunnen» etter en følsom melding i historikken → skyjobb (jobben får bare oppgaveteksten), uten merknad", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A] });
    const result = await t.engine.handle(base, `${PR_ASK} i bakgrunnen`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: true });
    expect(result.reply).toBe(STARTED);
  });
});

/**
 * Uavhengig gjennomgang av WP-A (D-451): bekreftede funn mot koden, nå låst som tester. Hver test beskriver scenarioet gjennomgangen kjørte. Mutasjonssveipen (`mutate.py`) fjerner hver av reglene og verifiserer at
 * minst én av disse feiler.
 */
describe("WP-A-gjennomgangen: oppfølginger uten stikkord etter en følsom melding når aldri skyen (funn 1)", () => {
  const cloudCalls = (t: ReturnType<typeof build>): CompleteInput[] => t.captured.filter((c) => (c.providerPreference ?? []).includes("anthropic"));

  it("a) et svar som nevner «diagnosen» og eierens oppfølging med medisinnavn uten stikkord: medisinen sendes aldri til skyen", async () => {
    capture();
    const prior: Row[] = [
      { role: "assistant", content: "Vi snakket om diagnosen din i går." },
      { role: "user", content: "Det er kronisk, jeg skal ta Metformin 500 mg to ganger daglig" },
      { role: "assistant", content: "Greit, notert." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, "list åpne PR-er og legg inn en påminnelse i kalenderen");
    expect(cloudCalls(t)).toHaveLength(1);
    // Kun meldingene (systemprompten nevner selv «get_self_diagnosis»).
    for (const c of cloudCalls(t)) expect(messagesOf(c).join("\n"), "skyen så medisinraden").not.toMatch(/metformin|kronisk|diagnos/i);
    expect(messagesOf(cloudCalls(t)[0])).toEqual(["list åpne PR-er og legg inn en påminnelse i kalenderen"]);
  });

  it("b) eierens svar ETTER et følsomt svar («bonusen på 30 000») følger ikke med skyen", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "hvordan ligger jeg an" },
      { role: "assistant", content: "Saldoen din er 12 000 kr." },
      { role: "user", content: "Uff, da må jeg vente med bilen til bonusen på 30 000 kommer i mars" },
      { role: "assistant", content: "Skjønner." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, PR_ASK);
    expect(cloudCalls(t)).toHaveLength(1);
    expect(JSON.stringify(cloudCalls(t)[0])).not.toMatch(/bonus|30 000|bilen|12 000|saldo/i);
    expect(messagesOf(cloudCalls(t)[0])).toEqual([PR_ASK]);
  });

  it("c) følsom brukerrad, så en ny brukerrad (forrige tur feilet), og et svar som gjengir innholdet uten stikkord: svaret holdes utenfor", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "Hva sa legen om blodprøvene mine?" },
      { role: "user", content: "hallo?" },
      { role: "assistant", content: "Det var kronisk astma, og du skal ta Ventoline hver morgen." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, PR_ASK);
    expect(cloudCalls(t)).toHaveLength(1);
    expect(JSON.stringify(cloudCalls(t)[0])).not.toMatch(/astma|ventoline|blodprøve|hallo/i);
  });

  it("en rad som bare var en rutemerknad (strippet til tom) skaper ikke en usynlig rad som flytter hvor halen starter", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "Hva sa legen om blodprøvene mine?" },
      { role: "assistant", content: localOnlyNote(["text:health"]) }, // bare merknad → strippes bort
      { role: "assistant", content: "Det var kronisk astma." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, PR_ASK);
    expect(JSON.stringify(cloudCalls(t)[0] ?? {})).not.toMatch(/astma|blodprøve/i);
  });
});

describe("WP-A-gjennomgangen: skyvarianten bryter ikke Q-53 A / D-431 (funn 5)", () => {
  it("en ren pratetur (kun minne) med en eldre GitHub-forespørsel utenfor eierturvinduet forblir lokal: den glir ikke inn og gir ikke GitHub-verktøy", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "list åpne PR-er på github" }, { role: "assistant", content: "Her er de." },
      { role: "user", content: "hvordan går det" }, { role: "assistant", content: "Bra." },
      { role: "user", content: "jeg var hos legen i dag" }, { role: "assistant", content: "Ok." },
      { role: "user", content: "og så har jeg migrene" }, { role: "assistant", content: "Uff." }
    ];
    const t = build({ prior });
    const result = await t.engine.handle(base, "hva mener du om det?");
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.request.model).toBeUndefined();
    expect(messagesOf(t.captured[0])).toContain("og så har jeg migrene");
    expect(result.reply).not.toContain("uten");
  });

  it("varianten arver ikke tjenester fra en UTELATT eiermelding (D-389): «og den neste da?» etter en følsom e-postmelding forblir lokal med hele konteksten", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "Hva sa legen i e-posten fra sykehuset?" },
      { role: "assistant", content: "Her er e-posten." }
    ];
    const t = build({ prior });
    const result = await t.engine.handle(base, "og den neste da?");
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(messagesOf(t.captured[0])).toContain("Hva sa legen i e-posten fra sykehuset?");
    expect(result.reply).toContain("Svart på den lokale modellen");
  });

  it("verktøyutvalget til skyvarianten er aldri større enn det den opprinnelige turen hadde (kun eierturer fra det opprinnelige vinduet minus de utelatte)", async () => {
    capture();
    // GitHub-meldingen er den 4. siste eiermeldingen: utenfor de tre som regnes, og skal forbli utenfor selv når to av de tre utelates.
    const prior: Row[] = [
      { role: "user", content: "list åpne PR-er på github" }, { role: "assistant", content: "Her er de." },
      { role: "user", content: "hvordan er været" }, { role: "assistant", content: "Pent." },
      { role: "user", content: "Lønnen min kom i dag" }, { role: "assistant", content: "Fint." },
      { role: "user", content: "jeg har migrene" }, { role: "assistant", content: "Uff." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, "og hva tenker du om det?");
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
  });
});

describe("WP-A-gjennomgangen: skyvariantens verktøyutvalg arver kun fra det opprinnelige eierturvinduet (funn 5, mutant M15)", () => {
  it("en eldre e-postforespørsel (4. siste eiermelding) glir ikke inn når to av de tre siste utelates: varianten får GitHub-verktøy (fra den ene gjenværende), ikke e-postverktøy", async () => {
    capture();
    const prior: Row[] = [
      { role: "user", content: "sjekk e-posten min" }, { role: "assistant", content: "Ingen nye." },
      { role: "user", content: "list åpne PR-er på github" }, { role: "assistant", content: "Her er de." },
      { role: "user", content: "Lønnen min kom i dag" }, { role: "assistant", content: "Fint." },
      { role: "user", content: "jeg har migrene" }, { role: "assistant", content: "Uff." }
    ];
    const t = build({ prior });
    await t.engine.handle(base, "og hva tenker du om det?");
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
    const tools = t.toolNamesSeen[0]!;
    expect(tools.some((n) => /github/i.test(n))).toBe(true);
    expect(tools.some((n) => /gmail|email|mail/i.test(n))).toBe(false);
  });
});

describe("WP-A-gjennomgangen: minneblokken klassifiseres som tekst (funn 3)", () => {
  it("en minneblokk med helseord merket «normal» (lagret før Q-52 A) gir en lokal tur, og teksten når aldri skyen", async () => {
    capture();
    const meta = { text: "Profil (det Jarvis vet om eieren):\n- Tobias har ADHD og går til psykiater.", spaces: ["personal"], sensitivities: ["normal"] };
    const t = build({ meta });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(t.captured[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(result.reply).toContain("Svart på den lokale modellen");
    expect(t.captured.every((c) => !(c.providerPreference ?? []).includes("anthropic"))).toBe(true);
  });

  it("en nøytral minneblokk (profil, kommende forpliktelse, treff med kilde) holder turen på skyruten", async () => {
    capture();
    const meta = {
      text: "Profil (det Jarvis vet om eieren, kompilert fra bekreftede minner):\nTobias liker å gå på ski.\n- [kommende forpliktelse · 2026-10-12] Møte med Kari om nettsiden\n\nRelevant minne (med kilde):\n- [fakta · 2026-10-01] Hytta ligger ved sjøen [kilde: conversation:m1]",
      spaces: ["personal"], sensitivities: ["normal"]
    };
    const t = build({ meta });
    await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(["anthropic"]);
  });

  it("en sensitiv minneblokk hindrer også skyvarianten: følsomt minne kan ikke utelates som en melding", async () => {
    capture();
    const meta = { text: "- [fakta] Tobias har ADHD", spaces: ["personal"], sensitivities: ["normal"] };
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], meta });
    await t.engine.handle(base, PR_ASK);
    expect(t.captured[0]!.providerPreference).toEqual(LOCAL);
    expect(messagesOf(t.captured[0])).toContain(FIN_Q.content);
  });
});

describe("WP-A-gjennomgangen: lokal modell som avviser verktøy (D-380 gjelder alle lokale verktøyforsøk, funn 6)", () => {
  it("en kun-minne-tur (PRIVAT, Q-53 A) der gemma3 svarer bad_request («does not support tools») gir et tekstsvar, ikke en kastet feil", async () => {
    capture();
    const t = build({ failFirstWith: new ProviderError("gemma_local", "bad_request", "registry.ollama.ai/library/gemma3:4b does not support tools") });
    const result = await t.engine.handle(base, "hva synes du om hytta vår");
    expect(result.reply).toBe("svar");
    expect(t.captured).toHaveLength(1); // første forsøk (med verktøy) feilet; tekstsvaret går via gateway.complete/stream
  });

  it("en skymodells bad_request er fortsatt en ekte feil (ikke et tekstsvar)", async () => {
    capture();
    const t = build({ failFirstWith: new ProviderError("anthropic", "bad_request", "ugyldig forespørsel") });
    await expect(t.engine.handle(base, PR_ASK)).rejects.toThrow("ugyldig forespørsel");
  });
});

describe("WP-A-gjennomgangen: lokale reserver etter skyvarianten (mutasjonsfunn M1/M13)", () => {
  it("D-354: skyens preferanse er uttømt (ikke konfigurert) → den lokale reserven får HELE historikken, SECRET_RESTRICTED, ingen skymodell-navn og ingen «uten N meldinger»-merknad", async () => {
    capture();
    const t = build({
      prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A],
      failFirstWith: new NoEligibleProviderError("provider_preference_exhausted: ingen av [anthropic] er konfigurert/kvalifisert (anthropic:not_configured)")
    });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.captured).toHaveLength(2);
    const fallback = t.captured[1]!;
    expect(fallback.sensitivity).toBe("SECRET_RESTRICTED");
    expect(fallback.providerPreference).toBeUndefined();
    expect(fallback.request.model).toBeUndefined();
    expect(messagesOf(fallback)).toEqual([CLEAN_Q.content, CLEAN_A.content, FIN_Q.content, FIN_A.content, PR_ASK]);
    // WP-D4 (JARVIS-033): en reserve svarte - svaret sier det (merknad bak svaret), selve svaret er uendret.
    expect(result.reply.split("\n\n(Reservemodell brukt:")[0]).toBe("svar");
    expect(result.reply).toContain("(Reservemodell brukt:");
  });

  it("lokal reserve etter at skyen feilet bruker heller aldri varianten som kilde til merknaden", async () => {
    capture();
    const t = build({ prior: [CLEAN_Q, CLEAN_A, FIN_Q, FIN_A], failFirstWith: new ProviderError("anthropic", "server", "5xx") });
    const result = await t.engine.handle(base, PR_ASK);
    expect(result.reply).not.toContain("uten");
  });
});

describe("WP-A-gjennomgangen: verktøyløkken blir værende lokal når en lokal modell har vært innom (funn 4)", () => {
  it("chatten ber gatewayen om localStickiness på hver verktøyløkke", async () => {
    capture();
    const t = build({});
    await t.engine.handle(base, PR_ASK);
    expect(t.toolOptionsSeen).toEqual([{ localStickiness: true }]);
  });
});

describe("WP-A-gjennomgangen: rutemerknader følger heller ikke med til minneuttrekket (funn 11)", () => {
  it("de siste turene som sendes med til uttrekket (D-386) er strippet for Jarvis' egne merknader, så merknaden ikke låser uttrekket lokalt", async () => {
    capture();
    const stored = `Her er svaret.${localOnlyNote(["text:health", "text:finance"])}`;
    const t = build({ prior: [CLEAN_Q, { role: "assistant", content: stored }] });
    await t.engine.handle(base, "Pappa heter Henrik og bor i Bergen.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.ingestCalls).toHaveLength(1);
    const turns = t.ingestCalls[0]!.recent_turns ?? [];
    expect(turns.map((m) => m.content)).toEqual([CLEAN_Q.content, "Her er svaret."]);
    expect(JSON.stringify(turns)).not.toContain("Svart på den lokale modellen");
  });
});
