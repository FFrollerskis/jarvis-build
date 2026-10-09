import type pg from "pg";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";
import { listBusinessTenantIds } from "./tenant-catalog.ts";

/**
 * WP-D2 (JARVIS-044 / Q-44 / Q-48, mandat D-450): EIER-INITIERT, IDEMPOTENT provisjonering av en bedrifts-tenant.
 *
 * PROBLEMET (D-396): seeden lager kun en `person`-tenant og ett `personal`-space, mens ALLE business-/situasjonssveip enumererer `kind='business'`
 * (`listBusinessTenantIds`) - så hvert sveip er en no-op på NAS til noen oppretter en business-tenant. D-396 la til en synlig advarsel
 * (`business_sweeps_no_business_tenants`) men BEVISST ingen automatikk: hvilken tenant som er «business» er en topologibeslutning (Q-44/Q-48) som
 * kun Tobias tar. Denne tjenesten er derfor ALDRI koblet til oppstart, seed eller migrering - den kjøres bare av to eier-veier:
 *   (a) dashbord-ruten `POST /owner/business-tenants` (eier-grant + step-up + typet bekreftelse, bak `JARVIS_BUSINESS_TENANT_PROVISIONING`), og
 *   (b) NAS-CLI-en `apps/api/src/provision-business-tenant-main.ts` (admin-DB-tilgang = eierens egen vertshandling, som `enroll-ticket`).
 * Den er ALDRI et modellverktøy (ingen `ToolDefinition`, ikke i `CHAT_ACT_TIER`).
 *
 * Hva som opprettes (alt i ÉN transaksjon, alt `ON CONFLICT DO NOTHING` -> samme slug/navn gir samme tenant, aldri duplikater):
 *   - `tenants(kind='business')`,
 *   - `memory_spaces` for `business` og `project` (TENANT_MODEL.md §1),
 *   - `person_tenants(role='owner')` for eieren,
 *   - to audit-rader (i den nye tenanten og i eierens primære tenant).
 * «Standard RLS-roller/grants» er ikke per tenant: RLS er GUC-basert (`jarvis.tenant_id`) og GRANT-ene til `jarvis_app` er globale (005_rls.sql), så en
 * ny tenant arver dem uten å opprette noe. Rapporten BEVISER i stedet isolasjonen (fremmed kontekst ser 0 rader) når rollen faktisk håndhever RLS.
 *
 * Det tenant-provisjonering IKKE gjør (eierens valg, Q-48 C): den utvider ikke `owner_tenants` i `credentialBinding`/`PolicyGateway`, den innrullerer ingen
 * enhet og den gir ingen bakgrunnsjobb tilgang til eierens Google-konto. `ownerActionsFor()` lister nøyaktig hva eieren selv må gjøre etterpå.
 */

/** Space-ene en bedrifts-tenant får (TENANT_MODEL.md §1: «business, project, shared» - `shared` krever eksplisitt deling og opprettes ikke implisitt). */
export const BUSINESS_TENANT_SPACES = ["business", "project"] as const;
export const BUSINESS_TENANT_OWNER_ROLE = "owner";
export const BUSINESS_TENANT_ID_PREFIX = "tenant-";

/** Samme mønster som `OwnerConfig` (contracts/owner-config.ts): `[a-z0-9][a-z0-9_-]{1,63}`. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
/** 2-48 tegn, a-z0-9 og bindestrek, aldri bindestrek først/sist; `tenant-` + slug blir maks 55 tegn (< 64). */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])$/;
const MAX_NAME_LENGTH = 80;

export type BusinessTenantProvisioningErrorCode =
  | "name_invalid"
  | "slug_invalid"
  | "owner_invalid"
  | "tenant_exists_with_other_kind"
  | "tenant_name_mismatch"
  | "owner_person_not_found";

export class BusinessTenantProvisioningError extends Error {
  constructor(readonly code: BusinessTenantProvisioningErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BusinessTenantProvisioningError";
  }
}

export interface ProvisionBusinessTenantInput {
  /** Visningsnavn, f.eks. «Kundeoppfølging AS». Eieren velger selv - ingenting utledes fra konfig. */
  name: string;
  /** Valgfri slug. Utledes ellers deterministisk fra navnet (`deriveBusinessTenantSlug`). tenant_id = `tenant-<slug>`. */
  slug?: string;
}

export interface ProvisionBusinessTenantOwner {
  owner_person_id: string;
  /** Eierens primære tenant (`JARVIS_TENANT_ID`) - får en egen audit-rad om hvem som opprettet den nye tenanten. */
  owner_tenant_id: string;
}

export interface ProvisionBusinessTenantOptions {
  /** Hvilken eier-vei som kjørte handlingen - kun for revisjonssporet. */
  via: "dashboard" | "cli";
  session_id?: string;
  device_id?: string;
}

/** Ren forhåndsvisning (ingen DB): hva som VILLE blitt opprettet. Brukes av dry-run og av den typede bekreftelsen. */
export interface BusinessTenantPlan {
  tenant_id: string;
  name: string;
  slug: string;
  kind: "business";
  memory_spaces: readonly string[];
  owner_role: string;
}

export interface BusinessTenantProvisioningReport extends BusinessTenantPlan {
  /** `true` når ALT allerede fantes (en gjentatt kjøring endret ingenting). */
  idempotent_replay: boolean;
  created: { tenant: boolean; memory_spaces: string[]; membership: boolean };
  already_present: { tenant: boolean; memory_spaces: string[]; membership: boolean };
  /** Bevist ETTER commit: `jarvis_list_business_tenant_ids()` (det sveipene bruker) finner tenanten. `null` = kunne ikke kontrolleres. */
  visible_to_business_sweeps: boolean | null;
  /** Isolasjonsbevis fra en FREMMED tenant-kontekst. `enforced: false` = rollen omgår RLS (admin/CLI) og beviset sier ingenting. */
  rls_probe: { enforced: boolean | null; foreign_context_rows: { tenants: number; memory_spaces: number; person_tenants: number } | null; own_context_rows: { tenants: number; memory_spaces: number; person_tenants: number } | null };
  /** Nøyaktig hva eieren selv må gjøre/sette etterpå (Q-44/Q-48 er topologivalg, ikke noe denne tjenesten avgjør). */
  owner_actions: string[];
}

const COMBINING_MARKS = /[̀-ͯ]/g;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f<>]/;

/** Normaliserer visningsnavnet (NFC, trim, enkle mellomrom) og avviser kontrolltegn/`<>`/for kort/for langt. */
export function normalizeBusinessTenantName(raw: unknown): string {
  if (typeof raw !== "string") throw new BusinessTenantProvisioningError("name_invalid", "navn må være tekst");
  // Kontrolltegn (inkl. tab/linjeskift) avvises FØR mellomrom slås sammen - et linjeskift i et navn er aldri tilfeldig (logg-/header-injeksjon).
  if (FORBIDDEN_NAME_CHARS.test(raw)) throw new BusinessTenantProvisioningError("name_invalid", "navn kan ikke inneholde kontrolltegn, < eller >");
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) throw new BusinessTenantProvisioningError("name_invalid", `navn må være 2-${MAX_NAME_LENGTH} tegn`);
  return name;
}

/**
 * Deterministisk slug fra et navn: norske bokstaver translittereres (æ->ae, ø->o, å->a), diakritikk strippes, alt annet enn a-z0-9 blir bindestrek.
 * Ingen firmaendelse-magi («AS» beholdes): «Kundeoppfølging AS» -> `kundeoppfolging-as`. Vil eieren ha `kundeoppfolging`, oppgir hen slug selv.
 */
export function deriveBusinessTenantSlug(name: string): string {
  const base = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss")
    .normalize("NFKD").replace(COMBINING_MARKS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!SLUG_PATTERN.test(base)) throw new BusinessTenantProvisioningError("slug_invalid", "kunne ikke utlede en gyldig slug fra navnet - oppgi slug eksplisitt (a-z, 0-9 og bindestrek, 2-48 tegn)");
  return base;
}

/** Ren plan (ingen DB). Slug oppgitt av eieren valideres STRENGT (ingen stille retting). */
export function previewBusinessTenant(input: ProvisionBusinessTenantInput): BusinessTenantPlan {
  const name = normalizeBusinessTenantName(input.name);
  let slug: string;
  if (input.slug === undefined) {
    slug = deriveBusinessTenantSlug(name);
  } else {
    if (typeof input.slug !== "string" || !SLUG_PATTERN.test(input.slug)) {
      throw new BusinessTenantProvisioningError("slug_invalid", "slug må være 2-48 tegn av a-z, 0-9 og bindestrek (ikke bindestrek først/sist)");
    }
    slug = input.slug;
  }
  const tenant_id = `${BUSINESS_TENANT_ID_PREFIX}${slug}`;
  if (!ID_PATTERN.test(tenant_id)) throw new BusinessTenantProvisioningError("slug_invalid", "tenant_id ble ugyldig");
  return { tenant_id, name, slug, kind: "business", memory_spaces: BUSINESS_TENANT_SPACES, owner_role: BUSINESS_TENANT_OWNER_ROLE };
}

/**
 * Det eieren selv må gjøre/sette ETTER provisjonering. Ren funksjon - dokumentasjonen (runbook), CLI-en og dashbord-svaret bruker SAMME tekst.
 * Ingenting herfra gjøres automatisk (Q-48 C: «la stå til tenant-topologien er besluttet»).
 */
export function ownerActionsFor(tenantId: string): string[] {
  return [
    `Eier-autoritet i den nye tenanten er IKKE gitt av dette steget. For at du som eier skal være suveren og kunne bruke eier-tilkoblede connectorer (Gmail, Kalender, GitHub …) i ${tenantId}: sett JARVIS_OWNER_EXTRA_TENANTS=${tenantId} i .env (api OG worker) og start dem på nytt. Uten den gjelder eier-autoriteten kun i JARVIS_TENANT_ID.`,
    `Chat/dashbord i ${tenantId} krever en innrullert enhet i tenanten: ops/nas/enroll-device.sh <https-adresse> dashboard ${tenantId}. Enheter er per tenant.`,
    `Planlagte jobber (business-events-sync, conversation-graph-sync, support-inbox-sync) kaller Gmail/Kalender som «system» og avvises med credential_not_bound_to_identity inntil du velger A eller B i Q-48. De vises som feilet (D-442/D-443) - det er ærlig, ikke en feil i provisjoneringen.`,
    `Produktbruk-kilden (webhook/import) er av: sett JARVIS_PRODUCT_USAGE_TENANT_ID=${tenantId} og JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET (eller bruk CSV/JSONL-importen) når du vil ta den i bruk.`,
    `Sveipene (open loops, scoring, brief, finans, vekst) finner tenanten ved neste kjøring; den starter tom - opprett selskaper/kontakter/leads via dashbordet eller chatten (bak bekreftelse).`
  ];
}

interface Counts { tenants: number; memory_spaces: number; person_tenants: number }

async function countRows(client: pg.PoolClient, tenantId: string): Promise<Counts> {
  const q = async (table: string): Promise<number> =>
    Number(((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0] as { n: number }).n);
  return { tenants: await q("tenants"), memory_spaces: await q("memory_spaces"), person_tenants: await q("person_tenants") };
}

/**
 * Oppretter (eller bekrefter) bedrifts-tenanten. Kaster `BusinessTenantProvisioningError` ved ugyldig input, konflikt (samme id med annen type/annet navn) eller
 * ukjent eier. Alt-eller-ingenting: feiler noe underveis (f.eks. ukjent eier-person), rulles HELE transaksjonen tilbake - ingen halv tenant.
 */
export async function provisionBusinessTenant(
  pool: pg.Pool,
  owner: ProvisionBusinessTenantOwner,
  input: ProvisionBusinessTenantInput,
  options: ProvisionBusinessTenantOptions
): Promise<BusinessTenantProvisioningReport> {
  if (!ID_PATTERN.test(owner.owner_person_id) || !ID_PATTERN.test(owner.owner_tenant_id)) throw new BusinessTenantProvisioningError("owner_invalid", "ugyldig eier-id");
  const plan = previewBusinessTenant(input);
  const subject = {
    person_id: owner.owner_person_id,
    ...(options.session_id !== undefined ? { session_id: options.session_id } : {}),
    ...(options.device_id !== undefined ? { device_id: options.device_id } : {})
  };

  let outcome: { created: BusinessTenantProvisioningReport["created"]; already: BusinessTenantProvisioningReport["already_present"] };
  try {
    outcome = await withTenantTransaction(pool, plan.tenant_id, async (client) => {
      // RLS (`tenants_self`) krever at jarvis.tenant_id er den NYE tenantens id for at INSERT-en skal passere WITH CHECK - derfor kjøres hele transaksjonen i den konteksten.
      const insertedTenant = await client.query(
        "INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $2, 'business') ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id",
        [plan.tenant_id, plan.name]
      );
      const tenantCreated = insertedTenant.rowCount === 1;
      if (!tenantCreated) {
        const existing = (await client.query("SELECT name, kind FROM tenants WHERE tenant_id = $1", [plan.tenant_id])).rows[0] as { name: string; kind: string } | undefined;
        if (!existing) throw new BusinessTenantProvisioningError("tenant_exists_with_other_kind", "tenant_id er i bruk, men raden er ikke synlig");
        if (existing.kind !== "business") throw new BusinessTenantProvisioningError("tenant_exists_with_other_kind", `${plan.tenant_id} finnes allerede som «${existing.kind}»`);
        // Samme slug, annet navn: stille omdøping eller stille gjenbruk begge er feil - eieren velger et nytt navn/en ny slug eller bekrefter det eksisterende navnet.
        if (existing.name !== plan.name) throw new BusinessTenantProvisioningError("tenant_name_mismatch", `${plan.tenant_id} finnes allerede med navnet «${existing.name}»`);
      }

      const spacesCreated: string[] = [];
      const spacesPresent: string[] = [];
      for (const space of BUSINESS_TENANT_SPACES) {
        const r = await client.query(
          "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, space) DO NOTHING RETURNING space",
          [`ms-${plan.tenant_id}-${space}`, plan.tenant_id, space]
        );
        (r.rowCount === 1 ? spacesCreated : spacesPresent).push(space);
      }

      const membership = await client.query(
        "INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, $3) ON CONFLICT (person_id, tenant_id) DO NOTHING RETURNING person_id",
        [owner.owner_person_id, plan.tenant_id, BUSINESS_TENANT_OWNER_ROLE]
      );
      const membershipCreated = membership.rowCount === 1;

      const created = { tenant: tenantCreated, memory_spaces: spacesCreated, membership: membershipCreated };
      const already = { tenant: !tenantCreated, memory_spaces: spacesPresent, membership: !membershipCreated };
      const replay = !tenantCreated && spacesCreated.length === 0 && !membershipCreated;
      const payload = { tenant_id: plan.tenant_id, name: plan.name, slug: plan.slug, spaces: [...BUSINESS_TENANT_SPACES], via: options.via, created, already_present: already };
      const type = replay ? "tenant.business_provision_replayed" : "tenant.business_provisioned";
      await writeAudit(client, { ...subject, tenant_id: plan.tenant_id }, { type, decision: "ALLOW", payload: { ...payload, scope: "new_tenant" } });
      if (owner.owner_tenant_id !== plan.tenant_id) {
        // Samme transaksjon, ny RLS-kontekst: sporet om HVEM som opprettet tenanten skal også ligge i eierens egen tenant (der eieren leser revisjonen sin).
        await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [owner.owner_tenant_id]);
        await writeAudit(client, { ...subject, tenant_id: owner.owner_tenant_id }, { type, decision: "ALLOW", payload: { ...payload, scope: "owner_tenant" } });
      }
      return { created, already };
    });
  } catch (err) {
    // FK-brudd på person_tenants.person_id: eier-personen finnes ikke i `people`. Hele transaksjonen er rullet tilbake (ingen halv tenant).
    if ((err as { code?: string }).code === "23503" && /person_tenants/.test(String((err as { constraint?: string; table?: string }).constraint ?? (err as { table?: string }).table ?? ""))) {
      throw new BusinessTenantProvisioningError("owner_person_not_found", "eier-personen finnes ikke i people (kjør migrate/seed med riktig JARVIS_OWNER_PERSON_ID)");
    }
    throw err;
  }

  // Bevis ETTER commit (ikke inne i transaksjonen): det sveipene faktisk ser, og det en fremmed tenant-kontekst faktisk ser.
  let visible: boolean | null = null;
  try {
    visible = (await listBusinessTenantIds(pool, 1000)).includes(plan.tenant_id);
  } catch {
    visible = null;
  }
  const rls = await probeRls(pool, plan.tenant_id, owner.owner_tenant_id);
  const replay = !outcome.created.tenant && outcome.created.memory_spaces.length === 0 && !outcome.created.membership;
  return { ...plan, idempotent_replay: replay, created: outcome.created, already_present: outcome.already, visible_to_business_sweeps: visible, rls_probe: rls, owner_actions: ownerActionsFor(plan.tenant_id) };
}

async function probeRls(pool: pg.Pool, tenantId: string, ownerTenantId: string): Promise<BusinessTenantProvisioningReport["rls_probe"]> {
  try {
    const foreignTenant = ownerTenantId !== tenantId ? ownerTenantId : `${tenantId}-probe`;
    const own = await withTenantTransaction(pool, tenantId, (client) => countRows(client, tenantId));
    const { foreign, bypass } = await withTenantTransaction(pool, foreignTenant, async (client) => {
      const role = (await client.query("SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user")).rows[0] as { bypass: boolean } | undefined;
      return { foreign: await countRows(client, tenantId), bypass: role?.bypass ?? true };
    });
    return { enforced: !bypass, foreign_context_rows: foreign, own_context_rows: own };
  } catch {
    return { enforced: null, foreign_context_rows: null, own_context_rows: null };
  }
}
