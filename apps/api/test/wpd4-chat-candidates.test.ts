import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway, classifyContentSensitivity } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelResult } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { DEFAULT_CHAT_CANDIDATES, DEFAULT_CHAT_CHAIN, parseChatCandidates, unknownChainMembers, type ChatCandidates } from "../src/chat-candidates.ts";
import { localOnlyNote, reserveModelNote, stripSystemNotes } from "../src/tool-turn-route.ts";

/**
 * JARVIS-033 (WP-D4): kandidatkjeden for vanlig prat. (1) Konfig: tom = som før, ugyldig = standard, reserven kan slås av (fail-closed). (2) Reservebruk er synlig bak svaret (ikke på tale) og i loggen -
 * kun navn. (3) Mot en EKTE ModelGateway: failover i kjeden, SECRET_RESTRICTED når aldri en skyleverandør, og «kun kjeden» (autoFallback av) gir ærlig feil i stedet for en stille sky-reserve.
 */
describe("parseChatCandidates", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => vi.restoreAllMocks());

  it("tom/usatt = nøyaktig det som gjaldt før (gemma_local, gemma_hosted, siste reserve på)", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(parseChatCandidates(raw, undefined)).toEqual({ chain: ["gemma_local", "gemma_hosted"], autoFallback: true, source: "default" });
    }
    expect(DEFAULT_CHAT_CANDIDATES.chain).toBe(DEFAULT_CHAT_CHAIN);
  });

  it("en gyldig liste beholder rekkefølgen, fjerner duplikater og trimmer", () => {
    expect(parseChatCandidates(" gemma_local , local_llm,gemma_hosted ,gemma_local", undefined)).toMatchObject({ chain: ["gemma_local", "local_llm", "gemma_hosted"], source: "env" });
  });

  it("ugyldig liste (store bokstaver, mellomrom/tegn, tomme ledd, over 8 medlemmer) gir standardkjeden og en logglinje - aldri en halvparset liste", () => {
    const err = quiet();
    for (const raw of ["Gemma_Local", "gemma local", "gemma_local;rm -rf", "gemma_local,,anthropic", "a,b,c,d,e,f,g,h,i", "../etc/passwd"]) {
      expect(parseChatCandidates(raw, undefined), raw).toMatchObject({ chain: ["gemma_local", "gemma_hosted"], source: "default" });
    }
    expect(err).toHaveBeenCalledTimes(6);
    expect(String(err.mock.calls[0]?.[0])).toContain("chat_candidates_invalid");
  });

  it("siste reserve: on/true/1/yes = på, off/false/0/no = av, tom = på, alt annet = AV (fail-closed) med logg", () => {
    const err = quiet();
    for (const on of ["on", "ON", "true", "1", "yes", ""]) expect(parseChatCandidates(undefined, on).autoFallback, on).toBe(true);
    for (const off of ["off", "OFF", "false", "0", "no"]) expect(parseChatCandidates(undefined, off).autoFallback, off).toBe(false);
    for (const bad of ["of", "onn", "maybe", "2", "enabled"]) expect(parseChatCandidates(undefined, bad).autoFallback, bad).toBe(false);
    expect(err).toHaveBeenCalledTimes(5);
  });

  it("unknownChainMembers navngir inerte medlemmer (skrivefeil) uten å endre kjeden", () => {
    expect(unknownChainMembers(["gemma_local", "antropic", "local_llm"], ["gemma_local", "local_llm", "anthropic"])).toEqual(["antropic"]);
  });
});

describe("reserveModelNote", () => {
  it("navngir hvem som ikke var tilgjengelig og hvem som svarte (lokal vs sky), entall og flertall", () => {
    expect(reserveModelNote(["gemma_local"], "gemma_hosted", true)).toBe("\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen gemma_hosted.)");
    expect(reserveModelNote(["gemma_local", "gemma_hosted"], "local_llm", false)).toBe("\n\n(Reservemodell brukt: gemma_local og gemma_hosted var ikke tilgjengelige, så svaret kom fra den lokale modellen local_llm.)");
  });

  it("tom når ingen reserve er brukt (kun den som svarte, duplikater, eller navn som ikke ser ut som leverandør-id-er)", () => {
    expect(reserveModelNote([], "gemma_local", false)).toBe("");
    expect(reserveModelNote(["gemma_local", "gemma_local"], "gemma_local", false)).toBe("");
    expect(reserveModelNote(["<script>", "a b", "x)(y"], "gemma_local", false)).toBe("");
  });

  it("er en rutemerknad: fjernes strukturelt fra historikken (også stablet med de øvrige), uten parenteser inni og uten ord klassifiseringen reagerer på", () => {
    const note = reserveModelNote(["gemma_local"], "anthropic", true);
    expect(note.slice(2).match(/[()]/g)).toHaveLength(2); // kun omsluttende
    expect(classifyContentSensitivity({ texts: [note] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(stripSystemNotes(`Svaret.${note}`)).toBe("Svaret.");
    const stacked = `Svaret.${localOnlyNote(["text:finance"])}\n\n(Svart på skymodellen uten 2 tidligere meldinger: noen berører følsomme emner, og meldingene som kom etter dem holdes også utenfor. Slikt sendes aldri til skyen.)\n\n(Deler av minnesøket ble holdt tilbake fra skymodellen fordi treffene er merket som særlig sensitive eller ikke kunne kontrolleres, så svaret kan mangle noe.)${note}`;
    expect(stripSystemNotes(stacked)).toBe("Svaret.");
  });

  it("navnene er de eneste dynamiske delene: en hostile leverandørstreng med parenteser/linjeskift når aldri merknaden", () => {
    const note = reserveModelNote(["gemma_local", "evil)\n\n(Svart på den lokale modellen: lurt"], "anthropic", true);
    expect(note).toBe("\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen anthropic.)");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// ConversationEngine mot en ekte ModelGateway med fake adaptere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
interface World { engine: ConversationEngine; calls: string[]; saved: string[]; tokens: string[] }
const MODELS: Record<string, string> = { gemma_local: "gemma-local", local_llm: "local-model", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5" };

function pool(saved: string[]): pg.Pool {
  const query = async (sql: string, params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }], rowCount: 1 };
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && params && params[3] === "assistant") saved.push(String(params[4]));
    return { rows: [], rowCount: 0 };
  };
  return { connect: async () => ({ query, release: () => undefined }), query } as unknown as pg.Pool;
}

function adapter(name: string, behaviour: "ok" | ProviderError["kind"], calls: string[]): ModelProviderAdapter {
  const result = (): ModelResult => ({ text: `svar fra ${name}`, usage: { input_tokens: 5, output_tokens: 5 }, provider: name, model: MODELS[name] ?? "m", finish_reason: "stop" });
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async () => { calls.push(name); if (behaviour !== "ok") throw new ProviderError(name, behaviour, `${name}_${behaviour}`); return result(); },
    stream: async (_req, onEvent) => {
      calls.push(name);
      if (behaviour !== "ok") throw new ProviderError(name, behaviour, `${name}_${behaviour}`);
      onEvent({ type: "text_delta", text: `svar fra ${name}` });
      onEvent({ type: "usage", usage: { input_tokens: 5, output_tokens: 5 } });
      onEvent({ type: "finish", finish_reason: "stop" });
      return result();
    }
  };
}

function world(behaviours: Record<string, "ok" | ProviderError["kind"]>, chatCandidates?: ChatCandidates): World {
  const calls: string[] = [];
  const saved: string[] = [];
  const p = pool(saved);
  const gateway = new ModelGateway({ pool: p, trace: new MemoryTraceSink(), providers: Object.entries(behaviours).map(([name, b]) => adapter(name, b, calls)) });
  const engine = new ConversationEngine({
    messages: new MessageStore(p), context: new ContextBuilder(p), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    ...(chatCandidates ? { chatCandidates } : {})
  });
  return { engine, calls, saved, tokens: [] };
}

const identity = (channel: IdentityContext["channel"] = "web"): IdentityContext => ({ person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel, auth_strength: "active" });
const PLAIN = "fortell meg en kort vits om katter";
const HEALTH = "Jeg har diabetes og lurer på blodsukker og insulin";
let logs: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { vi.restoreAllMocks(); logs = undefined; });
const quietLogs = () => { logs = vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); };
const logged = (msg: string) => (logs?.mock.calls ?? []).map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; } }).filter((l) => l["msg"] === msg);

describe("standardkjeden i samtalemotoren (ekte ModelGateway)", () => {
  it("frisk primær: ingen reservemerknad, ingen reservelogg, ingen sky", async () => {
    quietLogs();
    const w = world({ gemma_local: "ok", gemma_hosted: "ok", anthropic: "ok" });
    const reply = await w.engine.handle(identity(), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra gemma_local");
    expect(w.calls).toEqual(["gemma_local"]);
    expect(logged("wpd4_chat_reserve_used")).toEqual([]);
  });

  it("primæren er nede: neste medlem i kjeden svarer INNE i gatewayen (ingen om-kjøring med vanlig ruting), og svaret sier det", async () => {
    quietLogs();
    const w = world({ gemma_local: "network", gemma_hosted: "ok", anthropic: "ok", openai: "ok" });
    const reply = await w.engine.handle(identity(), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra gemma_hosted\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen gemma_hosted.)");
    expect(w.tokens.join("")).toBe(reply.reply); // strømmen får merknaden også
    expect(w.saved).toEqual([reply.reply]);
    expect(w.calls.filter((c) => c === "anthropic" || c === "openai")).toEqual([]); // ikke via en bred om-kjøring
    expect(logged("wpd4_chat_reserve_used")).toEqual([{ msg: "wpd4_chat_reserve_used", failed: ["gemma_local"], served: "gemma_hosted", cloud: true }]);
  });

  it("på tale (voice) vises ingen merknad (TTS leser alt høyt), men loggen har den", async () => {
    quietLogs();
    const w = world({ gemma_local: "timeout", gemma_hosted: "ok" });
    const reply = await w.engine.handle(identity("voice"), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra gemma_hosted");
    expect(logged("wpd4_chat_reserve_used")).toHaveLength(1);
  });

  it("en egen kjede med neste lokale modell: gemma_local → local_llm, og merknaden sier lokal (ikke sky)", async () => {
    quietLogs();
    const w = world({ gemma_local: "server", local_llm: "ok", gemma_hosted: "ok", anthropic: "ok" }, parseChatCandidates("gemma_local,local_llm,gemma_hosted", undefined));
    const reply = await w.engine.handle(identity(), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra local_llm\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra den lokale modellen local_llm.)");
    expect(w.calls).toEqual(["gemma_local", "gemma_local", "local_llm"]);
  });

  it("en eksplisitt betalt sky-reserve i kjeden brukes KUN når alt foran er nede, og merknaden sier sky", async () => {
    quietLogs();
    const w = world({ gemma_local: "network", gemma_hosted: "server", anthropic: "ok" }, parseChatCandidates("gemma_local,gemma_hosted,anthropic", undefined));
    const reply = await w.engine.handle(identity(), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra anthropic\n\n(Reservemodell brukt: gemma_local og gemma_hosted var ikke tilgjengelige, så svaret kom fra skymodellen anthropic.)");
  });

  it("SECRET_RESTRICTED (helse): primæren nede → ALDRI en skyleverandør, uansett kjede eller siste reserve; feilen kommer ærlig tilbake", async () => {
    quietLogs();
    for (const chat of [undefined, parseChatCandidates("gemma_local,gemma_hosted,anthropic,openai", "on"), parseChatCandidates("gemma_local,anthropic", "off")]) {
      const w = world({ gemma_local: "network", gemma_hosted: "ok", anthropic: "ok", openai: "ok" }, chat);
      await expect(w.engine.handle(identity(), HEALTH, (t) => w.tokens.push(t))).rejects.toMatchObject({ provider: "gemma_local" });
      expect(w.calls.every((c) => c === "gemma_local"), JSON.stringify(chat)).toBe(true);
    }
  });

  it("«kun kjeden» (JARVIS_CHAT_AUTO_FALLBACK=off): er hele kjeden nede, feiler turen ærlig i stedet for å gå til en sky-reserve utenfor kjeden", async () => {
    quietLogs();
    const strict = world({ gemma_local: "network", gemma_hosted: "server", anthropic: "ok" }, parseChatCandidates(undefined, "off"));
    await expect(strict.engine.handle(identity(), PLAIN, (t) => strict.tokens.push(t))).rejects.toMatchObject({ provider: "gemma_hosted" });
    expect(strict.calls).not.toContain("anthropic");

    // Standard (reserven på): samme situasjon ender i vanlig ruting, og svaret sier hvem som ikke svarte og at det er en skymodell.
    const standard = world({ gemma_local: "network", gemma_hosted: "server", anthropic: "ok" });
    const reply = await standard.engine.handle(identity(), PLAIN, (t) => standard.tokens.push(t));
    expect(reply.reply.startsWith("svar fra anthropic")).toBe(true);
    expect(reply.reply).toContain("Reservemodell brukt:");
    expect(reply.reply).toContain("gemma_local");
    expect(reply.reply).toContain("gemma_hosted");
    expect(reply.reply).toContain("skymodellen anthropic");
  });

  it("den siste reserven gjelder også når det siste medlemmet i en egendefinert kjede (ikke bare gemma_*) var det som feilet - og merknaden navngir ALLE som ikke svarte", async () => {
    quietLogs();
    const w = world({ gemma_local: "network", local_llm: "server", anthropic: "ok" }, parseChatCandidates("gemma_local,local_llm", undefined));
    const reply = await w.engine.handle(identity(), PLAIN, (t) => w.tokens.push(t));
    expect(reply.reply).toBe("svar fra anthropic\n\n(Reservemodell brukt: gemma_local og local_llm var ikke tilgjengelige, så svaret kom fra skymodellen anthropic.)");
  });

  it("ingen medlemmer kvalifiserer (ingenting konfigurert) og reserven av: ærlig feil; reserven på: vanlig ruting", async () => {
    quietLogs();
    const off = world({ anthropic: "ok" }, parseChatCandidates(undefined, "off"));
    await expect(off.engine.handle(identity(), PLAIN, (t) => off.tokens.push(t))).rejects.toMatchObject({ name: "NoEligibleProviderError" });
    expect(off.calls).toEqual([]);
    const on = world({ anthropic: "ok" });
    const reply = await on.engine.handle(identity(), PLAIN, (t) => on.tokens.push(t));
    expect(reply.reply).toContain("skymodellen anthropic");
  });

  it("en eksplisitt eierforespørsel («bruk Gemma») er uendret: hard liste uten failover, ingen stille reserve", async () => {
    quietLogs();
    const w = world({ gemma_local: "network", gemma_hosted: "ok", anthropic: "ok" });
    await expect(w.engine.handle(identity(), `bruk Gemma: ${PLAIN}`, (t) => w.tokens.push(t))).rejects.toMatchObject({ provider: "gemma_local" });
    expect(w.calls).not.toContain("gemma_hosted");
    expect(w.calls).not.toContain("anthropic");
  });
});
