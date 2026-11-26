import type { JsonValue } from "@jarvis/contracts";
import { PolicyDeniedError, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import { normalizeRecipient, optOutHash, type CommsChannel } from "./channels.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g5, Q-72 pkt 12): STOP-VAKT for de eldre `twilio`/`telnyx`/`whatsapp`/`slack`/`discord`-`notify`-verktøyene (`modules/tool-gateway/src/integrations.ts`, klasse C, vilkårlig mottaker).
 * De omgikk hele den felles utgående policyen: en mottaker som hadde sendt STOPP (eller som eieren hadde avmeldt) kunne fortsatt nås gjennom dem. Dette er den SMALLESTE endringen som lukker det: en transport-dekoratør som
 * slår opp tenant-bred avmelding for (kanal, mottaker) rett FØR `notify` utføres. INGEN nye tak, ingen journal, ingen formålsgrunnlag - de er fortsatt utenfor (JARVIS-112 g5 ber bare om STOP).
 *
 *  - Kun handlingen `notify` rører vakten; alle andre handlinger (get_*, list_*, read_*) går rett gjennom, uendret.
 *  - Uten noen avmeldingsrad er oppførselen identisk med før (ett ekstra lese-oppslag per `notify`). Med ALLE comms-flagg AV pakkes ingenting inn (`commsRuntime.guardLegacyNotifyTransport` returnerer transporten uendret).
 *  - En avmeldt mottaker gir `PolicyDeniedError("recipient_opted_out")` (melding `comms_policy_denied:recipient_opted_out`) FØR noe forlater prosessen. Feilen er et policy-avslag, ikke en leverandørfeil, og teller ikke mot
 *    connector-helse (g4). Et oppslag som feiler (databasen utilgjengelig) feiler LUKKET (`opt_out_check_unavailable`): vi sender aldri uten å ha sjekket.
 *  - FIX-4 (fiks-runde 1): DISCORD er strengt. `DiscordTransport` setter `channel_id` RÅTT inn i URL-en (`/channels/${id}/messages`), så en verdi vakten ikke kunne normalisere (`123456789012345678/messages?`) ble SENDT mot den avmeldte kanalen.
 *    En Discord-mottaker som ikke er NØYAKTIG en snowflake (`^[1-9]\d{16,19}$`, uten trim: det som sjekkes er det som sendes) avvises derfor med `comms_policy_denied:recipient_invalid` FØR noe forlater prosessen. Discord-id-er er alltid snowflakes.
 *    Fiks-runde 2 (FIX-4): ingen LEDENDE NULL. En snowflake er et 64-bits heltall (i desimal 17-20 siffer) og starter aldri med 0; `0` + en avmeldt id har en ANNEN avmeldingsnøkkel enn den avmeldte og ble tidligere SENDT. Om Discord selv fjerner ledende
 *    nuller i URL-en (og den utfylte formen dermed ville nådd den avmeldte kanalen) er UVERIFISERT (ingen nettilgang); avvisningen er riktig uansett.
 *  - Telefon (Twilio/Telnyx/WhatsApp): en mottaker vakten ikke kan normalisere (f.eks. et nummer uten landkode) kan ikke ha en avmeldingsrad (registeret nøkles på normalisert identifikator) og slippes videre til transporten, som validerer
 *    selv (`assertE164`, ingen normalisering). Dette er ikke et nytt hull: avmeldinger registreres alltid på normalisert form. Slack-ID-er (`C…`/`D…`/`G…`/`U…`/`W…`, også små bokstaver og mellomrom rundt) normaliseres og sjekkes.
 *  - UDEKKET OG DOKUMENTERT (runbook, DEFERRED): Slack-KANALNAVN (`#general`, `@kari`) kan ikke ha en avmeldingsrad (registeret er nøklet på ID) og slippes gjennom (eierens egne varsel-kanaler må fortsette å virke; en kanalpost er ikke per mottaker);
 *    worker-prosessen har egne transporter; og generiske automasjonsverktøy (n8n/make/zapier-MCP) er en sjette, udekket vei.
 *  - Tenant: identitetens tenant OG webhook-tenanten (`JARVIS_COMMS_TENANT_ID`), fordi en innkommende STOP skrives dit. Avmeldinger i en tredje tenant sees ikke (tenant-isolasjon), og eierens egne varsler er IKKE unntatt: har eieren
 *    selv sendt STOPP fra sitt eget nummer, er det også avmeldt (leverandøren ville uansett avvist sendingen). Eieren løfter den med en START fra samme nummer.
 *  - Dekker KUN api-prosessen (der comms-kjøretiden finnes); en worker-prosess har egne transporter og er IKKE dekket (se runbook §10, PARTIAL).
 */
export const LEGACY_NOTIFY_TARGETS: Readonly<Record<string, { readonly parameter: string; readonly channel: CommsChannel }>> = {
  twilio: { parameter: "to", channel: "sms" },
  telnyx: { parameter: "to", channel: "sms" },
  whatsapp: { parameter: "to", channel: "whatsapp" },
  slack: { parameter: "channel", channel: "slack" },
  discord: { parameter: "channel_id", channel: "discord" }
};

export interface LegacyNotifyGuardDeps {
  readonly store: { isOptedOut(tenantId: string, optOutHash: string): Promise<boolean> };
  /** Tenanter utover identitetens som også sjekkes (webhook-tenanten). Tom/udefinert = kun identitetens tenant. */
  readonly extraTenants?: () => readonly string[];
  readonly warn?: (event: Record<string, unknown>) => void;
}

/** Discord-id-er er alltid snowflakes (17-20 siffer, første siffer 1-9: aldri ledende null, FIX-4 runde 2). Matches mot den RÅ verdien, uten trim: transporten setter den uendret inn i URL-en (FIX-4). `\d` er kun ASCII-sifre og `$` matcher kun ved slutten (ikke før en avsluttende linjeskift). */
const DISCORD_SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** (kanal, normalisert mottaker) for en `notify`-handling, eller `null` når verktøyet ikke er et eldre `notify`-verktøy eller mottakeren ikke kan normaliseres. */
export function legacyNotifyTarget(toolId: string, parameters: Record<string, JsonValue>): { channel: CommsChannel; recipient: string } | null {
  const target = LEGACY_NOTIFY_TARGETS[toolId];
  if (target === undefined) return null;
  const normalized = normalizeRecipient(target.channel, parameters[target.parameter]);
  return normalized.ok ? { channel: target.channel, recipient: normalized.value } : null;
}

export function guardLegacyNotifyTransport(toolId: string, inner: ToolTransport, deps: LegacyNotifyGuardDeps): ToolTransport {
  if (LEGACY_NOTIFY_TARGETS[toolId] === undefined) return inner;
  return {
    async invoke(action: string, parameters: Record<string, JsonValue>, credential: string, context: ToolInvocationContext, signal?: AbortSignal) {
      if (action === "notify") await assertNotOptedOut(toolId, parameters, context, deps);
      return inner.invoke(action, parameters, credential, context, signal);
    }
  };
}

async function assertNotOptedOut(toolId: string, parameters: Record<string, JsonValue>, context: ToolInvocationContext, deps: LegacyNotifyGuardDeps): Promise<void> {
  // FIX-4: Discord sender verdien rått i URL-en, så alt annet enn en ren snowflake stoppes her (og sendes aldri); sjekken gjøres på NØYAKTIG den verdien transporten får.
  if (toolId === "discord") {
    const raw = parameters[LEGACY_NOTIFY_TARGETS["discord"]!.parameter];
    if (typeof raw !== "string" || !DISCORD_SNOWFLAKE.test(raw)) throw new PolicyDeniedError("comms_policy_denied:recipient_invalid");
  }
  const target = legacyNotifyTarget(toolId, parameters);
  if (target === null) return;
  const tenants = [...new Set([context.identity.tenant_id, ...(deps.extraTenants?.() ?? [])])];
  try {
    for (const tenantId of tenants) {
      if (await deps.store.isOptedOut(tenantId, optOutHash(tenantId, target.channel, target.recipient))) throw new PolicyDeniedError("comms_policy_denied:recipient_opted_out");
    }
  } catch (err) {
    if (err instanceof PolicyDeniedError) throw err;
    // Aldri send uten å ha sjekket. Kun en fast kode i loggen (ingen mottaker, ingen feiltekst).
    deps.warn?.({ msg: "comms_legacy_notify_optout_check_failed", tool: toolId });
    throw new PolicyDeniedError("comms_policy_denied:opt_out_check_unavailable");
  }
}
