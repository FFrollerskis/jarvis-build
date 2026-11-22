import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import { CONNECTOR_REGISTRY, assertSafeVendorUrl, invalidateAllAccessTokenCaches, type ToolDefinition, type ToolGateway, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "./service.ts";

/**
 * K1 (Sovereign graduation, D-164): eierens SAMLEDE kill-switch-/frys-/
 * tilbakekalls-kontrollflate, eksponert som et vanlig ToolGateway-verktøy
 * (`tool_id: "owner_controls"`) - SAMME identitets-/skjema-disiplin som
 * `SituationsTransport` (D-160)/`ExecutiveTransport` (D-162): identitet
 * KOMMER UTELUKKENDE FRA `ToolInvocationContext` (D-68), ALDRI fra
 * `parameters`. `strict()`-skjemaer uten identitetsfelt - en kaller som
 * prøver å oppgi `actor_person_id` selv blir avvist som `invalid_parameters`
 * FØR denne transporten nås. Manglende context feiler lukket
 * (`owner_controls_missing_invocation_context`).
 *
 * Selve autoritets-porten (er kalleren FAKTISK eieren?) håndheves INNI
 * `KillSwitch`/`OwnerControls` sine `*Durable()`-metoder
 * (`assertOwnerControlAuthorized`, samme mønster som `DomainPauseRegistry`)
 * - denne transporten videresender kun `context.identity.person_id`
 * uendret, den fabrikkerer eller eskalerer ALDRI en identitet selv.
 */
export class OwnerControlsTransport implements ToolTransport {
  /**
   * Task #122 (D-213): `gateway` er VALGFRI (samme presedens som
   * `SupportTransport`'s `gateway?: ToolGateway` - se den sitt filhode) -
   * kun `set_connector_credential`/`test_connector` under trenger den
   * (henholdsvis `ToolGateway.setSecret()` og et NØSTET
   * `gateway.execute()`-kall for selve leverandørlesingen). ALDRI en NY,
   * parallell `ToolGateway`-instans - `main.ts`/`worker-main.ts` gir inn
   * DEN SAMME `toolGateway`-instansen resten av appen bruker.
   */
  constructor(
    private readonly service: OwnerControlsService,
    private readonly gateway?: ToolGateway,
    /**
     * Del 3 (JARVIS-037): vertsallowlist for DESTINASJONS-konfig (credential-refs som holder en URL, f.eks. Jira/Grafana/n8n base-URL).
     * Uten allowlist (eller med en vert utenfor den) avvises skrivingen - en lagret URL ville ellers styrt hvor eierens credentials sendes.
     * Mønstre: eksakt vert (`jira.firma.no`) eller `*.firma.no`.
     */
    private readonly destinationHostAllowlist: readonly string[] = []
  ) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.person_id !== "string") {
      throw new Error("owner_controls_missing_invocation_context");
    }
    const actor = identity.person_id;

    switch (action) {
      case "get_control_state": {
        const state = await this.service.getControlState();
        return { data: state as unknown as JsonValue };
      }
      case "activate_kill_switch": {
        await this.service.activateKillSwitch(requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "deactivate_kill_switch": {
        await this.service.deactivateKillSwitch(actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "freeze_connector": {
        await this.service.freezeConnector(requireString(parameters, "connector_id"), requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "unfreeze_connector": {
        await this.service.unfreezeConnector(requireString(parameters, "connector_id"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "revoke_credential": {
        await this.service.revokeCredential(requireString(parameters, "credential_ref"), requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "restore_credential": {
        await this.service.restoreCredential(requireString(parameters, "credential_ref"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "revoke_device": {
        // D-175 (arkitekt-review 5250409538, BLOKKER B4): mål-tenanten er
        // ALLTID `identity.tenant_id` - ALDRI et kaller-oppgitt parameter
        // (skjemaet under har bevisst INGEN `tenant_id`-felt, så et forsøk
        // på å oppgi ett uansett avvises som `invalid_parameters` FØR denne
        // transporten nås). Se service.ts sitt filhode for full begrunnelse.
        if (typeof identity.tenant_id !== "string") {
          throw new Error("owner_controls_missing_invocation_context");
        }
        const result = await this.service.revokeDevice(
          identity.tenant_id,
          requireString(parameters, "device_id"),
          requireString(parameters, "reason"),
          actor
        );
        return { data: result as unknown as JsonValue };
      }
      case "set_connector_credential": {
        // Task #122 (D-213): eierens "lim inn nøkkel"-skrivevei. `credential_ref`
        // MÅ stå i CONNECTOR_REGISTRY sin `credential_refs` for den PÅSTÅTTE
        // `connector_id`-en - dette er BEVISST den ENESTE grensen som hindrer
        // handlingen i å bli en vilkårlig secret-skrive-primitiv (f.eks. et
        // forsøk på å overskrive `JARVIS_BUSINESS_INTERNAL_TOKEN` selv via en
        // uriktig `connector_id`/`credential_ref`-kombinasjon avvises FØR
        // `ToolGateway.setSecret()` i det hele tatt kalles). Selve verdien
        // ekkoes ALDRI tilbake i svaret.
        if (!this.gateway) throw new Error("owner_controls_gateway_not_configured");
        const connectorId = requireString(parameters, "connector_id");
        const credentialRef = requireString(parameters, "credential_ref");
        const value = requireString(parameters, "value");
        const definition = CONNECTOR_REGISTRY.find((c) => c.id === connectorId);
        if (!definition) throw new Error(`unknown_connector:${connectorId}`);
        // WP-C3: også connectorens VALGFRIE refs (GitHub: App-ens privatnøkkel) kan skrives her - fortsatt kun refer som står i registeret.
        if (!definition.credential_refs.includes(credentialRef) && !(definition.optional_credential_refs ?? []).includes(credentialRef)) {
          throw new Error(`credential_ref_not_registered_for_connector:${connectorId}`);
        }
        // D-345: backlog/backlog_d64_gate connectorer har `credential_refs` KUN
        // for synlighet (D-232) - INGEN `ToolTransport` er registrert for dem,
        // så en lagret verdi ville aldri blitt brukt til noe. Avvises HER
        // (ikke bare skjult i dashbordet, apps/web/dashboard.html) slik at
        // ENHVER kaller - dashbordet, en fremtidig API-klient, et rått
        // curl-kall - får et ærlig svar i stedet for et stille no-op-skriv.
        if (definition.category === "backlog" || definition.category === "backlog_d64_gate") {
          throw new Error(`connector_not_built_yet:${connectorId}`);
        }
        if (isDestinationRef(credentialRef)) {
          assertDestinationAllowed(value, this.destinationHostAllowlist);
        }
        await this.gateway.setSecret(credentialRef, value);
        // WP-K review M3d: access-tokens som ble utstedt med den GAMLE konfigurasjonen (klient-id/-secret/refresh-token) skal ikke leve videre i opptil en time etter at eieren har byttet verdien.
        // Bevisst HER (eierens skrivevei) og ikke i `ToolGateway.setSecret()`: den kalles også av refresh-token-`persist` etter hver rotasjon.
        invalidateAllAccessTokenCaches();
        return { data: { connector_id: connectorId, credential_ref: credentialRef, configured: true } as unknown as JsonValue };
      }
      case "test_connector": {
        // Task #122 (D-213): NØSTET `gateway.execute()`-kall mot connectorens
        // registrerte `live_test` (SAMME D-68-mønster som `support.reply` sitt
        // nøstede `email.send`-kall) - `context.identity`/`context.approval`
        // videreformidles UENDRET, ALDRI en fabrikkert/eskalert identitet. Et
        // manglende `live_test` (presence_only-connectorer, D-211/D-213 sitt
        // filhode i connector-registry.ts) er IKKE en feil - en STRUKTURERT,
        // ærlig "kan ikke live-testes"-respons, aldri en kastet feil.
        if (!this.gateway) throw new Error("owner_controls_gateway_not_configured");
        const connectorId = requireString(parameters, "connector_id");
        const definition = CONNECTOR_REGISTRY.find((c) => c.id === connectorId);
        if (!definition) throw new Error(`unknown_connector:${connectorId}`);
        if (!definition.live_test) {
          return {
            data: {
              connector_id: connectorId, test_method: "presence_only", tested: false,
              reason: "live_test_not_available_for_connector"
            } as unknown as JsonValue
          };
        }
        const result = await this.gateway.execute({
          identity,
          ...(context?.approval !== undefined ? { approval: context.approval } : {}),
          tool_id: definition.live_test.tool_id,
          action: definition.live_test.action,
          parameters: definition.live_test.parameters(identity)
        });
        return {
          data: {
            connector_id: connectorId, test_method: "live", tested: true, ok: result.ok,
            ...(!result.ok ? { reason: result.reason } : {})
          } as unknown as JsonValue
        };
      }
      default:
        throw new Error(`unknown_owner_controls_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene. `get_control_state` er klasse A (les - MÅ
 * ALLTID være tilgjengelig, også når kill switch er aktiv - se
 * `PolicyGateway.authorize()` sitt eksplisitte unntak). `activate_kill_switch`/
 * `deactivate_kill_switch` er klasse D (den ENE, mest alvorlige bryteren i
 * hele systemet - blokkerer/gjenåpner ALT, uansett capability-klasse eller
 * tool_id - samme severity-nivå som betaling/sletting/lås/alarm i
 * CapabilityClass sin egen doc). `freeze_connector`/`unfreeze_connector`/
 * `revoke_credential`/`restore_credential` er klasse C (samme nivå som
 * `situations.pause_domain` - en enkelt, navngitt, reversibel begrensning,
 * IKKE systemomfattende). Sovereign eier får INSTANT utførelse for BÅDE C
 * og D (ingen approval-friksjon, masterplanens "one-tap pause/override/
 * revoke") - alle andre identiteter går gjennom vanlig mandat-/godkjennings-
 * logikk i `PolicyGateway.authorize()`, UENDRET av denne pakken.
 *
 * Task #122 (D-213): `set_connector_credential` (klasse C, SAMME nivå som
 * revoke_credential/restore_credential - en enkelt, navngitt credential-
 * tilstandsendring) og `test_connector` (klasse A - en ren, nøstet lesing).
 */
export function ownerControlsToolDefinitions(transport: OwnerControlsTransport): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  return [
    {
      tool_id: "owner_controls", action: "get_control_state",
      description: "Les samlet eier-kontroll-tilstand: kill switch, frosne connectorer, tilbakekalte credentials",
      input_schema: record({}), capability_class: "A", scopes: ["owner_controls.read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "activate_kill_switch",
      description: "Stans HELE systemet umiddelbart, uansett capability-klasse eller tool_id",
      input_schema: record({ reason: z.string() }), capability_class: "D", scopes: ["owner_controls.kill_switch"],
      reversible: true, rollback_procedure: "deactivate_kill_switch", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "deactivate_kill_switch",
      description: "Opphev kill switch og gjenoppta normal drift",
      input_schema: record({}), capability_class: "D", scopes: ["owner_controls.kill_switch"],
      reversible: true, rollback_procedure: "activate_kill_switch", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "freeze_connector",
      description: "Frys ÉN navngitt connector/tool_id umiddelbart",
      input_schema: record({ connector_id: z.string(), reason: z.string() }), capability_class: "C", scopes: ["owner_controls.freeze"],
      reversible: true, rollback_procedure: "unfreeze_connector", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "unfreeze_connector",
      description: "Opphev frys for ÉN navngitt connector/tool_id",
      input_schema: record({ connector_id: z.string() }), capability_class: "C", scopes: ["owner_controls.freeze"],
      reversible: true, rollback_procedure: "freeze_connector", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "revoke_credential",
      description: "Tilbakekall ÉN navngitt credential_ref umiddelbart",
      input_schema: record({ credential_ref: z.string(), reason: z.string() }), capability_class: "C", scopes: ["owner_controls.revoke"],
      reversible: true, rollback_procedure: "restore_credential", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "restore_credential",
      description: "Gjenopprett ÉN navngitt, tidligere tilbakekalt credential_ref",
      input_schema: record({ credential_ref: z.string() }), capability_class: "C", scopes: ["owner_controls.revoke"],
      reversible: true, rollback_procedure: "revoke_credential", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "revoke_device",
      description: "Tilbakekall ALLE utestående session_grants for ÉN navngitt enhet (device_id) i EGEN (identity.tenant_id) tenant umiddelbart - kanonisk SessionGrantService.revokeForDeviceOn(). Enheten kan tilhøre en ANNEN person (delegat) i SAMME tenant; en enhet i en ANNEN tenant finnes ikke fra dette kallets perspektiv (D-175)",
      input_schema: record({ device_id: z.string(), reason: z.string() }), capability_class: "C", scopes: ["owner_controls.device"],
      reversible: false, rollback_procedure: "enheten må re-rulleres inn (enrollment) for ny tilgang - ingen restore_device", idempotent_external: true, ...common
    },
    {
      // Task #122 (D-213): klasse C - SAMME nivå som revoke_credential/
      // restore_credential over (en enkelt, navngitt, reversibel credential-
      // tilstandsendring for ÉN connector, IKKE systemomfattende). Verdien
      // logges/auditeres ALDRI (se ToolGateway.execute() sin audit-payload -
      // rå `parameters` er ALDRI en del av den). `reversible: false` er
      // ÆRLIG: en ny verdi kan overskrives på nytt, men Jarvis lagrer ALDRI
      // forrige verdi selv - en reell reversering krever at EIEREN selv har
      // den gamle verdien og limer den inn på nytt.
      tool_id: "owner_controls", action: "set_connector_credential",
      description: "Skriv en NY verdi for én navngitt connector-credential (CONNECTOR_REGISTRY) til den skrivbare secret-provideren (Infisical) - verdien returneres/logges ALDRI",
      input_schema: record({ connector_id: z.string(), credential_ref: z.string(), value: z.string() }),
      capability_class: "C", scopes: ["owner_controls.connector_credentials"],
      reversible: false, rollback_procedure: "lim inn tidligere verdi på nytt (om eieren har den) - Jarvis lagrer aldri forrige verdi selv", idempotent_external: true, ...common
    },
    {
      // Klasse A: dette er en nøstet gateway.execute()-komposisjon mot
      // connectorens EGEN, allerede klasse A-klassifiserte live_test-lesing
      // (D-211/D-213) - samme risikonivå som get_control_state over.
      tool_id: "owner_controls", action: "test_connector",
      description: "Test at én navngitt connector faktisk fungerer (nøstet kall mot dens registrerte live_test-lesing) - presence_only-connectorer gir en strukturert 'kan ikke live-testes'-respons, aldri en feil",
      input_schema: record({ connector_id: z.string() }), capability_class: "A", scopes: ["owner_controls.connector_credentials"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
    }
  ];
}


/** Credential-refs som holder en destinasjon (URL), ikke en hemmelighet - styrer HVOR eierens credentials sendes. */
export function isDestinationRef(ref: string): boolean {
  return /(?:_|^)(?:BASE_URL|SERVER_URL|URL|ENDPOINT|HOST|WEBHOOK)$/i.test(ref);
}

/** Del 3 (JARVIS-037): destinasjons-URL må være en ren https-URL hvis vert står på eierens allowlist. Tom allowlist = lukket. */
export function assertDestinationAllowed(value: string, allowlist: readonly string[]): void {
  if (allowlist.length === 0) throw new Error("destination_host_allowlist_not_configured");
  let safe: string;
  try {
    safe = assertSafeVendorUrl(value);
  } catch {
    throw new Error("destination_url_unsafe");
  }
  const url = new URL(safe);
  if (url.protocol !== "https:") throw new Error("destination_url_must_be_https");
  const host = url.hostname.toLowerCase();
  const allowed = allowlist.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    return host === pattern;
  });
  if (!allowed) throw new Error("destination_host_not_allowlisted");
}
