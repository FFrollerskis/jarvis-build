import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessService } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import {
  CommsStore, CommsTransport, GoogleContacts, MeetingService, OutboundFunnel, commsToolDefinitions, createContentHasher, executeCommsOwnerAction, parseCommsConfig, type AdapterMap, type CommsConfig, type FunnelContext, type MarketingBasisPort, type OwnerActionResult
} from "../../src/index.ts";
import { OWNER, TENANT_A, TEST_PEPPER, scriptedAdapter, startCommsDb, type AdapterCall, type CommsDb } from "./harness.ts";

/**
 * Felles oppsett for tester som går gjennom HELE eierkjeden (embedded Postgres med RLS, ekte ToolGateway med klasse D-pipeline, ekte policy, ekte eier-rute-logikk) med skriptbare falske leverandør-adaptere. Brukes av
 * fiks-runde-testene (samtidighet, formålsgrunnlag, STOP-omfang, idempotens-kollisjon, ...). Alt tid styres av `setNow`.
 */
export interface Chain {
  readonly db: CommsDb;
  readonly store: CommsStore;
  readonly graph: ConversationGraphService;
  readonly funnel: OutboundFunnel;
  readonly gateway: ToolGateway;
  readonly config: CommsConfig;
  readonly twilio: ReturnType<typeof scriptedAdapter>;
  readonly telnyx: ReturnType<typeof scriptedAdapter>;
  readonly slack: ReturnType<typeof scriptedAdapter>;
  readonly whatsapp: ReturnType<typeof scriptedAdapter>;
  readonly notifications: ClassDNotification[];
  readonly owner: IdentityContext;
  readonly ctx: FunnelContext;
  now(): Date;
  setNow(date: Date): void;
  key(prefix: string): string;
  /** Et fersk, gyldig norsk mobilnummer (E.164) som ikke er brukt før i denne kjeden. */
  phone(): string;
  /** Eier-handling via den EKTE eier-rute-logikken (ownerGate -> gateway). */
  act(action: string, parameters: Record<string, JsonValue>, idem?: string, identity?: IdentityContext): Promise<OwnerActionResult>;
  stop(): Promise<void>;
}

export interface ChainOptions {
  readonly marketing?: MarketingBasisPort;
  /** K1: pepperen traktens HMAC-hasher bruker (standard: en falsk testverdi). `null` = manglende pepper (fail-closed: ingen utsendelse). En funksjon gir en pepper som kan endres under testen (rotasjon). */
  readonly pepper?: string | null | (() => string | null);
  readonly rateLimitPerMinute?: number;
  /**
   * FIX-3 (WP-G1c fiks-runde 1): tie-marginen en START må ha til en STOP for å løfte den (millisekunder, databasens klokke). Utelatt = produksjonsstandarden (`START_TIE_MARGIN_MS`, 5 s). `0` = ren sekvensmodell (en START løfter alt med lavere
   * sekvens uansett tid): brukes av tester som legger inn en STOP og så straks en START og forventer at den løfter, og av sekvens-orakelet.
   */
  readonly startTieMarginMs?: number;
  /** Løfter gatewayens per-verktøy-grense (autorisering/avmelding har 10-20/min) for tester som kjører mange handlinger raskt etter hverandre. */
  readonly lenientToolLimits?: boolean;
  /**
   * `contacts`: Google Contacts-verktøyene mot en falsk People API (testen stubber global `fetch`; token-henting er falsk) - `meetings`: møtepipelinen (ekte `MeetingService` mot samme Postgres). Uten dem finnes verktøyene ikke (som flagg AV).
   * WP-G1b: ble deklarert men aldri koblet; nå brukt av `payload-binding.test.ts` (ikke-journalførte handlinger med ekte ledger).
   */
  readonly deps?: { contacts?: boolean; meetings?: boolean };
}

export async function startChain(prefix: string, env: Record<string, string> = {}, options: ChainOptions = {}): Promise<Chain> {
  const db = await startCommsDb(prefix);
  let current = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo
  const clock = () => current;
  const store = new CommsStore(db.app, clock, options.startTieMarginMs !== undefined ? { startTieMarginMs: options.startTieMarginMs } : {});
  const graph = new ConversationGraphService(db.app);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack,phone,whatsapp", JARVIS_COMMS_CALLS: "on", JARVIS_COMMS_VENDOR_READS: "on", ...env });
  const twilio = scriptedAdapter("twilio");
  const telnyx = scriptedAdapter("telnyx");
  const slack = scriptedAdapter("slack", () => ({ provider_message_id: `17318${Math.floor(Math.random() * 900000 + 100000)}.000100` }));
  const whatsapp = scriptedAdapter("meta_whatsapp");
  // Twilio-adapteren i produksjon har `call`; den skriptede har ikke - legg til en som registrerer anropet.
  for (const a of [twilio, telnyx]) {
    (a as unknown as { call: unknown }).call = async (req: Record<string, unknown>, cred: string) => { a.calls.push({ op: "call", request: { ...req }, credential: cred } satisfies AdapterCall); return { provider_message_id: `CA-${a.calls.length}` }; };
  }
  const adapters: AdapterMap = { twilio, telnyx, slack, meta_whatsapp: whatsapp };
  const pepperOf = (): string | null => (typeof options.pepper === "function" ? options.pepper() : options.pepper === undefined ? TEST_PEPPER : options.pepper);
  const funnel = new OutboundFunnel({ store, graph, adapters, config, clock, contentHasher: async () => createContentHasher(pepperOf()), ...(options.marketing !== undefined ? { marketing: options.marketing } : {}) });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (x) => { notifications.push(x); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  const contacts = options.deps?.contacts === true ? { api: new GoogleContacts(async () => "fake-access-token", { warmupDelayMs: 0 }), graph } : undefined;
  const meetings = options.deps?.meetings === true ? new MeetingService({ pool: db.app, clock, graph, business: new BusinessService(db.app), retentionDays: 180 }) : undefined;
  const transport = new CommsTransport({ funnel, store, ...(contacts !== undefined ? { contacts } : {}), ...(meetings !== undefined ? { meetings } : {}) });
  for (const d of commsToolDefinitions({
    transport, store, rateLimitPerMinute: options.rateLimitPerMinute ?? 1000, calls: config.calls, vendorReads: config.vendor_reads, ...(contacts !== undefined ? { contacts: true } : {}), ...(meetings !== undefined ? { meetings: true } : {})
  })) gateway.register(options.lenientToolLimits === true ? { ...d, rate_limit_per_minute: 1_000_000 } : d);
  const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-chain", device_id: "dev-chain", channel: "api", auth_strength: "signed" };
  const ownerGate = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.tenant_id === TENANT_A;
  let n = 0;
  const chain: Chain = {
    db, store, graph, funnel, gateway, config, twilio, telnyx, slack, whatsapp, notifications, owner,
    ctx: { tenantId: TENANT_A, space: "business", actor: { person_id: OWNER, session_id: "sess-chain-fn" }, source: "owner_route" },
    now: () => current,
    setNow: (date) => { current = date; },
    key: (p) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`,
    phone: () => `+4790${String(800000 + ++n).padStart(6, "0").slice(-6)}`,
    act: (action, parameters, idem, identity = owner) => executeCommsOwnerAction({ gateway, funnel, ownerGate }, identity, { action, parameters, ...(idem !== undefined ? { idempotency_key: idem } : {}) }),
    stop: async () => { await db.stop(); }
  };
  return chain;
}

/** Autoriserer eierens konti for en test via det ekte verktøyet (klasse C). */
export async function authorizeAll(chain: Chain, accounts: ReadonlyArray<readonly [string, string, string]>, identity: IdentityContext = chain.owner): Promise<void> {
  for (const [channel, account_ref, provider] of accounts) {
    const r = await chain.act("authorize_account", { channel, account_ref, provider }, chain.key("auth"), identity);
    if (!r.ok) throw new Error(`authorize ${channel}/${account_ref}: ${JSON.stringify(r)}`);
  }
}
