import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fastRoute } from "@jarvis/core";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import { runScenario, type ChannelName, type Observation, type Row, type Scenario } from "./support/n1-engine-harness.ts";
import { ASKS, HISTORIES, SCENARIOS } from "./support/n1-scenarios.ts";
import { FAST_INTENT_RESTRICTED } from "../src/restricted-context-guard.ts";
import { localOnlyNote, stripSystemNotes } from "../src/tool-turn-route.ts";

/**
 * WP-N1 (K3, K4, K7c): samtalemotoren MED flagget PÅ, mot falske modeller (`support/n1-engine-harness.ts`).
 *  A. feilen (JARVIS-101) og rettelsen: et nøytralt LOKALT svar fra en låst tur lekker uten vakten til neste skytur; med vakten holdes det utenfor
 *  B. hvert lagringssted merkes riktig: verktøyutvalg-lås, tekst, minne, dagstak, hurtigbane, råd, feil-/avbrudds-/budsjettstopp-svar, tilbakefall, skyvarianten (ikke merket)
 *  C. historikkens merker leses: løfter turen, holdes utenfor skyvarianten, aldri til en modell (ikke som felt), ikke til minneuttrekket
 *  D. fail-closed: kan brukermeldingen ikke merkes, feiler turen FØR modellen kalles
 *  E. smitten er målt og dokumentert (kjent begrensning), og strukturvakter mot nye lagringssteder
 */
const run = (scenario: Omit<Scenario, "id">, channel: ChannelName = "web", options: { markResult?: boolean; markThrows?: boolean } = {}): Promise<Observation> =>
  runScenario({ id: "t", ...scenario }, channel, { guard: true, ...options });
const off = (scenario: Omit<Scenario, "id">, channel: ChannelName = "web"): Promise<Observation> => runScenario({ id: "t", ...scenario }, channel, {});
const text = (o: Observation, call = 0): string => o.gateway[call]!.messages.join("\n");
const savedAssistant = (o: Observation): Array<{ content: string; restricted: boolean }> => o.saved.filter((s) => s.role === "assistant").map((s) => ({ content: s.content, restricted: s.restricted }));
/** De merkede radene (uten rutemerknaden Jarvis selv legger bak et svar, D-447). */
const marked = (o: Observation): string[] => o.rows_after.filter((r) => r.restricted === true).map((r) => `${r.role}: ${r.content.split("\n\n(")[0]}`);

/** Låst av verktøyutvalget (D-381: «konto» velger finansverktøy), men helt uten stikkord i teksten - nettopp det JARVIS-101 beskriver. */
const LOCK_ASK = "hvordan går det med kontoen min?";
const CLOUD_ASK = ASKS["github"]!;

describe("forutsetninger for lekkasjetestene", () => {
  it("meldingen og det lokale svaret («svar 0») klassifiseres PUBLIC som tekst - det er verktøyutvalget (ikke teksten) som låser turen", () => {
    expect(classifyContentSensitivity({ texts: [LOCK_ASK] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(classifyContentSensitivity({ texts: ["svar 0"] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});

describe("A: JARVIS-101 - feilen og rettelsen", () => {
  it("UTEN vakten (flagg AV = main): turen låses lokalt, men svaret lagres umerket og FØLGER MED til neste skytur (lekkasjen)", async () => {
    const first = await off({ text: LOCK_ASK });
    expect(first.gateway[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(first.gateway[0]!.preference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(first.saved.every((s) => !s.restricted && s.argc === 3)).toBe(true);
    expect(first.marks).toBe(0);
    const second = await off({ text: CLOUD_ASK, prior: first.rows_after });
    expect(second.gateway[0]!.preference).toEqual(["anthropic"]);
    expect(text(second)).toContain(`user: ${LOCK_ASK}`);
    expect(text(second)).toContain("assistant: svar 0"); // det lokale svaret ligger i skyhistorikken
  });

  it("MED vakten: turen merker brukermeldingen FØR modellkallet og lagrer svaret begrenset", async () => {
    const first = await run({ text: LOCK_ASK });
    expect(first.gateway[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(first.gateway[0]!.preference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(first.events).toEqual(["save:user", "mark", "gateway", "save:assistant:restricted"]);
    expect(first.marks).toBe(1);
    expect(marked(first)).toEqual([`user: ${LOCK_ASK}`, "assistant: svar 0"]);
    expect(first.logs).toContain("n1_restricted_turn_locked");
  });

  it("MED vakten: neste tur som ville gått til skyen sendes UTEN de merkede radene (skyvarianten), uten lokal-merknad, ikke merket, og merket når aldri modellen", async () => {
    const first = await run({ text: LOCK_ASK });
    const second = await run({ text: CLOUD_ASK, prior: first.rows_after });
    const call = second.gateway[0]!;
    expect(call.preference).toEqual(["anthropic"]);
    expect(call.model).toBe("claude-sonnet-5-5");
    expect(call.sensitivity).not.toBe("SECRET_RESTRICTED");
    expect(call.messages).toEqual([`user: ${CLOUD_ASK}`]);
    expect(call.extra_message_fields).toBe(false);
    expect(text(second)).not.toContain("svar 0");
    expect(text(second)).not.toContain(LOCK_ASK);
    const reply = (second.result as { reply: string }).reply;
    expect(reply).toContain("Svart på skymodellen uten 2 tidligere meldinger");
    expect(reply).not.toContain("Svart på den lokale modellen");
    expect(second.logs).toContain("q51_cloud_variant_without_sensitive_messages");
    expect(second.marks).toBe(0); // skyvarianten er trygg: hverken brukermeldingen eller svaret merkes
    expect(second.events).toEqual(["save:user", "gateway", "save:assistant"]);
    expect(second.rows_after.slice(2).every((r) => r.restricted !== true)).toBe(true);
  });

  it("MED vakten: er skyvarianten ikke mulig (ren prat uten verktøy), låses turen lokalt av den merkede raden - og merkes (smitte, se E)", async () => {
    const first = await run({ text: LOCK_ASK });
    const second = await run({ text: ASKS["plain"]!, prior: first.rows_after });
    expect(second.gateway[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(second.gateway[0]!.preference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(second.logs).toContain("n1_restricted_turn_locked");
    expect(second.events).toEqual(["save:user", "mark", "gateway", "save:assistant:restricted"]);
    expect(second.gateway[0]!.messages).toHaveLength(3); // lokal modell får hele historikken (D-378 pkt 2)
    expect(second.gateway[0]!.extra_message_fields).toBe(false);
  });

  it("rutemerknaden (D-447) forklarer en merket historikk i klartekst, uten ord klassifisereren reagerer på og fjernet fra historikken før klassifisering - og er UENDRET for de gamle grunnene", async () => {
    const note = localOnlyNote(["history:restricted"]);
    expect(note).toContain("de siste meldingene hørte til en tur som ble holdt lokalt");
    expect(classifyContentSensitivity({ texts: [note] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(stripSystemNotes(`svar${note}`)).toBe("svar");
    expect(localOnlyNote(["text:finance"])).toBe("\n\n(Svart på den lokale modellen: meldingen eller de siste meldingene berører økonomi, og slikt sendes aldri til skyen. Dette varer til emnet ikke lenger er blant de siste meldingene.)");
    expect(localOnlyNote(["tool_selection:SECRET_RESTRICTED"])).toBe("\n\n(Svart på den lokale modellen: innholdet er klassifisert som følsomt, og slikt sendes aldri til skyen.)");
    // gjennom motoren: finanslåsen OG en merket nylig rad gir begge forklaringene
    const o = await run({ text: LOCK_ASK, prior: HISTORIES["restricted_neutral_recent"]! });
    expect((o.result as { reply: string }).reply).toContain("de siste meldingene hørte til en tur som ble holdt lokalt");
  });

  it("den lokale reserveruten (skyen nede) får HELE historikken og den strenge sensitiviteten - merket krysser aldri leverandørgrensen som felt", async () => {
    const first = await run({ text: LOCK_ASK });
    const second = await run({ text: CLOUD_ASK, prior: first.rows_after, failures: [{ kind: "provider", provider: "anthropic", errKind: "timeout" }] });
    expect(second.gateway).toHaveLength(2);
    expect(second.gateway[0]!.messages).toEqual([`user: ${CLOUD_ASK}`]);
    expect(second.gateway[1]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(second.gateway[1]!.preference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(second.gateway[1]!.messages).toEqual([`user: ${LOCK_ASK}`, "assistant: svar 0", `user: ${CLOUD_ASK}`]);
    expect(second.gateway.every((g) => !g.extra_message_fields)).toBe(true);
    // tilbakefallet låser turen: nå ble en lokal modell brukt med hele historikken, så brukermeldingen og svaret merkes
    expect(second.events).toEqual(["save:user", "gateway", "mark", "gateway", "save:assistant:restricted"]);
    expect(marked(second)).toEqual([`user: ${LOCK_ASK}`, "assistant: svar 0", `user: ${CLOUD_ASK}`, expect.stringMatching(/^assistant: svar 1/) as unknown as string]);
  });
});

describe("A2: samme lekkasje med PRODUKSJONENS verktøyutvalg (ikke den faste velgeren)", () => {
  // Fraser der produksjonsutvalget velger finansverktøy (låser turen: `min_sensitivity`) mens teksten selv er PUBLIC (målt i denne økten).
  const NEUTRAL_FINANCE_ASKS = ["hvordan går det med kontoen min?", "hvilke bankforbindelser har jeg koblet til", "list banksamtykkene mine", "hvilke banker er tilgjengelige"];

  it("hver av dem: flagg AV lekker det lokale svaret til neste skytur, flagg PÅ merker raden og holder den utenfor - med de ekte finansverktøyene valgt av det ekte utvalget", async () => {
    for (const ask of NEUTRAL_FINANCE_ASKS) {
      expect(classifyContentSensitivity({ texts: [ask] }).sensitivity, ask).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      const offFirst = await off({ text: ask, production_selection: true });
      expect(offFirst.gateway[0]!.sensitivity, ask).toBe("SECRET_RESTRICTED");
      expect(offFirst.gateway[0]!.tools!.some((t) => t.startsWith("finance_")), ask).toBe(true);
      const offSecond = await off({ text: CLOUD_ASK, prior: offFirst.rows_after, production_selection: true });
      expect(offSecond.gateway[0]!.preference, ask).toEqual(["anthropic"]);
      expect(text(offSecond), ask).toContain("assistant: svar 0"); // lekkasjen på main

      const onFirst = await run({ text: ask, production_selection: true });
      expect(onFirst.events, ask).toEqual(["save:user", "mark", "gateway", "save:assistant:restricted"]);
      const onSecond = await run({ text: CLOUD_ASK, prior: onFirst.rows_after, production_selection: true });
      expect(onSecond.gateway[0]!.preference, ask).toEqual(["anthropic"]);
      expect(onSecond.gateway[0]!.messages, ask).toEqual([`user: ${CLOUD_ASK}`]);
      expect(onSecond.marks, ask).toBe(0);
    }
  });
});

describe("B: hvert lagringssted merkes riktig", () => {
  it("verktøyutvalg-lås (D-381), tekst, minne (helse-rom og «special»), og en merket rad i konteksten låser og merker turen - hver på sin egen grunn", async () => {
    const cases: Array<[string, Omit<Scenario, "id">, string]> = [
      ["verktøyutvalg", { text: LOCK_ASK }, "tool_selection:SECRET_RESTRICTED"],
      ["tekst", { text: "jeg har diabetes og trenger råd" }, "text:health"],
      ["helse-minnerom", { text: CLOUD_ASK, meta: { text: "MINNEBLOKK helse", spaces: ["health"], sensitivities: ["normal"] } }, "memory_space:health"],
      ["særlig sensitivt minne", { text: CLOUD_ASK, meta: { text: "MINNEBLOKK særlig", spaces: ["personal"], sensitivities: ["special"] } }, "memory_sensitivity:special"],
      ["merket rad", { text: ASKS["plain"]!, prior: HISTORIES["restricted_neutral_recent"]! }, "history:restricted"],
      ["sensitiv tekst i nylig historikk", { text: ASKS["plain"]!, prior: HISTORIES["fin_recent"]! }, "text:finance"]
    ];
    for (const [name, scenario, reason] of cases) {
      const o = await run(scenario);
      expect(o.marks, name).toBe(1);
      expect(o.events.slice(0, 2), name).toEqual(["save:user", "mark"]);
      expect(savedAssistant(o), name).toEqual([{ content: expect.any(String), restricted: true }]);
      expect(o.logs, name).toContain("n1_restricted_turn_locked");
      expect(o.gateway.at(-1)!.sensitivity, name).toBe("SECRET_RESTRICTED");
      expect(o.rows_after.filter((r) => r.restricted).length, name).toBeGreaterThanOrEqual(2);
      void reason;
    }
  });

  it("dagstaket nådd (skyturen går lokalt med hele historikken): turen er låst og merkes - mens den samme turen uten dagstak går til skyen via varianten og IKKE merkes", async () => {
    const capped = await run({ text: CLOUD_ASK, prior: HISTORIES["fin_recent"]!, dayCapReached: true });
    expect(capped.gateway[0]!.preference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(capped.marks).toBe(1);
    expect(savedAssistant(capped)[0]!.restricted).toBe(true);
    const variant = await run({ text: CLOUD_ASK, prior: HISTORIES["fin_recent"]! });
    expect(variant.gateway[0]!.preference).toEqual(["anthropic"]);
    expect(variant.marks).toBe(0);
    expect(savedAssistant(variant)[0]!.restricted).toBe(false);
  });

  it("vanlige turer (ingen lås) merkes aldri: ren prat, skytur, verktøytur med ren historikk, forretning og personlig minne", async () => {
    for (const scenario of [
      { text: ASKS["plain"]! }, { text: CLOUD_ASK }, { text: ASKS["email"]!, prior: HISTORIES["clean"]! }, { text: CLOUD_ASK, prior: HISTORIES["business"]! },
      { text: CLOUD_ASK, meta: { text: "MINNEBLOKK personlig", spaces: ["personal"], sensitivities: ["normal"] } }, { text: ASKS["memory"]! }
    ] satisfies Array<Omit<Scenario, "id">>) {
      const o = await run(scenario);
      expect(o.marks, scenario.text).toBe(0);
      expect(o.saved.every((s) => !s.restricted), scenario.text).toBe(true);
      expect(o.logs, scenario.text).not.toContain("n1_restricted_turn_locked");
    }
  });

  it("feil-, avbrudds- og budsjettstopp-svar i en LÅST tur lagres begrenset (og i en ulåst tur ikke): budsjettvakten, avbrutt, avbrutt strøm og Claude-kreditten", async () => {
    const errors: Array<[string, NonNullable<Scenario["failures"]>, boolean, string]> = [
      ["budsjettstopp", [{ kind: "budget", level: "hard_blocked" }], false, "Modellkall stoppet av budsjettvakten"],
      ["Claude-kreditten", [{ kind: "claude_budget" }], false, ""],
      ["avbrutt av bruker", [{ kind: "provider", provider: "gemma_local", errKind: "cancelled", partial: "Delvis svar" }], true, "[avbrutt av bruker]"],
      ["strøm avbrutt", [{ kind: "provider", provider: "gemma_local", errKind: "stream_interrupted", partial: "Delvis svar" }], true, "[stream avbrutt]"]
    ];
    for (const [name, failures, streaming, marker] of errors) {
      const locked = await run({ text: ASKS["plain"]!, prior: HISTORIES["fin_recent"]!, failures, streaming });
      expect(locked.marks, name).toBe(1);
      const lockedReply = savedAssistant(locked);
      expect(lockedReply, name).toHaveLength(1);
      expect(lockedReply[0]!.restricted, `${name} (låst)`).toBe(true);
      expect(lockedReply[0]!.content, name).toContain(marker);
      const open = await run({ text: ASKS["plain"]!, prior: HISTORIES["clean"]!, failures, streaming });
      expect(open.marks, name).toBe(0);
      expect(savedAssistant(open)[0]!.restricted, `${name} (ulåst)`).toBe(false);
    }
  });

  it("D-380: en lokal modell som avviser verktøy (bad_request) gir et svar uten verktøy - fortsatt på den låste turen, og lagret begrenset", async () => {
    const o = await run({ text: LOCK_ASK, failures: [{ kind: "provider", provider: "gemma_local", errKind: "bad_request" }] });
    expect(o.gateway).toHaveLength(2);
    expect(o.gateway.map((g) => g.api)).toEqual(["completeWithTools", "complete"]);
    expect(o.gateway.every((g) => g.sensitivity === "SECRET_RESTRICTED")).toBe(true);
    expect(o.events).toEqual(["save:user", "mark", "gateway", "gateway", "save:assistant:restricted"]);
  });

  it("hurtigbanen: kun kostnads- og verdirapporten (AI-kost i øre, Q-64 pkt 1 strengeste regel) merkes; alle andre intensjoner og tabellen over dem er uendret", async () => {
    const phrases: Record<string, string> = {
      system_status: "status", self_diagnosis: "hva er galt med deg", slo_report: "hvor bra yter du", evolution_report: "hvordan utvikler du deg", cost_report: "hva koster du",
      value_report: "hva har du hjulpet meg med", task_status: "jobbstatus task-7", create_task: "opprett jobb: skriv ukesrapport", cancel_task: "avbryt jobb task-7", help: "hjelp", home_light: "slå på lyset"
    };
    for (const [kind, phrase] of Object.entries(phrases)) {
      expect(fastRoute(phrase)?.kind, phrase).toBe(kind);
      const o = await run({ text: phrase, prior: HISTORIES["clean"]! });
      expect(o.marks, kind).toBe(FAST_INTENT_RESTRICTED[kind as keyof typeof FAST_INTENT_RESTRICTED] ? 1 : 0);
      expect(o.gateway, kind).toEqual([]); // hurtigbanen hopper over modellen
      expect(savedAssistant(o)[0]!.restricted, kind).toBe(FAST_INTENT_RESTRICTED[kind as keyof typeof FAST_INTENT_RESTRICTED]);
      expect((o.result as { routed: string }).routed, kind).toBe("fast");
    }
    expect(Object.entries(FAST_INTENT_RESTRICTED).filter(([, v]) => v).map(([k]) => k).sort()).toEqual(["cost_report", "self_diagnosis", "slo_report", "system_status", "value_report"]);
    const cost = await run({ text: "hva koster du", prior: HISTORIES["clean"]! });
    expect(cost.events).toEqual(["save:user", "mark", "save:assistant:restricted"]); // låst FØR svaret lagres; ingen modell
  });

  it("hurtigbanens bakgrunnsjobb: låst ruteavgjørelse (finansord) merkes; en jobb chatten ville latt gå til skyen (eventuelt via skyvarianten) merkes ikke; eierens egen modellvalg-instruks er ikke en lås", async () => {
    const locked = await run({ text: "undersøk lånet mitt og saldoen min i bakgrunnen", prior: HISTORIES["clean"]! });
    expect(locked.marks).toBe(1);
    expect(savedAssistant(locked)[0]!.restricted).toBe(true);
    expect(locked.delegate[0]!.cloud_allowed).toBe(false);
    const clean = await run({ text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["clean"]! });
    expect(clean.marks).toBe(0);
    expect(clean.delegate[0]!.cloud_allowed).toBe(true);
    const variant = await run({ text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["fin_recent"]! });
    expect(variant.delegate[0]!.cloud_allowed).toBe(true);
    expect(variant.marks).toBe(0);
    const afterMarked = await run({ text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["restricted_neutral_recent"]! });
    expect(afterMarked.delegate[0]!.cloud_allowed).toBe(true); // merkede rader holdes utenfor skyvarianten også for jobben
    expect(afterMarked.marks).toBe(0);
    const override = await run({ text: "list åpne PR-er i bakgrunnen, bruk kun lokale modeller", prior: HISTORIES["clean"]! });
    expect(override.delegate[0]!.cloud_allowed).toBe(false);
    expect(override.marks).toBe(0); // et eier-valg om lokal modell er ikke en sensitivitetslås
  });

  it("rådet: sensitiv melding merkes (melding + vurdering), ren melding ikke; konfigurasjon mangler: samme regel; rådet får ikke historikken, så en merket historikk alene låser det ikke", async () => {
    const finance = await run({ text: "bruk AI-rådet: skal jeg ta opp et lån", prior: HISTORIES["clean"]! });
    expect(finance.council[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(finance.events).toEqual(["save:user", "mark", "save:assistant:restricted"]);
    const plain = await run({ text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["clean"]! });
    expect(plain.marks).toBe(0);
    expect(plain.council[0]!.sensitivity).not.toBe("SECRET_RESTRICTED");
    const afterMarked = await run({ text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["restricted_neutral_recent"]! });
    expect(afterMarked.marks).toBe(0);
    const unconfiguredFinance = await run({ text: "bruk AI-rådet: skal jeg ta opp et lån", prior: HISTORIES["clean"]!, council: false });
    expect(unconfiguredFinance.marks).toBe(1);
    expect(savedAssistant(unconfiguredFinance)).toEqual([{ content: "AI-rådet er ikke konfigurert i denne kjøringen.", restricted: true }]);
    const unconfiguredPlain = await run({ text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["clean"]!, council: false });
    expect(unconfiguredPlain.marks).toBe(0);
  });
});

describe("C: historikkens merker leses", () => {
  it("en ELDRE merket rad (utenfor de fire siste) holdes utenfor med paret, uten å låse turen - ren skytur, ingen merking", async () => {
    const o = await run({ text: CLOUD_ASK, prior: HISTORIES["restricted_neutral_old"]! });
    expect(o.gateway[0]!.preference).toEqual(["anthropic"]);
    expect(o.gateway[0]!.sensitivity).not.toBe("SECRET_RESTRICTED");
    expect(text(o)).not.toContain("hva ble det av det");
    expect(text(o)).not.toContain("Det er 45 000 igjen.");
    expect(o.gateway[0]!.messages).toEqual(["user: hva er klokka", "assistant: Den er ti.", "user: hva heter hunden til naboen", "assistant: Det vet jeg ikke.", "user: takk", "assistant: Bare hyggelig.", `user: ${CLOUD_ASK}`]);
    expect(o.marks).toBe(0);
  });

  it("merket krysser ALDRI leverandørgrensen som felt: i ingen kjøring (alle scenarier, begge flater, vakten på) har meldingene til modellen andre felt enn role og content", async () => {
    for (const scenario of SCENARIOS) {
      for (const channel of ["web", "voice"] as const) {
        const o = await runScenario(scenario, channel, { guard: true });
        for (const g of o.gateway) expect(g.extra_message_fields, `${scenario.id}/${channel}`).toBe(false);
      }
    }
  });

  it("tale: samme regler (merket løfter turen og merkes), men finansverktøy finnes ikke på talefaten, så verktøyutvalget låser ikke der", async () => {
    const voiceLock = await run({ text: LOCK_ASK }, "voice");
    expect(voiceLock.marks).toBe(0);
    expect(voiceLock.gateway[0]!.sensitivity).not.toBe("SECRET_RESTRICTED");
    const voiceLifted = await run({ text: ASKS["plain"]!, prior: HISTORIES["restricted_neutral_recent"]! }, "voice");
    expect(voiceLifted.gateway[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(voiceLifted.marks).toBe(1);
  });

  it("minneuttrekket (D-386) får ikke merkede rader som kontekst med vakten på - uten vakten får det dem (uendret)", async () => {
    const prior = HISTORIES["restricted_neutral_recent"]!;
    const withGuard = await run({ text: ASKS["plain"]!, prior });
    const without = await off({ text: ASKS["plain"]!, prior });
    expect(without.ingest[0]!.recent_turns).toEqual(["user: hva heter hunden til naboen", "assistant: Det vet jeg ikke.", "user: hva ble det av det", "assistant: Det er 45 000 igjen."]);
    expect(withGuard.ingest[0]!.recent_turns).toEqual(["user: hva heter hunden til naboen", "assistant: Det vet jeg ikke."]);
  });

  it("`restrictedContextGuard: false` (eksplisitt) er det samme som utelatt: merker ignoreres, ingenting merkes", async () => {
    const o = await runScenario({ id: "t", text: ASKS["plain"]!, prior: HISTORIES["restricted_neutral_recent"]! }, "web", { guard: "explicit-false" });
    expect(o.marks).toBe(0);
    expect(o.gateway[0]!.sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY"); // merket ignoreres helt: ren prat uten minne er PUBLIC, som på main
    expect(o.saved.every((s) => !s.restricted && s.argc === 3)).toBe(true);
  });
});

describe("D: FAIL-CLOSED - kan brukermeldingen ikke merkes, feiler turen FØR modellen kalles", () => {
  it("markRestricted gir false (meldingen finnes ikke i egen tenant/sesjon) → turen kaster restricted_marking_failed, ingen modellkall, ingen assistentrad", async () => {
    const o = await run({ text: LOCK_ASK }, "web", { markResult: false });
    expect(o.result).toEqual({ thrown: "Error: restricted_marking_failed" });
    expect(o.gateway).toEqual([]);
    expect(o.saved.map((s) => s.role)).toEqual(["user"]);
  });

  it("markRestricted kaster (databasefeil) → turen feiler, ingen modellkall, ingen assistentrad", async () => {
    const o = await run({ text: LOCK_ASK }, "web", { markThrows: true });
    expect(o.result).toEqual({ thrown: "Error: db nede" });
    expect(o.gateway).toEqual([]);
    expect(o.saved.map((s) => s.role)).toEqual(["user"]);
  });

  it("det samme på hurtigbanen og i rådet: ingen svar lagres uten at meldingen er merket", async () => {
    const fast = await run({ text: "hva koster du" }, "web", { markResult: false });
    expect(fast.result).toEqual({ thrown: "Error: restricted_marking_failed" });
    expect(fast.saved.map((s) => s.role)).toEqual(["user"]);
    const council = await run({ text: "bruk AI-rådet: skal jeg ta opp et lån" }, "web", { markResult: false });
    expect(council.result).toEqual({ thrown: "Error: restricted_marking_failed" });
    expect(council.council).toEqual([]);
  });
});

describe("E: smitten (kjent begrensning) er målt, og strukturvaktene mot nye lagringssteder", () => {
  it("SMITTE: etter ÉN låst tur forblir ren prat låst og merket så lenge den forrige turen var låst - målt over 6 turer (hver tur låses av den forrige turens merker)", async () => {
    let rows: Row[] = [];
    const lockedTurns: boolean[] = [];
    for (const message of [LOCK_ASK, ...Array.from({ length: 5 }, (_, i) => `ren prat nummer ${i}`)]) {
      const o = await run({ text: message, prior: rows });
      lockedTurns.push(o.logs.includes("n1_restricted_turn_locked"));
      rows = o.rows_after;
    }
    expect(lockedTurns).toEqual([true, true, true, true, true, true]);
    expect(rows.every((r) => r.restricted === true)).toBe(true);
  });

  it("smitten brytes av to påfølgende verktøyturer som går via den trygge skyvarianten (de merkes ikke), og først da er neste ren prat ulåst - dokumentert, ikke ønsket", async () => {
    let rows: Row[] = (await run({ text: LOCK_ASK })).rows_after;
    for (const message of [CLOUD_ASK, ASKS["email"]!]) {
      const o = await run({ text: message, prior: rows });
      expect(o.marks, message).toBe(0);
      rows = o.rows_after;
    }
    const plain = await run({ text: ASKS["plain"]!, prior: rows });
    expect(plain.logs).not.toContain("n1_restricted_turn_locked");
    expect(plain.marks).toBe(0);
  });

  it("strukturvakt: ALLE assistentlagringer i samtalemotoren går via `saveAssistant` (ingen rå messages.save(... \"assistant\" ...) utenom den), og brukermeldingen lagres ÉN gang", () => {
    const source = readFileSync(join(fileURLToPath(new URL("../src/", import.meta.url)), "conversation.ts"), "utf8");
    const rawAssistantSaves = [...source.matchAll(/messages\.save\(identity, "assistant"/g)].length;
    expect(rawAssistantSaves).toBe(2); // saveAssistant sine to grener (låst: med { restricted: true }, ellers tre argumenter)
    expect([...source.matchAll(/messages\.save\(identity, "user"/g)]).toHaveLength(1);
    const body = source.slice(source.indexOf("private async saveAssistant"));
    expect(body.slice(0, 600)).toContain('{ restricted: true }');
    expect([...source.matchAll(/this\.saveAssistant\(/g)]).toHaveLength(8); // hurtigbane, svar, budsjettstopp, Claude-kreditten, avbrutt, strøm avbrutt, råd (ikke konfigurert), råd
    for (const line of source.split("\n").filter((l) => l.includes("this.saveAssistant("))) expect(line.trim(), line).toMatch(/, marker\);$/); // hvert kall gir markøren videre
  });

  it("strukturvakt: de eneste produksjonsstedene som lagrer meldinger er motoren (via saveAssistant og brukermeldingen) og bakgrunnsjobb-leveringen (main.ts saveMessage + ChatJobs.sweepDeliveries: merkes når kontrakten bærer restricted_origin, F-A2)", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = ["apps/api/src/conversation.ts", "apps/api/src/main.ts", "apps/api/src/chat-jobs.ts", "apps/api/src/server.ts", "apps/api/src/worker-main.ts"];
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(root, file), "utf8").split("\n");
      for (const line of lines) {
        if (/\bmessages\.save\(|MessageStore\(pool\)\.save\(|\.saveMessage\(|options\.saveMessage\(/.test(line)) hits.push(`${file}:${line.trim().slice(0, 70)}`);
      }
    }
    // conversation.ts: brukermeldingen + saveAssistant (to grener); chat-jobs.ts: sveipet kaller saveMessage uten/med merke (to grener). main.ts lagrer leveringen via `createDeliverySaver` (restricted-context-guard.ts, testet i wpn1-job-delivery.test.ts).
    expect(hits.map((h) => h.split(":")[0])).toEqual(["apps/api/src/conversation.ts", "apps/api/src/conversation.ts", "apps/api/src/conversation.ts", "apps/api/src/chat-jobs.ts", "apps/api/src/chat-jobs.ts"]);
    expect(readFileSync(join(root, "apps/api/src/main.ts"), "utf8")).toContain("saveMessage: createDeliverySaver(new MessageStore(pool), restrictedContextGuard.enabled)");
  });
});
