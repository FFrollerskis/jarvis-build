// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import {
  BusinessTenantProvisioningError, previewBusinessTenant, provisionBusinessTenant,
  type BusinessTenantPlan, type BusinessTenantProvisioningReport, type ProvisionBusinessTenantOwner
} from "@jarvis/core";

/**
 * WP-D2 (JARVIS-044/Q-48): selve CLI-logikken for å opprette en bedrifts-tenant på NAS, skilt fra prosess-inngangen
 * (`provision-business-tenant-main.ts`) slik at den kan testes uten å starte en prosess. Autoriteten er den samme som for `enroll-ticket`
 * (D-131): en EKSPLISITT eier-handling på eierens egen maskin med admin-databasetilgang - ikke en nettverksrute.
 *
 * Sikkerhet: UTEN `--confirm <tenant_id>` er kjøringen en DRY-RUN (viser planen, skriver ingenting). `--confirm` må være NØYAKTIG tenant-id-en
 * planen viste (typet bekreftelse, som i dashbord-ruten). Ukjente flagg avvises. Ingen hemmeligheter leses eller skrives.
 */
export interface ProvisionCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ProvisionCliArgs {
  name?: string;
  slug?: string;
  confirm?: string;
}

const FLAGS = new Set(["name", "slug", "confirm"]);

export class ProvisionCliUsageError extends Error {}

export function parseProvisionCliArgs(argv: readonly string[]): ProvisionCliArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new ProvisionCliUsageError(`uventet argument «${token}»`);
    const key = token.slice(2);
    if (!FLAGS.has(key)) throw new ProvisionCliUsageError(`ukjent flagg --${key} (gyldige: --name, --slug, --confirm)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ProvisionCliUsageError(`--${key} mangler verdi`);
    if (key in out) throw new ProvisionCliUsageError(`--${key} er oppgitt flere ganger`);
    out[key] = value;
    i += 1;
  }
  return out as ProvisionCliArgs;
}

function printPlan(io: ProvisionCliIo, plan: BusinessTenantPlan): void {
  io.out("");
  io.out("Plan (ingenting er skrevet ennå):");
  io.out(`  tenant_id:  ${plan.tenant_id}`);
  io.out(`  navn:       ${plan.name}`);
  io.out(`  type:       ${plan.kind}`);
  io.out(`  spaces:     ${plan.memory_spaces.join(", ")}`);
  io.out(`  eier-rolle: ${plan.owner_role}`);
}

function printReport(io: ProvisionCliIo, report: BusinessTenantProvisioningReport): void {
  io.out("");
  io.out(report.idempotent_replay ? "Tenanten fantes allerede - ingenting ble endret (idempotent)." : "Bedrifts-tenant klar:");
  io.out(`  tenant_id:  ${report.tenant_id}`);
  io.out(`  navn:       ${report.name}`);
  io.out(`  opprettet:  tenant=${report.created.tenant} spaces=[${report.created.memory_spaces.join(",")}] medlemskap=${report.created.membership}`);
  io.out(`  fantes fra før: tenant=${report.already_present.tenant} spaces=[${report.already_present.memory_spaces.join(",")}] medlemskap=${report.already_present.membership}`);
  io.out(`  sveipene finner tenanten (jarvis_list_business_tenant_ids): ${report.visible_to_business_sweeps === null ? "kunne ikke kontrolleres" : report.visible_to_business_sweeps}`);
  io.out(`  RLS-bevis: ${report.rls_probe.enforced === true ? "bestått (fremmed kontekst ser 0 rader)" : "ikke vurdert - denne rollen omgår RLS (admin); isolasjonen er bevist av testene, ikke av denne kjøringen"}`);
  io.out("");
  io.out("Dette må DU gjøre etterpå (ingenting av det skjer automatisk):");
  report.owner_actions.forEach((line, i) => io.out(`  ${i + 1}. ${line}`));
  io.out("");
}

/** Returnerer prosessens exit-kode: 0 = ok/dry-run, 2 = feil bruk/ugyldig input, 3 = konflikt/avvist av databasen. */
export async function runProvisionBusinessTenantCli(
  argv: readonly string[],
  owner: ProvisionBusinessTenantOwner,
  pool: pg.Pool,
  io: ProvisionCliIo
): Promise<number> {
  let args: ProvisionCliArgs;
  try {
    args = parseProvisionCliArgs(argv);
  } catch (err) {
    io.err(`${(err as Error).message}`);
    io.err('bruk: provision-business-tenant-main.ts --name "Kundeoppfølging AS" [--slug kundeoppfolging] [--confirm <tenant_id>]');
    return 2;
  }
  if (args.name === undefined) {
    io.err("--name er påkrevd (eieren velger navnet selv - ingenting utledes fra konfig)");
    return 2;
  }
  let plan: BusinessTenantPlan;
  try {
    plan = previewBusinessTenant({ name: args.name, ...(args.slug !== undefined ? { slug: args.slug } : {}) });
  } catch (err) {
    if (err instanceof BusinessTenantProvisioningError) {
      io.err(`ugyldig input: ${err.message}`);
      return 2;
    }
    throw err;
  }
  printPlan(io, plan);
  if (args.confirm === undefined) {
    io.out("");
    io.out(`DRY-RUN: ingenting er skrevet. For å opprette tenanten, kjør samme kommando med  --confirm ${plan.tenant_id}`);
    return 0;
  }
  if (args.confirm !== plan.tenant_id) {
    io.err(`--confirm må være NØYAKTIG tenant-id-en fra planen (${plan.tenant_id}) - ingenting er skrevet`);
    return 2;
  }
  try {
    const report = await provisionBusinessTenant(pool, owner, { name: args.name, ...(args.slug !== undefined ? { slug: args.slug } : {}) }, { via: "cli" });
    printReport(io, report);
    return 0;
  } catch (err) {
    if (err instanceof BusinessTenantProvisioningError) {
      io.err(`avvist: ${err.message} - ingenting er endret`);
      return err.code === "name_invalid" || err.code === "slug_invalid" || err.code === "owner_invalid" ? 2 : 3;
    }
    throw err;
  }
}
