import type pg from "pg";
import type { KillSwitch } from "@jarvis/policy";

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

export interface HealthCheck {
  name: string;
  runbook: string;
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

  constructor(
    private readonly alerts: AlertSink,
    private readonly killSwitch: KillSwitch
  ) {}

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Reversibelt tiltak (f.eks. restart av ÉN tjeneste), aldri destruktivt. */
  registerAction(checkName: string, run: () => Promise<void>, maxAttempts = 2): void {
    this.actions.set(checkName, { run, maxAttempts, attempts: 0 });
  }

  /** Sant mens en tick() faktisk kjører - kun til test-/observabilitetsbruk. */
  isTicking(): boolean {
    return this.ticking;
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
      for (const check of this.checks) {
        let result: { ok: boolean; severity: Severity; message: string };
        try {
          result = await check.run();
        } catch (err) {
          result = { ok: false, severity: "critical", message: `sjekk feilet: ${(err as Error).message}` };
        }
        if (result.ok) {
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
        try {
          await this.alerts.send(alert);
        } catch (err) {
          console.error(JSON.stringify({
            msg: "watchdog_alert_delivery_failed", check: check.name, error: (err as Error).message
          }));
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
      return fired;
    } finally {
      this.ticking = false;
    }
  }
}

/** Fastlåste jobber: running med utløpt lease = fastlåst worker (reclaim finnes, men varsle). */
export function stuckTasksCheck(pool: pg.Pool): HealthCheck {
  return {
    name: "stuck_tasks",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker",
    async run() {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()`
      );
      const n = (result.rows[0] as { n: number }).n;
      return n === 0
        ? { ok: true, severity: "info", message: "" }
        : { ok: false, severity: "warning", message: `${n} jobber med utløpt lease` };
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
 */
export function costExplosionCheck(
  pool: pg.Pool,
  killSwitch: KillSwitch,
  ownerPersonId: string,
  hardLimitOre = 300_000
): HealthCheck {
  return {
    name: "cost_explosion",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad",
    async run() {
      const result = await pool.query(
        `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
      );
      const spent = (result.rows[0] as { spent: number }).spent;
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
