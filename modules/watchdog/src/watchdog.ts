import type pg from "pg";
import type { KillSwitch } from "@jarvis/policy";
import { listAllTenantIds, withTenantTransaction } from "@jarvis/core";

export type Severity = "info" | "warning" | "critical";

export interface Alert {
  check: string;
  severity: Severity;
  message: string;
  runbook: string;
  at: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}

/**
 * D-181 (BLOCKER B1, arkitekt-order D184 mot PR #96): erstatter D-180/D183 sin
 * `GatewayAlertSink`, som rutet nødvarselet gjennom DEN ORDINÆRE
 * `ToolGateway.execute({tool_id:"telegram", action:"notify"})`-stien -
 * NØYAKTIG stien `PolicyGateway.authorize()` nekter med `kill_switch_active`
 * når den GLOBALE kill switchen er aktiv (`telegram.notify` er bevisst IKKE
 * i `isSelfRecoveryAction()`, og skal ikke legges dit - se under). Resultat:
 * watchdog-en klarte å stenge Jarvis ned (D-180 sin durable-fiks virket), men
 * kunne ALDRI fortelle Tobias om det - en selvmotsigende "nødstopp uten
 * nødvarsel", fanget av uavhengig arkitekt-review av PR #96.
 *
 * IKKE løst ved å utvide `isSelfRecoveryAction()` til å inkludere
 * `telegram.notify` (ville svekket den globale kill-switch-semantikken for
 * ALLE kallere av telegram.notify, ikke bare watchdog-en - se
 * `modules/policy/src/owner-control-store.ts`, uendret av denne posten) og
 * IKKE løst ved å midlertidig de-/reaktivere kill switchen kun for å sende
 * én melding. I stedet: en EGEN, SMAL grense som bevisst hopper over
 * `ToolGateway.execute()`/`PolicyGateway.authorize()` - fordi en aktiv kill
 * switch er PRESIS situasjonen dette varselet finnes for å rapportere - men
 * som IKKE er en generell verktøytilgang: `send()` er grensesnittets ENESTE
 * metode, INGEN handlingsvalg, INGEN kaller-kontrollert mottaker (mål er
 * ALLTID transportens egen, allerede konfigurerte destinasjon), INGEN rå
 * credential eksponert utenfor selve kallet (aldri logget/returnert).
 *
 * Produksjons-wiring (`apps/api/src/worker-main.ts`) injiserer DEN SAMME
 * `TelegramTransport`- og `SecretProvider`-instansen som den ordinære
 * `telegram.notify`-verktøydefinisjonen selv bruker (SAMME
 * `credential_ref`=`JARVIS_TELEGRAM_TOKEN`, SAMME mottaker-konfigurasjon via
 * `TelegramTransport` sin egen `chatId`) - INGEN ny credential-mekanisme,
 * INGEN parallell Telegram-klient. `transport`/`secrets` er typet som SMALE,
 * lokale grensesnitt (ikke importert fra `@jarvis/tool-gateway`) - den ekte
 * `TelegramTransport`/`SecretProvider`-en tilfredsstiller dem strukturelt,
 * men denne pakken trenger ikke lenger noen avhengighet til
 * `@jarvis/tool-gateway`/`@jarvis/contracts` for dette (mindre
 * avhengighetsgraf enn D-180 sin versjon, ikke større).
 */
export interface EmergencyAlertTransport {
  invoke(action: "notify", parameters: { message: string }, credential: string): Promise<{ external_id?: string }>;
}

export interface AlertCredentialSource {
  get(ref: string): Promise<string | null>;
}

/** Samme `credential_ref` som den ordinære `telegram.notify`-verktøydefinisjonen (`modules/tool-gateway/src/integrations.ts`) - ingen ny hemmelighet. */
export const WATCHDOG_TELEGRAM_CREDENTIAL_REF = "JARVIS_TELEGRAM_TOKEN";

/**
 * D-184: fjerner den rå credentialen fra en tekst FØR den kan forlate sinken.
 * `Watchdog.tick()` logger `(err as Error).message` fra et mislykket
 * `alerts.send()` (`watchdog_alert_delivery_failed`) - uten denne vasken ville
 * en transport som legger credentialen inn i sin EGEN feilmelding (den
 * kanoniske `TelegramTransport` gjør det ikke i dag, men URL-en den bygger
 * inneholder tokenet, så en fremtidig/annen transport kunne) skrive det rå
 * Telegram-tokenet rett i driftsloggen. Sinken eier credentialen og er derfor
 * det eneste stedet som KAN vaske den deterministisk.
 */
function redactCredential(text: string, credential: string): string {
  return credential.length === 0 ? text : text.split(credential).join("[REDACTED_CREDENTIAL]");
}

export class WatchdogEmergencyAlertSink implements AlertSink {
  constructor(
    private readonly transport: EmergencyAlertTransport,
    private readonly secrets: AlertCredentialSource,
    private readonly credentialRef: string = WATCHDOG_TELEGRAM_CREDENTIAL_REF
  ) {}

  async send(alert: Alert): Promise<void> {
    const credential = await this.secrets.get(this.credentialRef);
    if (!credential) {
      throw new Error("watchdog_alert_credential_unavailable");
    }
    const message = `[${alert.severity}] ${alert.check}: ${alert.message} (${alert.runbook})`;
    try {
      await this.transport.invoke("notify", { message }, credential);
    } catch (err) {
      // D-184: ALDRI videresend transportens rå feil (den kan bære
      // credentialen) - kast en vasket feil. `cause` settes BEVISST ikke:
      // en `cause` ville bare gjeninnført den uvaskede teksten for enhver
      // som serialiserer feilen.
      throw new Error(`watchdog_alert_transport_failed: ${redactCredential((err as Error).message, credential)}`);
    }
  }
}

/**
 * WP-E1 (JARVIS-068): resultatet av ETT FULLFØRT tikk - alle sjekker, ok og feil. Brukes av incident-produsenten (`@jarvis/incidents`, `WatchdogIncidentProducer`) til å åpne en hendelse for en
 * feilende sjekk og til å løse den når en senere kjøring av SAMME sjekk lykkes (vakthundens egen kjøring er re-målingen). Et hoppet overlappende tikk produserer ingen rapport.
 */
export interface WatchdogTickReport {
  at: string;
  results: Array<{ check: string; ok: boolean; severity: Severity; message: string; runbook: string }>;
}

export interface HealthCheck {
  name: string;
  runbook: string;
  /** D-395 (JARVIS-039): minste tid mellom to IDENTISKE varsler fra denne sjekken (overstyrer watchdogens standard). */
  cooldownMs?: number;
  run(): Promise<{ ok: boolean; severity: Severity; message: string }>;
}

/**
 * Deterministisk watchdog (masterplan §11.2 / CANONICAL §11): oppdager feil,
 * varsler med alvorlighetsgrad + runbook, og utfører KUN eksplisitt
 * registrerte, reversible tiltak med maks antall forsøk. Ingen LLM, ingen
 * autonom reparasjon, ingen vei utenom Policy Gateway (watchdog har ingen
 * verktøytilgang - kun varsling, registrerte restart-hooks og kill switch).
 */
export class Watchdog {
  private readonly checks: HealthCheck[] = [];
  private readonly actions = new Map<string, { run: () => Promise<void>; maxAttempts: number; attempts: number }>();
  // D-180 (W1): forhindrer overlappende samtidige tick()-kjøringer (§D i D183-
  // ordren) - en treg sjekk (f.eks. en langsom cost_events-spørring) skal
  // aldri kunne kjøre TO ganger samtidig fra to intervall-tikk som overlapper.
  private ticking = false;
  /** D-395 (JARVIS-039): siste sendte varsel per sjekk - et vedvarende avvik varslet tidligere HVERT tick (hvert minutt) i det uendelige. */
  private readonly lastAlert = new Map<string, { message: string; at: number }>();
  /** WP-E1: valgfri observatør av hvert fullførte tikk. Feil i observatøren påvirker ALDRI vakthunden (logges, aldri kastet), og tikket venter ikke på den. */
  private observer: ((report: WatchdogTickReport) => void | Promise<void>) | undefined;
  /** WP-OPS2a K3: når siste tikk FULLFØRTE (vakthundens egen klokke, ms). Grunnlaget for den eksterne dead man's switch-en: et hengt eller dødt tikk flytter det aldri. */
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly alerts: AlertSink,
    private readonly killSwitch: KillSwitch,
    /** D-393 (JARVIS-041): hver sjekk har et tidsavbrudd - en hengende sjekk blokkerte ellers hele overvåkningen (ticking-låsen ble aldri sluppet). */
    private readonly checkTimeoutMs = 20_000,
    /** D-395: samme varsel fra samme sjekk sendes på nytt først etter dette (eller straks meldingen endres). Standard 30 minutter. */
    private readonly alertCooldownMs = 30 * 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** WP-E1: registrer (ÉN) observatør av fullførte tikk - se `WatchdogTickReport`. */
  setObserver(observer: (report: WatchdogTickReport) => void | Promise<void>): void {
    this.observer = observer;
  }

  /** Reversibelt tiltak (f.eks. restart av ÉN tjeneste), aldri destruktivt. */
  registerAction(checkName: string, run: () => Promise<void>, maxAttempts = 2): void {
    this.actions.set(checkName, { run, maxAttempts, attempts: 0 });
  }

  /** Sant mens en tick() faktisk kjører - kun til test-/observabilitetsbruk. */
  isTicking(): boolean {
    return this.ticking;
  }

  /**
   * WP-OPS2a K3: tidspunktet (ms, samme klokke som vakthunden) da siste tikk FULLFØRTE, eller `null` før første. Settes KUN når et tikk faktisk er ferdig (alle sjekker kjørt, også de som feilet eller fikk tidsavbrudd) - et hoppet
   * overlappende tikk setter det ikke, og et tikk som henger (f.eks. en varslingssink som aldri svarer) flytter det ikke. Den eksterne heartbeaten (`apps/api/src/watchdog-heartbeat.ts`) pinger kun mens dette er ferskt.
   */
  lastCompletedTickAt(): number | null {
    return this.lastTickCompletedAt;
  }

  async tick(): Promise<Alert[]> {
    if (this.ticking) {
      // D-180: aldri stille tapt - en dropppet overlappende tick er selv
      // observerbar, ikke en stille no-op (§D "not silently swallow all failures").
      console.warn(JSON.stringify({ msg: "watchdog_tick_skipped_overlap", at: new Date().toISOString() }));
      return [];
    }
    this.ticking = true;
    try {
      const fired: Alert[] = [];
      const report: WatchdogTickReport = { at: new Date().toISOString(), results: [] };
      for (const check of this.checks) {
        let result: { ok: boolean; severity: Severity; message: string };
        try {
          let timer: NodeJS.Timeout | undefined;
          try {
            result = await Promise.race([
              check.run(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`tidsavbrudd etter ${this.checkTimeoutMs} ms`)), this.checkTimeoutMs); })
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (err) {
          result = { ok: false, severity: "critical", message: `sjekk feilet: ${(err as Error).message}` };
        }
        report.results.push({ check: check.name, ok: result.ok, severity: result.severity, message: result.ok ? "" : result.message, runbook: check.runbook });
        if (result.ok) {
          this.lastAlert.delete(check.name); // avviket er borte - neste avvik varsles umiddelbart
          continue;
        }
        const alert: Alert = {
          check: check.name, severity: result.severity, message: result.message,
          runbook: check.runbook, at: new Date().toISOString()
        };
        fired.push(alert);
        // D-180 (W1, §C/§D): varslingsfeil er ALDRI stille - logges alltid,
        // ALDRI blokkerer den allerede fullførte tilstandsmutasjonen i
        // check.run() (f.eks. costExplosionCheck sin durable kill-switch-
        // aktivering skjer FØR dette punktet, uavhengig av om varsling lykkes).
        const previous = this.lastAlert.get(check.name);
        const cooldown = check.cooldownMs ?? this.alertCooldownMs;
        if (previous && previous.message === alert.message && this.now() - previous.at < cooldown) {
          // D-395: identisk gjentakelse innenfor nedkjølingen - observerbart, men ikke et nytt varsel (spam).
          console.warn(JSON.stringify({ msg: "watchdog_alert_suppressed_repeat", check: check.name }));
        } else {
          this.lastAlert.set(check.name, { message: alert.message, at: this.now() });
          try {
            await this.alerts.send(alert);
          } catch (err) {
            // Leveringsfeil: ikke registrer som sendt, så neste tick prøver igjen.
            this.lastAlert.delete(check.name);
            console.error(JSON.stringify({
              msg: "watchdog_alert_delivery_failed", check: check.name, error: (err as Error).message
            }));
          }
        }
        const action = this.actions.get(check.name);
        if (action && action.attempts < action.maxAttempts) {
          action.attempts += 1;
          try {
            await action.run();
          } catch (err) {
            console.error(JSON.stringify({
              msg: "watchdog_action_failed", check: check.name, error: (err as Error).message
            }));
          }
        }
      }
      if (this.observer) {
        try {
          void Promise.resolve(this.observer(report)).catch((err) => console.error(JSON.stringify({ msg: "watchdog_observer_failed", error: (err as Error).message })));
        } catch (err) {
          console.error(JSON.stringify({ msg: "watchdog_observer_failed", error: (err as Error).message }));
        }
      }
      this.lastTickCompletedAt = this.now();
      return fired;
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Fastlåste jobber: running med utløpt lease = fastlåst worker (reclaim finnes, men varsle).
 *
 * D-393 (JARVIS-041): `tasks` har FORCE ROW LEVEL SECURITY (`tenant_id = current_setting('jarvis.tenant_id')`). Sjekken kjørte tidligere mot
 * poolen UTEN tenant-kontekst og så derfor ALLTID 0 rader på den ekte `jarvis_runtime`-rollen (samme feil som `costExplosionCheck` hadde, D-191) -
 * en blind overvåker. Nå kjøres spørringen i `withTenantTransaction` for den konfigurerte eier-tenanten.
 */
export function stuckTasksCheck(pool: pg.Pool, tenantId: string): HealthCheck {
  return {
    name: "stuck_tasks",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker",
    async run() {
      const n = await withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query(
          `SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()`
        );
        return (result.rows[0] as { n: number }).n;
      });
      return n === 0
        ? { ok: true, severity: "info", message: "" }
        : { ok: false, severity: "warning", message: `${n} jobber med utløpt lease` };
    }
  };
}

/** WP-OPS2a K2: maks antall tenants `stuckTasksAllTenantsCheck` vurderer per kjøring (samme øvre grense som sveipene). Flere enn dette meldes som delvis blindhet, aldri avkortet i det stille. */
export const STUCK_TASKS_MAX_TENANTS = 200;
/** WP-OPS2a K2: tidsbudsjett for selve telleløkken (under sjekk-fristen på 20 s): uleste tenants regnes som «ikke lest», så en treg database ikke lar kjøringer hope seg opp. */
export const STUCK_TASKS_READ_BUDGET_MS = 15_000;

export interface StuckTasksAllTenantsOptions {
  /** Overstyrer `STUCK_TASKS_MAX_TENANTS` (tester). */
  maxTenants?: number;
  /** Overstyrer `STUCK_TASKS_READ_BUDGET_MS` (tester). */
  budgetMs?: number;
  /** Klokke i ms (tester). */
  now?: () => number;
}

/**
 * WP-OPS2a K2 (JARVIS-041-resten): `stuckTasksCheck(pool, tenantId)` teller kun ÉN tenant, men workeren claimer på tvers av tenants (`007_claim_function.sql`): en fastlåst jobb i en business-tenant var usynlig for vakthunden. Denne sjekken
 * teller utløpt lease i HVER tenant (`listAllTenantIds` + `withTenantTransaction` per tenant, samme RLS-trygge mønster som `stuckTasksCheck` og sveipene) og beholder navn, runbook, nedkjøling og meldingsform.
 *  - Meldingen er IDENTISK med den gamle når katalogen har nøyaktig én tenant (`N jobber med utløpt lease`); med flere tenants får den suffikset ` (i k tenants)` (k = tenants som har fastlåste jobber).
 *  - Delvis blindhet er ALDRI «0 = frisk»: en opptellingsfeil, en tenant som ikke kan leses (eller ikke rekkes innen tidsbudsjettet), en tom katalog og flere enn `maxTenants` gir `ok:false` (warning). En feilende tenant stopper ikke de øvrige.
 *  - Aldri tenant-id og aldri rå feiltekst i melding eller logg: kun antall og SQLSTATE-koder (feilteksten kan sitere tenant-id eller rader).
 *  - Opptellingen er stille (`quiet`): sjekken kjører hvert minutt og skal ikke legge en ny loggrad per tikk.
 */
export function stuckTasksAllTenantsCheck(pool: pg.Pool, options: StuckTasksAllTenantsOptions = {}): HealthCheck {
  const maxTenants = options.maxTenants ?? STUCK_TASKS_MAX_TENANTS;
  const budgetMs = options.budgetMs ?? STUCK_TASKS_READ_BUDGET_MS;
  const clock = options.now ?? (() => Date.now());
  const warn = (message: string): { ok: false; severity: Severity; message: string } => ({ ok: false, severity: "warning", message });
  return {
    name: "stuck_tasks",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker",
    async run() {
      let found: string[];
      try {
        // ÉN ekstra rad over grensen avslører at katalogen er lengre enn det vi vurderer.
        found = await listAllTenantIds(pool, maxTenants + 1, { quiet: true });
      } catch (err) {
        console.warn(JSON.stringify({ msg: "watchdog_stuck_tasks_enumeration_failed", error_name: (err as Error).name }));
        return warn("tenant-oppregning feilet - jobber med utløpt lease er ikke vurdert");
      }
      if (found.length === 0) return warn("ingen tenants funnet - jobber med utløpt lease er ikke vurdert");
      const truncated = found.length > maxTenants;
      const tenants = truncated ? found.slice(0, maxTenants) : found;
      const startedAt = clock();
      let stuck = 0;
      let stuckTenants = 0;
      let unread = 0;
      const sqlstates = new Set<string>();
      for (const tenantId of tenants) {
        if (clock() - startedAt > budgetMs) {
          unread += 1;
          sqlstates.add("budget");
          continue;
        }
        try {
          const n = await withTenantTransaction(pool, tenantId, async (client) => {
            const result = await client.query(`SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()`);
            return (result.rows[0] as { n: number }).n;
          });
          if (n > 0) {
            stuck += n;
            stuckTenants += 1;
          }
        } catch (err) {
          unread += 1;
          const code = (err as { code?: unknown }).code;
          sqlstates.add(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "error");
        }
      }
      if (unread > 0) console.warn(JSON.stringify({ msg: "watchdog_stuck_tasks_tenant_read_failed", unread, tenants: tenants.length, reasons: [...sqlstates].sort() }));
      const parts: string[] = [];
      if (stuck > 0) {
        const suffix = tenants.length > 1 || truncated ? ` (i ${stuckTenants} ${stuckTenants === 1 ? "tenant" : "tenants"})` : "";
        parts.push(`${stuck} jobber med utløpt lease${suffix}`);
      }
      if (unread > 0) parts.push(`${unread} av ${tenants.length} tenants kunne ikke leses`);
      if (truncated) parts.push(`flere enn ${maxTenants} tenants (de øvrige er ikke vurdert)`);
      return parts.length === 0 ? { ok: true, severity: "info", message: "" } : warn(parts.join("; "));
    }
  };
}

export function databaseCheck(pool: pg.Pool): HealthCheck {
  return {
    name: "database",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#postgres",
    async run() {
      await pool.query("SELECT 1");
      return { ok: true, severity: "info", message: "" };
    }
  };
}

/**
 * Kostnadseksplosjon (D-09-kriterium): over hardgrensen utløses kill switch -
 * deterministisk, reversibel (deaktiveres manuelt via canonical owner/executive
 * gjenopprettingsvei), og policyen nekter alt til Tobias har vurdert situasjonen.
 *
 * D-180 (W1, arkitekt-order D183 - retter D182 sitt REAL_INTERNAL_GAP-funn):
 * FØR denne fiksen kalte denne funksjonen `killSwitch.activate(reason)` - den
 * rene, in-memory-eneste setteren (`KillSwitch.activate()`). Produksjonens
 * ENESTE autoritative sjekk, `PolicyGateway.authorize()`, spør ALLTID
 * `killSwitch.isActiveDurable()` - som, når `KillSwitch` er konstruert MED et
 * `pool` (K1/D-164s produksjonsmønster i både `main.ts` og `worker-main.ts`),
 * IGNORERER det in-memory-feltet fullstendig og spør `owner_control_state`
 * direkte. En kostnadseksplosjon-utløst `.activate()` var derfor et STILLE
 * no-op mot den faktiske håndhevingen - usynlig selv i SAMME prosess, ikke
 * bare på tvers av api-/worker-prosessene. Rettet til `activateDurable()`,
 * som SKRIVER til `owner_control_state` (migrasjon 058) og dermed er synlig
 * for `isActiveDurable()` uansett hvilken prosess/pool-instans som spør.
 *
 * `ownerPersonId` er EKSPLISITT og PÅKREVD (ingen default, ingen `undefined`-
 * fallback som stille ville endret revisjonssemantikken, jf. D183 §B).
 * `owner_control_state.actor_person_id` har en REELL FK mot `people`
 * (migrasjon 058), OG `assertOwnerControlAuthorized()`
 * (`modules/policy/src/owner-control-store.ts`) krever UBETINGET
 * `actorPersonId === authority.owner_person_id` - en oppdiktet, separat
 * "system-watchdog"-identitet ville derfor ALDRI vært autorisert (kastet
 * `OwnerControlUnauthorizedError`) og ville uansett brutt FK-en. Denne
 * automatiserte nødmekanismen handler derfor UNDER eierens egen, allerede
 * konfigurerte sovereign-autoritet (samme `ownerControlAuthority.owner_person_id`
 * som resten av `worker-main.ts` sin wiring) - IKKE som en fiktiv tredje
 * identitet - eksakt presedens for "sovereign owner-modus, ingen kunstig
 * godkjenningssperre for eierens EGNE forhåndsautoriserte automasjon" (D-41).
 *
 * Idempotens/duplikat-vern (D183 §D, "avoid duplicate cost-explosion
 * activations producing harmful repeated state mutation"): guarden mot
 * gjentatt aktivering bruker NÅ `isActiveDurable()` (den autoritative, delte
 * tilstanden), ikke det rene in-memory-feltet - to worker-instanser (eller to
 * påfølgende tick-kjøringer i SAMME prosess) som begge oppdager samme
 * kostnadseksplosjon kaller `activateDurable()` maksimalt ÉN gang mens
 * kontrollen faktisk er aktiv (skriving er dessuten et idempotent UPSERT, se
 * `writeControlState()`, så selv et race mellom to samtidige kall er trygt).
 *
 * D-191 (BLOCKER B4, arkitekt-order D191 mot PR #96 - funn fra samme EKTE
 * host-kjøring som D190, run_id `aad6de29`): migrasjon 005_rls.sql legger
 * `FORCE ROW LEVEL SECURITY` på `cost_events` med policyen
 * `USING (tenant_id = current_setting('jarvis.tenant_id', true))`.
 * `costExplosionCheck` sin månedlige SUM-spørring kjørte tidligere DIREKTE
 * mot runtime-`pool` UTEN å etablere `jarvis.tenant_id` først - på den ekte
 * `jarvis_runtime`-rollen (NOSUPERUSER/NOBYPASSRLS, FORCE RLS) betyr det at
 * `current_setting('jarvis.tenant_id', true)` er NULL, `tenant_id = NULL`
 * er ALDRI sant, og spørringen så DERFOR alltid `spent=0` - uansett faktisk
 * forbruk. En sikkerhetsmekanisme som strukturelt ALDRI kunne utløses i
 * produksjon. Rettet ved å kreve en eksplisitt `tenantId` og kjøre SELECT-en
 * inni den kanoniske `withTenantTransaction(pool, tenantId, ...)` (SAMME
 * mekanisme som resten av kodebasen bruker for tenant-skopet tilgang) - IKKE
 * en ny/parallell RLS-omgåelse, IKKE `adminPool` i produksjon, INGEN
 * privilegie-/RLS-endring. Hardgrensen forblir tenant-skopet (per design -
 * `cost_events` sin egen RLS-policy garanterer dette strukturelt).
 */
export function costExplosionCheck(
  pool: pg.Pool,
  killSwitch: KillSwitch,
  ownerPersonId: string,
  tenantId: string,
  hardLimitOre = 300_000
): HealthCheck {
  return {
    name: "cost_explosion",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad",
    async run() {
      const spent = await withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query(
          `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
        );
        return (result.rows[0] as { spent: number }).spent;
      });
      if (spent < hardLimitOre) {
        return { ok: true, severity: "info", message: "" };
      }
      const alreadyActive = await killSwitch.isActiveDurable();
      if (alreadyActive) {
        return { ok: false, severity: "critical", message: "over hardgrense (kill switch allerede aktiv)" };
      }
      await killSwitch.activateDurable(`kostnadseksplosjon: ${spent} øre >= ${hardLimitOre}`, ownerPersonId);
      return { ok: false, severity: "critical", message: `kill switch aktivert (${(spent / 100).toFixed(0)} kr)` };
    }
  };
}

/**
 * D-395 (JARVIS-039): varselgrensen (standard 1 000 kr/mnd) ble aldri varslet - `BudgetGuard` ga bare nivået «warn» internt. Denne sjekken varsler (én gang per
 * døgn) når månedsforbruket passerer varselgrensen, med en KONSTANT melding slik at nedkjølingen virker. Rører aldri kill switchen (kun hardgrensen gjør det).
 */
export function costWarningCheck(pool: pg.Pool, tenantId: string, warnOre = 100_000): HealthCheck {
  return {
    name: "cost_warning",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad",
    cooldownMs: 24 * 60 * 60_000,
    async run() {
      const spent = await withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query(`SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`);
        return (result.rows[0] as { spent: number }).spent;
      });
      if (spent < warnOre) return { ok: true, severity: "info", message: "" };
      return { ok: false, severity: "warning", message: `månedlig kostnad er over varselgrensen (${(warnOre / 100).toFixed(0)} kr)` };
    }
  };
}

/**
 * D-187 (BLOCKER B2, arkitekt-order D187 mot PR #96 - fersk review av post-B1
 * HEAD): `apps/api/src/worker-main.ts` kalte tidligere
 * `Number(process.env["JARVIS_WATCHDOG_INTERVAL_MS"] ?? 60_000)` og
 * `Number(process.env["JARVIS_COST_HARD_LIMIT_ORE"] ?? 300_000)` UTEN
 * validering. `Number(...)` på en feilformet streng gir `NaN` (aldri en
 * exception) - en `NaN`-hardgrense gjør `spent < hardLimitOre` ALLTID `false`
 * (enhver sammenligning med `NaN` er `false`), slik at `costExplosionCheck`
 * ville forsøke durabel nødstopp ved FØRSTE tick uansett faktisk forbruk -
 * en sikkerhetsmekanisme som stille oversetter feilkonfigurasjon til
 * utilsiktet global nedstenging. Tilsvarende kunne et negativt/null/`NaN`/
 * `Infinity`-intervall gi `setInterval` en utilsiktet stram eller ugyldig
 * løkke. Disse to funksjonene validerer FØR verdien når `setInterval()`
 * eller `costExplosionCheck()` - en eksplisitt oppgitt ugyldig verdi feiler
 * oppstarten synlig (kaster), i stedet for å stille bli en `NaN`/urimelig
 * verdi lenger inn i systemet.
 */
export const WATCHDOG_INTERVAL_MS_DEFAULT = 60_000;
/** Nedre grense (D187 §A): forhindrer at en feilkonfigurert, ekstremt liten
 * verdi skaper en utilsiktet stram overvåkingsløkke (gjentatte DB-spørringer
 * mot `cost_events`/`tasks` hvert millisekund). 1 sekund er godt under
 * `WATCHDOG_INTERVAL_MS_DEFAULT` (60s), men langt over null. */
export const WATCHDOG_INTERVAL_MS_MIN = 1_000;
/** Øvre grense (D187 §A): forhindrer at en feilkonfigurert, ekstremt stor
 * verdi gjør watchdog-en reelt uvirksom (en kostnadseksplosjon eller stuck
 * task ville da kunne stå uoppdaget i timevis). 1 time er en romslig, men
 * fortsatt begrenset, øvre grense for en sikkerhetsovervåker. */
export const WATCHDOG_INTERVAL_MS_MAX = 3_600_000;

/**
 * Validerer `JARVIS_WATCHDOG_INTERVAL_MS` (D187 §A). `raw` er den ubehandlede
 * `process.env["JARVIS_WATCHDOG_INTERVAL_MS"]`-verdien (eller `undefined`
 * hvis usatt). Kaster ved enhver eksplisitt oppgitt, ugyldig verdi -
 * fail-closed oppstart, ALDRI en stille `NaN`/urimelig verdi videre til
 * `setInterval()`.
 */
export function parseWatchdogIntervalMs(raw: string | undefined): number {
  if (raw === undefined) {
    return WATCHDOG_INTERVAL_MS_DEFAULT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `JARVIS_WATCHDOG_INTERVAL_MS ugyldig: "${raw}" - må være et positivt heltall (millisekunder)`
    );
  }
  if (n < WATCHDOG_INTERVAL_MS_MIN || n > WATCHDOG_INTERVAL_MS_MAX) {
    throw new Error(
      `JARVIS_WATCHDOG_INTERVAL_MS utenfor gyldig område [${WATCHDOG_INTERVAL_MS_MIN}, ${WATCHDOG_INTERVAL_MS_MAX}] ms: ${n}`
    );
  }
  return n;
}

/** D-187 §B: samme default som før fiksen (uendret oppførsel når usatt). */
export const COST_HARD_LIMIT_ORE_DEFAULT = 300_000;

/**
 * Validerer `JARVIS_COST_HARD_LIMIT_ORE` (D187 §B). `raw` er den ubehandlede
 * `process.env["JARVIS_COST_HARD_LIMIT_ORE"]`-verdien (eller `undefined`
 * hvis usatt). Kaster ved enhver eksplisitt oppgitt, ugyldig verdi - garanterer
 * at `costExplosionCheck()` ALDRI mottar `NaN`/`Infinity`/negativ/null som
 * `hardLimitOre` (en `NaN`-grense ville gjort `spent < hardLimitOre` ALLTID
 * `false`, og dermed utløst durabel nødstopp ved første tick uansett faktisk
 * forbruk - se filens egen D187-begrunnelse over).
 */
export function parseCostHardLimitOre(raw: string | undefined): number {
  if (raw === undefined) {
    return COST_HARD_LIMIT_ORE_DEFAULT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `JARVIS_COST_HARD_LIMIT_ORE ugyldig: "${raw}" - må være et strengt positivt heltall (øre)`
    );
  }
  return n;
}
