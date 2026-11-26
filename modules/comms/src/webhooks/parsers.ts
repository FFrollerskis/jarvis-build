import { normalizeChannelIdentifier, normalizeE164 } from "@jarvis/conversation-graph";
import { sha256Hex, type CommsChannel } from "../channels.ts";

/**
 * WP-G1 (D-463, P1d): REN tolkning av en (allerede signaturverifisert) webhook-kropp til normaliserte hendelser. Alt som kommer inn er UBETRODD DATA: parserne leser kun kjente felt av forventet type, aldri en modellstyrt
 * struktur, og en hendelse som ikke lar seg tolke hoppes over (`ignored`), aldri en feil som stopper resten. Ingenting her utfører noe - tolkningen gir kun data som inntaket lagrer.
 *
 * UVERIFISERT (ærlig): feltnavnene for Slack Events API og Meta WhatsApp/Messenger/Instagram er Leverandørenes langvarig dokumenterte former, men ble ikke lest på primærkilden i denne økten (docs-vertene var ikke
 * nåbare). Telnyx' meldingsvarsel-form er kjent fra eksisterende kode og dokumentasjon, ikke bekreftet i denne økten. Parserne er derfor defensive og dekkes av tester mot falske nyttelaster; live-akseptanse mot en testkonto
 * er `BLOCKED_EXTERNAL` (credentials).
 */
export type InboundProvider = "slack" | "meta" | "twilio" | "telnyx";

export interface NormalizedInbound {
  readonly provider: InboundProvider;
  readonly channel: CommsChannel;
  /** VÅR side (konto-referansen hendelsen kom inn på) - må være en autorisert konto for at hendelsen lagres. */
  readonly account_ref: string;
  /** Leverandørens egen hendelses-id (pluss type der samme id kan komme med ulik status) - gjenspillingsvernet. */
  readonly event_key: string;
  readonly kind: "message" | "status";
  /** NORMALISERT avsender (E.164 / sammensatt `<konto>:<bruker>`) - brukes til identitetsoppslag. `null` for hendelser uten avsender. */
  readonly sender: string | null;
  /**
   * Mottaker-identifikatoren man ville brukt for å SVARE (nøyaktig formen `normalizeRecipient` gir: E.164, Slack-kanal/DM-id, side-/IGSID) - pseudonymiseres til samme hash som utgående mottaker, slik at
   * «mottakerens siste innkommende melding» (kundeservicevinduet) og avmelding treffer riktig. `null` for hendelser uten avsender.
   */
  readonly reply_to: string | null;
  readonly thread_ref: string | null;
  /** Rå tekst (UBETRODD) - inntaket renser, hemmelighetsskanner og begrenser den. */
  readonly text: string | null;
  readonly provider_ts: string | null;
}

export interface ParseOutcome {
  readonly events: readonly NormalizedInbound[];
  readonly ignored: number;
}

/**
 * K3 (JARVIS-112 d): høyeste antall hendelser en enkelt signert forespørsel BEHANDLES med (`CommsWebhookService`, ikke parseren - parserne returnerer ALLE hendelser og forkaster ingen på antall). Tallet er Metas DOKUMENTERTE
 * batch-størrelse: «batches of at most 1000 updates» (WhatsApp Business Platform, webhooks / create-webhook-endpoint). UVERIFISERT mot primærkilden i denne økten (`developers.facebook.com` var utenfor nettverkstillatelsen; kun
 * søkeutdrag - de samme utdragene oppgir inntil 3 MB per forespørsel og at batching ikke er garantert). Før var tallet 100 og resten ble DROPPET STILLE (en STOP som nr. 120 gikk tapt, HTTP 200). Over taket svarer tjenesten nå med en
 * feilstatus (leverandøren prøver på nytt), aldri 200 med droppede hendelser. Byte-grensen før signaturen er per leverandør (`WEBHOOK_MAX_BYTES_BY_PROVIDER`: Meta 4 MiB, de andre 256 KB; FIX-1, se runbook §5).
 */
export const MAX_EVENTS_PER_REQUEST = 1000;
/**
 * FIX-3 (fiks-runde 2): taket over teller kun hendelser som SKRIVES, så arbeidet per forespørsel var bare byte-begrenset (16 000 ignorerte hendelser, 2,7 MB, tok 6,9 s: ett kontooppslag per hendelse). `PROCESSING_CAP_FACTOR` x skrivetaket er det EGNE
 * taket på hendelser som BEHANDLES (ikke kjente duplikater) per signert forespørsel: 5 x 1000 = 5000, ca. 2-3 s på utviklingsdatabasen (UVERIFISERT på NAS). Over det svarer tjenesten 503 `batch_over_cap`, som for skrivetaket. Stopp-ord (STOP) er unntatt.
 */
export const PROCESSING_CAP_FACTOR = 5;
const SAFE_KEY = /^[A-Za-z0-9._:@=+/-]{1,300}$/;

/**
 * B-NY (delta-review B): dedupe-nøkkelen for en hendelse. En leverandørs meldings-id er IKKE garantert innenfor vårt trygge tegnsett (`~ % * $` og mellomrom) eller lengdegrensen på 300 - og en hendelse med slik id ble tidligere DROPPET
 * stille (`finish()` filtrerte på tegnsettet, og id-en ble avvist over 200 tegn). For en STOP er det rettighetsbærende: mottakerens avmelding forsvant uten spor. Nå brukes den rene nøkkelen når den er trygg (uendret for vanlige id-er),
 * ellers en stabil hash (`<prefiks>:sha256:<hex>`; samme id gir alltid samme nøkkel, så dedupe virker). Ingen hendelse forkastes på grunn av id-en.
 */
function eventKey(prefix: string, ...ids: readonly string[]): string {
  const direct = [prefix, ...ids].join(":");
  return !HASHED_KEY_PREFIXES.has(prefix) && SAFE_KEY.test(direct) ? direct : `${prefix}:sha256:${sha256Hex(ids.join("\n"))}`;
}

/**
 * FIX-8 (fiks-runde 1): ÉN mekanisme for hva som lagres som hendelsesnøkkel. WhatsApp-meldings-id-er (`wamid.HBgL<base64>...`) KAN (UVERIFISERT mot en ekte id; sannsynlig etter Metas id-format) kode AVSENDERENS TELEFONNUMMER i base64. Nøkkelen lagres i
 * `comms_inbound_events` (30/1825 d), `comms_inbound_receipts` (1825 d) og som peker i `comms_recipient_opt_outs.evidence_ref` - en rå wamid der ville gjort pseudonymiseringen av en STOP-avsender verdiløs. Derfor hashes WhatsApp-nøkler ALLTID
 * (`<prefiks>:sha256:<hex>`, samme form som en uvanlig/lang id fikk i K3: samme funksjon, samme format), aldri bare når id-en er uvanlig. SHA-256 uten pepper er VALGT BEVISST: id-en har en tilfeldig, meldingsspesifikk del (ca. 80 bit) som ikke kan gjettes, så hashen kan ikke
 * snus tilbake til nummeret, og STOP-mottak skal ALDRI avhenge av om en pepper er konfigurert (en pepper-avhengig nøkkel ville også brutt dedupe og 1825-dagers gjenspillingsvernet ved rotasjon). Hashen er deterministisk (dedupe virker) og lagres per tenant (nøkkelen er del av en tenant-nøklet primærnøkkel).
 * Andre leverandørers id-er (Slack `Ev...`, Twilio `SM...`, Telnyx-UUID) er ikke telefonnumre og beholdes rene når de er trygge, som før. UTGÅENDE `provider_message_id` (journalen) trengs for redigering/sletting og kan ikke hashes (se runbook).
 */
const HASHED_KEY_PREFIXES: ReadonlySet<string> = new Set(["wa:msg", "wa:status"]);

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max = 500): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
/**
 * K3: en leverandørs hendelses-/meldings-id godtas uansett lengde (aldri forkastet, aldri avkortet) - bare dedupe-NØKKELEN lagres (`eventKey`: ren når den er kort og trygg, ellers en SHA-256 av hele id-en). Før ble en meldings-id over 1000 tegn,
 * en Twilio-SID over 64 og en Slack `event_id` over 100 forkastet, og en STOP med slik id gikk tapt. Kroppen er uansett begrenset (før signaturen, per leverandør), så id-en kan ikke bli ubegrenset stor.
 */
const idStr = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d{1,16}(\.\d{1,6})?$/.test(value) ? Number(value) : null);

function isoFromSeconds(seconds: number | null): string | null {
  if (seconds === null || seconds < 946_684_800 || seconds > 4_102_444_800) return null; // 2000..2100
  return new Date(seconds * 1000).toISOString();
}

function normalized(channel: Parameters<typeof normalizeChannelIdentifier>[0], raw: string): string | null {
  try {
    return normalizeChannelIdentifier(channel, raw);
  } catch {
    return null;
  }
}

function finish(events: NormalizedInbound[], ignored: number): ParseOutcome {
  // Nøkkelen er trygg per konstruksjon (`eventKey` hasher alt uvanlig); filteret er kun et siste sikkerhetsnett. Antallet kuttes IKKE her (K3): taket håndheves av tjenesten, som prioriterer STOP først og svarer med feilstatus over taket.
  const kept = events.filter((e) => SAFE_KEY.test(e.event_key));
  return { events: kept, ignored: ignored + (events.length - kept.length) };
}

// ------------------------------------------------------------------------------------------------ Slack Events API
export type SlackParse = { readonly challenge: string } | (ParseOutcome & { readonly challenge?: undefined });

/** `url_verification` besvares med utfordringen (etter verifisert signatur); `event_callback` -> meldinger fra mennesker (aldri bot-meldinger, aldri redigeringer/slettinger). */
export function parseSlackBody(body: unknown): SlackParse {
  const b = obj(body);
  if (b === null) return { events: [], ignored: 1 };
  if (b["type"] === "url_verification") {
    const challenge = str(b["challenge"], 500);
    return challenge === null ? { events: [], ignored: 1 } : { challenge };
  }
  if (b["type"] !== "event_callback") return { events: [], ignored: 1 };
  const eventId = idStr(b["event_id"]);
  const teamId = str(b["team_id"], 30);
  const ev = obj(b["event"]);
  if (eventId === null || teamId === null || ev === null) return { events: [], ignored: 1 };
  const type = ev["type"];
  // Kun vanlige meldinger fra mennesker: `subtype` (message_changed, message_deleted, bot_message, ...) og `bot_id` hoppes over - egne meldinger (som boten selv har sendt) kommer aldri tilbake som «innkommende».
  if ((type !== "message" && type !== "app_mention") || ev["subtype"] !== undefined || ev["bot_id"] !== undefined) return { events: [], ignored: 1 };
  const user = str(ev["user"], 30);
  const channel = str(ev["channel"], 30);
  const ts = str(ev["ts"], 30);
  if (user === null || channel === null || ts === null) return { events: [], ignored: 1 };
  const sender = normalized("slack", `${teamId}:${user}`);
  if (sender === null) return { events: [], ignored: 1 };
  return finish([{
    provider: "slack", channel: "slack", account_ref: teamId, event_key: eventKey("slack", eventId), kind: "message", sender, reply_to: channel.toUpperCase(),
    thread_ref: str(ev["thread_ts"], 30) ?? ts, text: typeof ev["text"] === "string" ? (ev["text"] as string) : null, provider_ts: isoFromSeconds(num(ts))
  }], 0);
}

/**
 * Teksten i en WhatsApp-melding: `text.body`, og (L6) også KNAPPSVAR - `button.text` (hurtigsvar-knapp på en mal) og `interactive.button_reply.title`/`list_reply.title` - slik at en «Stopp»-knapp tolkes som en avmelding i stedet for å bli
 * ignorert (text var tidligere `null` for alt unntatt `text`). Feltnavnene er UVERIFISERT mot Metas dokumentasjon i denne økten (docs-vertene var ikke nåbare); parseren er defensiv og feil form gir `null`.
 */
function whatsappText(m: Record<string, unknown>): string | null {
  switch (m["type"]) {
    case "text": return str(obj(m["text"])?.["body"], 10_000);
    case "button": return str(obj(m["button"])?.["text"], 1_000);
    case "interactive": {
      const i = obj(m["interactive"]);
      return str(obj(i?.["button_reply"])?.["title"], 1_000) ?? str(obj(i?.["list_reply"])?.["title"], 1_000);
    }
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------ Meta: WhatsApp Cloud API, Messenger, Instagram
export function parseMetaBody(body: unknown): ParseOutcome {
  const b = obj(body);
  if (b === null) return { events: [], ignored: 1 };
  const events: NormalizedInbound[] = [];
  let ignored = 0;
  const object = b["object"];
  for (const entryRaw of arr(b["entry"])) {
    const entry = obj(entryRaw);
    if (entry === null) { ignored++; continue; }
    if (object === "whatsapp_business_account") {
      for (const changeRaw of arr(entry["changes"])) {
        const value = obj(obj(changeRaw)?.["value"]);
        const phoneNumberId = str(obj(value?.["metadata"])?.["phone_number_id"], 30);
        if (value === null || phoneNumberId === null) { ignored++; continue; }
        for (const mRaw of arr(value["messages"])) {
          const m = obj(mRaw);
          const id = idStr(m?.["id"]);
          const from = str(m?.["from"], 30);
          const sender = from === null ? null : normalized("whatsapp", from);
          if (m === null || id === null || sender === null) { ignored++; continue; }
          events.push({
            provider: "meta", channel: "whatsapp", account_ref: phoneNumberId, event_key: eventKey("wa:msg", id), kind: "message", sender, reply_to: sender, thread_ref: null,
            text: whatsappText(m), provider_ts: isoFromSeconds(num(m["timestamp"]))
          });
        }
        for (const sRaw of arr(value["statuses"])) {
          const s = obj(sRaw);
          const id = idStr(s?.["id"]);
          const status = str(s?.["status"], 30);
          if (s === null || id === null || status === null) { ignored++; continue; }
          const recipient = str(s["recipient_id"], 30);
          events.push({
            provider: "meta", channel: "whatsapp", account_ref: phoneNumberId, event_key: eventKey("wa:status", id, status), kind: "status",
            sender: recipient === null ? null : normalized("whatsapp", recipient), reply_to: null, thread_ref: null, text: null, provider_ts: isoFromSeconds(num(s["timestamp"]))
          });
        }
      }
    } else if (object === "page" || object === "instagram") {
      const channel: CommsChannel = object === "page" ? "messenger" : "instagram";
      for (const mRaw of arr(entry["messaging"])) {
        const m = obj(mRaw);
        const message = obj(m?.["message"]);
        const accountRef = str(obj(m?.["recipient"])?.["id"], 30) ?? str(entry["id"], 30);
        const senderId = str(obj(m?.["sender"])?.["id"], 30);
        const mid = idStr(message?.["mid"]);
        // `is_echo` = vår egen utgående melding speilet tilbake: aldri en innkommende hendelse.
        if (m === null || message === null || accountRef === null || senderId === null || mid === null || message["is_echo"] === true) { ignored++; continue; }
        const sender = normalized(channel, `${accountRef}:${senderId}`);
        if (sender === null) { ignored++; continue; }
        events.push({
          provider: "meta", channel, account_ref: accountRef, event_key: eventKey(object === "page" ? "msgr" : "ig", mid), kind: "message", sender, reply_to: senderId, thread_ref: null,
          text: str(message["text"], 10_000), provider_ts: isoFromSeconds(num(m["timestamp"]) === null ? null : (num(m["timestamp"]) as number) / 1000)
        });
      }
    } else {
      ignored++;
    }
  }
  return finish(events, ignored);
}

// ------------------------------------------------------------------------------------------------ Twilio (skjema-kodet)
export function parseTwilioParams(params: ReadonlyMap<string, readonly string[]>): ParseOutcome {
  const one = (k: string, max = 2000): string | null => str(params.get(k)?.[0], max);
  const sid = idStr(params.get("MessageSid")?.[0]) ?? idStr(params.get("SmsSid")?.[0]);
  const from = one("From", 40);
  const to = one("To", 40);
  const toNumber = to === null ? null : normalizeE164(to);
  if (sid === null || toNumber === null) return { events: [], ignored: 1 };
  // Statusvarsel (leveringsstatus på vår utgående melding) har `MessageStatus`/`SmsStatus` og ingen `Body`.
  const status = one("MessageStatus", 30) ?? one("SmsStatus", 30);
  const body = params.get("Body")?.[0];
  if (body === undefined && status !== null) {
    return finish([{ provider: "twilio", channel: "sms", account_ref: toNumber, event_key: eventKey("twilio:status", sid, status), kind: "status", sender: null, reply_to: null, thread_ref: null, text: null, provider_ts: null }], 0);
  }
  const sender = from === null ? null : normalizeE164(from);
  if (sender === null || body === undefined) return { events: [], ignored: 1 }; // inkl. `whatsapp:+47…` over Twilio (ikke støttet)
  return finish([{ provider: "twilio", channel: "sms", account_ref: toNumber, event_key: eventKey("twilio:msg", sid), kind: "message", sender, reply_to: sender, thread_ref: null, text: body.slice(0, 10_000), provider_ts: null }], 0);
}

// ------------------------------------------------------------------------------------------------ Telnyx
export function parseTelnyxBody(body: unknown): ParseOutcome {
  const data = obj(obj(body)?.["data"]);
  const type = str(data?.["event_type"], 80);
  const id = idStr(data?.["id"]);
  const payload = obj(data?.["payload"]);
  if (data === null || type === null || id === null || payload === null) return { events: [], ignored: 1 };
  const occurred = str(data["occurred_at"], 40);
  const ts = occurred !== null && Number.isFinite(Date.parse(occurred)) ? new Date(occurred).toISOString() : null;
  const toRaw = str(obj(arr(payload["to"])[0])?.["phone_number"], 40);
  const toNumber = toRaw === null ? null : normalizeE164(toRaw);
  if (toNumber === null) return { events: [], ignored: 1 };
  if (type === "message.received" && payload["direction"] === "inbound") {
    const fromRaw = str(obj(payload["from"])?.["phone_number"], 40);
    const sender = fromRaw === null ? null : normalizeE164(fromRaw);
    if (sender === null) return { events: [], ignored: 1 };
    return finish([{ provider: "telnyx", channel: "sms", account_ref: toNumber, event_key: eventKey("telnyx", id), kind: "message", sender, reply_to: sender, thread_ref: null, text: typeof payload["text"] === "string" ? (payload["text"] as string).slice(0, 10_000) : null, provider_ts: ts }], 0);
  }
  if (type.startsWith("message.") && payload["direction"] === "outbound") {
    return finish([{ provider: "telnyx", channel: "sms", account_ref: str(obj(payload["from"])?.["phone_number"], 40) ?? toNumber, event_key: eventKey("telnyx:status", idStr(payload["id"]) ?? id, type), kind: "status", sender: null, reply_to: null, thread_ref: null, text: null, provider_ts: ts }], 0);
  }
  return { events: [], ignored: 1 };
}
