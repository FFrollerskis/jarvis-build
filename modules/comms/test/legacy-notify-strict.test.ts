import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordTransport, PolicyDeniedError, SlackTransport, TwilioTransport, WhatsAppTransport } from "@jarvis/tool-gateway";
import { guardLegacyNotifyTransport, optOutHash, type LegacyNotifyGuardDeps } from "../src/index.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-4, JARVIS-112 g5): STOP-vakten for de eldre `*.notify`-verktøyene ble omgått for Discord. `DiscordTransport` setter `channel_id` RÅTT inn i URL-en (`/channels/${id}/messages`), og vakten lot en mottaker den ikke kunne
 * normalisere gå videre: `channel_id = "123456789012345678/messages?"` ble SENDT mot den avmeldte kanalen. Nå avvises en Discord-mottaker som ikke er en ren snowflake (`^\\d{17,20}$`, nøyaktig slik den skal sendes) med `comms_policy_denied:recipient_invalid`
 * FØR noe forlater prosessen. Slack-kanalnavn (`#navn`, `@navn`) slippes fortsatt gjennom (eierens egne varsel-kanaler må fortsette å virke; en kanalpost er ikke per mottaker), og en Slack-ID (`C…`/`U…`/`D…`) som matcher en aktiv avmelding blokkeres.
 * Her mot de EKTE transportene (uten nettverk: `fetch` stubbes og URL/kropp fanges), så testen viser hva som faktisk ville gått ut.
 *
 * Fiks-runde 2 (FIX-4): regexen tillot LEDENDE NULL (`0` + avmeldt id ga en annen avmeldingsnøkkel enn den avmeldte og ble SENDT). En snowflake er et 64-bits heltall uten ledende null, så mønsteret er nå `^[1-9]\\d{16,19}$`.
 * Om Discord selv normaliserer ledende nuller i URL-en (og dermed ville levert til den avmeldte kanalen) er UVERIFISERT (ingen nettilgang i bygget); avvisningen er riktig uansett.
 */
const TENANT = "t-strict";
const CTX = { identity: { tenant_id: TENANT } } as never;
const DISCORD_ID = "1".repeat(18);
const OPTED = new Set([
  optOutHash(TENANT, "discord", DISCORD_ID), optOutHash(TENANT, "sms", "+4790000001"), optOutHash(TENANT, "slack", "C0123ABCDE"), optOutHash(TENANT, "slack", "U0123ABCDE")
]);
const deps: LegacyNotifyGuardDeps = { store: { isOptedOut: async (tenant, hash) => tenant === TENANT && OPTED.has(hash) } };
const seen: Array<{ url: string; body: string }> = [];
afterEach(() => { vi.unstubAllGlobals(); seen.length = 0; });
function stubFetch(): void {
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    seen.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ id: "m1", sid: "SM1", ok: true, ts: "1" }), { status: 200, headers: { "content-type": "application/json" } });
  });
}
type Outcome = { kind: "sent"; urls: string[] } | { kind: "denied"; code: string } | { kind: "error"; message: string };
async function send(tool: "discord" | "slack" | "twilio" | "whatsapp", params: Record<string, unknown>): Promise<Outcome> {
  const inner = tool === "discord" ? new DiscordTransport()
    : tool === "slack" ? new SlackTransport()
      : tool === "twilio" ? new TwilioTransport(async () => "ACxxxxxxxx", async () => "+4791000000") : new WhatsAppTransport(async () => "109876543210");
  const guarded = guardLegacyNotifyTransport(tool, inner, deps);
  try {
    await guarded.invoke("notify", { message: "hei", ...params } as never, "fake-credential", CTX);
    return { kind: "sent", urls: seen.map((s) => s.url) };
  } catch (err) {
    return err instanceof PolicyDeniedError ? { kind: "denied", code: err.message } : { kind: "error", message: (err as Error).message };
  }
}

describe("FIX-4: Discord - kun en ren snowflake slipper gjennom, og den sendes nøyaktig slik den ble sjekket", () => {
  it("crafted `channel_id` som transporten ellers ville tolket som en ANNEN sti (eller samme kanal) avvises som recipient_invalid, og ingenting sendes (var: SENDT mot den avmeldte kanalen)", async () => {
    stubFetch();
    const crafted = [
      `${DISCORD_ID}/messages?`, `${DISCORD_ID}/../${DISCORD_ID}`, `${DISCORD_ID}?x=`, `${DISCORD_ID}#x`, `${DISCORD_ID}/`, `/${DISCORD_ID}`, `../${DISCORD_ID}`, `${DISCORD_ID}%2f..%2f${DISCORD_ID}`,
      `${DISCORD_ID}\n`, ` ${DISCORD_ID} `, `${DISCORD_ID}\u200b`, "１".repeat(18), "1".repeat(16), "1".repeat(21), "0x" + "1".repeat(18), "", "   ", "abc", "@me", "channels",
      // FIX-4 (runde 2): ledende null (alle lengder 17-20, og bare nuller) avvises
      `0${DISCORD_ID}`, "0".repeat(18), `0${"1".repeat(16)}`, `0${"1".repeat(19)}`, `00${"1".repeat(17)}`
    ];
    for (const channel_id of crafted) {
      seen.length = 0;
      const out = await send("discord", { channel_id });
      expect(out, JSON.stringify(channel_id)).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_invalid" });
      expect(seen, `ingenting forlot prosessen for ${JSON.stringify(channel_id)}`).toEqual([]);
    }
  });

  it("LEDENDE NULL (FIX-4, runde 2): `0` + en avmeldt snowflake har en ANNEN avmeldingsnøkkel enn den avmeldte (vakten kunne ikke gjenkjenne den) og ble SENDT; nå avvises den som recipient_invalid, og ingenting sendes", async () => {
    stubFetch();
    const padded = `0${DISCORD_ID}`;
    expect(optOutHash(TENANT, "discord", padded), "forutsetningen: den utfylte formen har en annen nøkkel enn den avmeldte").not.toBe(optOutHash(TENANT, "discord", DISCORD_ID));
    expect(await send("discord", { channel_id: padded })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_invalid" });
    expect(seen, "ingenting forlot prosessen").toEqual([]);
    // den avmeldte selv er fortsatt blokkert som avmeldt (ikke som ugyldig)
    expect(await send("discord", { channel_id: DISCORD_ID })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_opted_out" });
  });

  it("alle første sifre 1-9 er gyldige snowflakes (sendes): stramningen avviser kun ledende null, ikke ekte id-er", async () => {
    stubFetch();
    for (const d of "123456789") {
      seen.length = 0;
      const id = `${d}${"7".repeat(17)}`;
      expect(await send("discord", { channel_id: id }), id).toEqual({ kind: "sent", urls: [`https://discord.com/api/v10/channels/${id}/messages`] });
    }
  });

  it("ikke-tekst (liste, tall, objekt, null, utelatt) avvises også som recipient_invalid (gatewayens schema stopper det først; vakten er siste ledd)", async () => {
    stubFetch();
    for (const channel_id of [[DISCORD_ID], Number(DISCORD_ID), { id: DISCORD_ID }, null, undefined, true]) {
      const out = await send("discord", { channel_id });
      expect(out, JSON.stringify(channel_id)).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_invalid" });
    }
    expect(seen).toEqual([]);
  });

  it("en ren snowflake som er AVMELDT blokkeres som recipient_opted_out; en ren snowflake som ikke er avmeldt sendes til nøyaktig /channels/<id>/messages", async () => {
    stubFetch();
    expect(await send("discord", { channel_id: DISCORD_ID })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_opted_out" });
    expect(seen).toEqual([]);
    const other = "2".repeat(19);
    expect(await send("discord", { channel_id: other })).toEqual({ kind: "sent", urls: [`https://discord.com/api/v10/channels/${other}/messages`] });
  });

  it("grensene: 17 og 20 siffer er gyldige snowflakes (sendes), 16 og 21 er ugyldige", async () => {
    stubFetch();
    expect((await send("discord", { channel_id: "3".repeat(17) })).kind).toBe("sent");
    expect((await send("discord", { channel_id: "3".repeat(20) })).kind).toBe("sent");
    expect(await send("discord", { channel_id: "3".repeat(16) })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_invalid" });
    expect(await send("discord", { channel_id: "3".repeat(21) })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_invalid" });
  });

  it("andre handlinger enn `notify` (lesing av kanalhistorikk) røres ikke av vakten", async () => {
    stubFetch();
    const guarded = guardLegacyNotifyTransport("discord", new DiscordTransport(), deps);
    await guarded.invoke("read_channel_history", { channel_id: DISCORD_ID, limit: 5 } as never, "fake-credential", CTX);
    expect(seen.map((s) => s.url)).toEqual([`https://discord.com/api/v10/channels/${DISCORD_ID}/messages?limit=5`]);
  });
});

describe("FIX-4: Slack - kanalnavn slippes gjennom (eierens egne varsel-kanaler), ID-er mot en aktiv avmelding blokkeres", () => {
  it("`#navn` og `@navn` kan ikke ha en avmeldingsrad (registeret er nøklet på ID) og slippes gjennom til transporten - DOKUMENTERT begrensning (runbook), ikke et skjult hull", async () => {
    stubFetch();
    for (const channel of ["#general", "#varsler", "@kari"]) {
      seen.length = 0;
      expect((await send("slack", { channel })).kind, channel).toBe("sent");
      expect(JSON.parse(seen[0]!.body), channel).toMatchObject({ channel });
    }
  });

  it("kanal-ID, bruker-ID (`U…`), små bokstaver og mellomrom rundt som matcher en aktiv avmelding blokkeres", async () => {
    stubFetch();
    for (const channel of ["C0123ABCDE", "c0123abcde", " C0123ABCDE ", "U0123ABCDE", "u0123abcde", " U0123ABCDE\n"]) {
      expect(await send("slack", { channel }), JSON.stringify(channel)).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_opted_out" });
    }
    expect(seen).toEqual([]);
  });

  it("en Slack-ID uten avmelding sendes som før", async () => {
    stubFetch();
    expect((await send("slack", { channel: "C0999ZZZZZ" })).kind).toBe("sent");
  });
});

describe("FIX-4: telefon (Twilio/WhatsApp) - uendret: kanonisk form og varianter av et avmeldt nummer blokkeres", () => {
  it("varianter av det avmeldte nummeret (kanonisk, mellomrom, 00-prefiks, bare siffer) blokkeres; transportene validerer E.164 selv for resten", async () => {
    stubFetch();
    for (const to of ["+4790000001", " +4790000001 ", "+47 900 00 001", "0047 900 00 001"]) {
      expect(await send("twilio", { to }), JSON.stringify(to)).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_opted_out" });
    }
    expect(await send("whatsapp", { to: "4790000001" })).toEqual({ kind: "denied", code: "comms_policy_denied:recipient_opted_out" });
    expect(seen).toEqual([]);
  });
});
