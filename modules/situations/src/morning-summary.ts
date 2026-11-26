import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ALL_DOMAINS } from "./domain-pause.ts";
import { classifyDelivery, type MorningSummaryDelivery } from "./morning-summary-delivery.ts";

/**
 * WP-G4b K5 (D-484, Q-75 pkt 8, JARVIS-115 f): MORGENOPPSUMMERING av nattlige kamerahendelser.
 *
 * Problemet: en kamerahendelse som kommer i STILLE TIMER holdes tilbake (situasjonen står på `remember`, B-HIGH-1) og re-evalueres hvert tikk så lenge observasjonen ligger i kameraets oppslagsvindu (`max(10 min, 3 x tikk)`).
 * Faller den ut av vinduet før stille timer er over, blir den aldri varslet - eieren fikk ingenting om natten, og ingenting om morgenen.
 *
 * Løsningen er ÉN samlet, NØYTRAL melding ved stille-timers slutt (per eier og rom), via den EKSISTERENDE varselveien (`ToolGateway.execute` -> `telegram.notify`, med policy, kill switch, frys og revisjon) og de eksisterende pausene:
 *  - NØYTRAL og innholdsfri: kamera- og helsedata er `SECRET_RESTRICTED`, og Telegram er en skykanal (kjent hull N1). Teksten er en KONSTANT («... åpne Jarvis for detaljer», samme prinsipp som den nøytrale helsevarselen, Q-75 pkt 6): ingen
 *    etiketter, bilder, navn, kategorier, tidspunkter eller antall. Situasjonenes `reason`/fakta leses ALDRI av dette steget - kun en telling i databasen avgjør OM meldingen sendes.
 *  - Hvilke hendelser teller: åpne `vision`-situasjoner på `remember` med prioritet over `low` (nøyaktig det stille timer holder tilbake, jf. `heldByQuietHours`), som aldri er varslet (`last_notified_at IS NULL`) og ble åpnet i den siste natten
 *    (vinduet [start, slutt) av stille timer). En hendelse som likevel ble varslet individuelt (observasjonen lå fortsatt i oppslagsvinduet da stille timer sluttet) telles ikke; er det ingenting igjen, sendes ingenting.
 *  - IDEMPOTENT (ett sammendrag per natt, ingen dobbeltsending ved omstart): nøkkelen `situation-morning-summary:<tenant>:<rom>:<slutt-tidspunkt>` er en ToolGateway-idempotensnøkkel (varig i `tool_executions`); det sjekkes FØR noe sendes.
 *    Hva som sendes på nytt og hva som ALDRI gjør det (fiks-runde 1, review A LOW-1 - ærlig): en krasj midt i sendingen (raden står som `reserved`) og et gateway-tidsavbrudd (`unverified`) er ukjent utfall og sendes aldri på nytt (høyst én
 *    gang er tryggere enn to). En REN transportfeil på klasse B (f.eks. ECONNRESET, avvist av leverandøren) er derimot ikke et ukjent utfall for gatewayen: ledgeren får `failed` (gatewayens `mayDuplicateOnRetry` utelater klasse B bevisst), og
 *    neste tikk innenfor etterfyllingsvinduet sender på nytt - i verste fall ETT ekstra sammendrag (konstant, innholdsfri, lavrisiko). Telegram-transporten er delt kode og er ikke endret for å fange det. Samtidige kall for samme natt
 *    gir nøyaktig ett `sent` (taperne får `already_sent`).
 *  - Etterfylling begrenset: en tikk som kommer sent (nedetid) sender fortsatt sammendraget for natten som nettopp sluttet, men ikke senere enn `MORNING_SUMMARY_CATCH_UP_MS` etter slutten.
 *  - Pause (domenet `vision` eller hele motoren) og kill switch (i gatewayen) stopper sendingen; den prøves igjen neste tikk innenfor etterfyllingsvinduet.
 *  - AV med mindre situasjonsflaggene er på: tjenesten bygges kun av `apps/api` når `JARVIS_SITUATION_SIGNALS` OG `JARVIS_SITUATION_VISION` er på (ingen nytt flagg), og kun løperen kaller den.
 * Etterfylling av kamerahendelser etter nedetid, HA-push, kontrollsenter-UI og kobling av anomali-detektorene er IKKE del av dette (se runbook).
 */
export const MORNING_SUMMARY_MESSAGE = "Det ble registrert kamerahendelser mens stille timer gjaldt - åpne Jarvis for detaljer.";

/** En forsinket tikk (nedetid) sender fortsatt sammendraget for natten som nettopp sluttet, men ikke senere enn dette etter stille-timers slutt. */
export const MORNING_SUMMARY_CATCH_UP_MS = 12 * 3_600_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface QuietNight {
  /** Starten på den siste stille-timer-natten (UTC, inklusiv). */
  startMs: number;
  /** Slutten (UTC, eksklusiv): det siste `quietEnd:00:00Z`-tidspunktet som ikke er i fremtiden. */
  endMs: number;
}

/**
 * REN: den SISTE stille-timer-natten som er over på `nowMs` (UTC-timer, samme tolkning som `isWithinQuietHours`: `start === end` eller manglende verdi = deaktivert = ingen natt). Vinduet er `[end - varighet, end)` der varigheten er
 * `(end - start) mod 24` timer, så et vindu over midnatt (22 -> 6) og et innenfor samme døgn (1 -> 5) behandles likt.
 */
export function latestQuietNight(nowMs: number, quietStartUtc: number | null, quietEndUtc: number | null): QuietNight | null {
  if (quietStartUtc === null || quietEndUtc === null || quietStartUtc === quietEndUtc) return null;
  if (!Number.isInteger(quietStartUtc) || !Number.isInteger(quietEndUtc) || quietStartUtc < 0 || quietStartUtc > 23 || quietEndUtc < 0 || quietEndUtc > 23) return null;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  let endMs = dayStart + quietEndUtc * HOUR_MS;
  if (endMs > nowMs) endMs -= DAY_MS;
  const durationHours = (quietEndUtc - quietStartUtc + 24) % 24;
  return { startMs: endMs - durationHours * HOUR_MS, endMs };
}

/** Idempotensnøkkelen for ÉN natt og ÉTT (tenant, rom): stabil på tvers av omstarter, ulik fra natt til natt. */
export function morningSummaryKey(tenantId: string, memorySpace: string, nightEndMs: number): string {
  return `situation-morning-summary:${tenantId}:${memorySpace}:${new Date(nightEndMs).toISOString()}`;
}

export type MorningSummaryStatus =
  /** Sendt nå (bekreftet av ToolGateway). */
  | "sent"
  /** Allerede sendt (eller utfallet er ukjent etter en krasj/tidsavbrudd, eller et samtidig kall sendte): aldri på nytt. */
  | "already_sent"
  /** Ingen stille timer konfigurert (eller deaktivert), ingen natt å oppsummere. */
  | "no_quiet_hours"
  /** Natten er for lenge siden (utenfor etterfyllingsvinduet). */
  | "outside_window"
  /** Domenet `vision` (eller hele motoren) er pauset: ingenting sendes nå. */
  | "paused"
  /** Ingen holdte, uvarslede nattlige kamerahendelser: ingenting å si. */
  | "nothing_to_report"
  /** Sendingen feilet (policy/kill switch/transport): prøves igjen neste tikk innenfor etterfyllingsvinduet. */
  | "failed";

export interface MorningSummaryResult {
  status: MorningSummaryStatus;
  /** Slutten på natten sammendraget gjelder (ISO), når en natt finnes. */
  night_end?: string;
}

export class MorningSummaryService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Kjør steget for ÉN (tenant, rom). Kaster aldri for en normal tilstand; en databasefeil kastes (løperen teller den med kode). `nowMs` er injisert (klokken styres av kalleren).
   * Eneste skriving er selve varselet (ToolGateway-ledgeren); ingen egen tabell, ingen endring av situasjonene.
   */
  async deliver(tenantId: string, memorySpace: MemorySpace, gateway: Pick<ToolGateway, "execute">, identity: IdentityContext, nowMs: number): Promise<MorningSummaryResult> {
    if (identity.tenant_id !== tenantId || identity.memory_space_id !== memorySpace) throw new Error("morning_summary_scope_mismatch");
    const policy = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT quiet_hours_start_utc, quiet_hours_end_utc FROM situation_notification_policies WHERE tenant_id = $1 AND memory_space_id = $2`, [tenantId, memorySpace]);
      return rows[0] as { quiet_hours_start_utc: number | null; quiet_hours_end_utc: number | null } | undefined;
    });
    const night = latestQuietNight(nowMs, policy?.quiet_hours_start_utc ?? null, policy?.quiet_hours_end_utc ?? null);
    if (night === null) return { status: "no_quiet_hours" };
    const nightEnd = new Date(night.endMs).toISOString();
    if (nowMs - night.endMs > MORNING_SUMMARY_CATCH_UP_MS) return { status: "outside_window", night_end: nightEnd };

    const key = morningSummaryKey(tenantId, memorySpace, night.endMs);
    const evidence = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT status, tool_id, action FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
      return rows[0] as { status: string; tool_id: string; action: string } | undefined;
    });
    // En rad under nøkkelen er enten bekreftet sendt, eller utfallet er ukjent (krasj midt i sendingen): aldri på nytt. Kun en `failed`-rad (ingen bivirkning) kan prøves igjen under samme nøkkel.
    if (evidence !== undefined && evidence.status !== "failed") return { status: "already_sent", night_end: nightEnd };

    const gathered = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: pauses } = await client.query(`SELECT domain FROM situation_domain_pauses WHERE domain = ANY($1::text[])`, [["vision", ALL_DOMAINS]]);
      // Kun en TELLING: situasjonens begrunnelse, fakta og nøkkel leses aldri her (begrensede data).
      const { rows: counted } = await client.query(
        `SELECT count(*)::int AS n FROM situations
         WHERE tenant_id = $1 AND memory_space_id = $2 AND domain = 'vision' AND status = 'open' AND stage = 'remember' AND priority <> 'low'
           AND last_notified_at IS NULL AND opened_at >= $3 AND opened_at < $4`,
        [tenantId, memorySpace, new Date(night.startMs).toISOString(), nightEnd]
      );
      return { paused: pauses.length > 0, held: Number((counted[0] as { n: number }).n) };
    });
    if (gathered.paused) return { status: "paused", night_end: nightEnd };
    if (gathered.held === 0) return { status: "nothing_to_report", night_end: nightEnd };

    let status: MorningSummaryDelivery = "failed";
    try {
      // FIX-11 (i): kun kallet som FAKTISK sendte får `sent`; et samtidig kall som tapte kappløpet om idempotensnøkkelen får `already_sent` (se `classifyDelivery`).
      status = classifyDelivery(await gateway.execute({ identity, tool_id: "telegram", action: "notify", parameters: { message: MORNING_SUMMARY_MESSAGE }, idempotency_key: key }));
    } catch {
      status = "failed";
    }
    return { status, night_end: nightEnd };
  }
}
