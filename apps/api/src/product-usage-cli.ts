// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import {
  ProductUsageError, ProductUsageService, USAGE_LIMITS, UsageImportError, fileUsageSource, isPseudonymousRef,
  type IngestSummary, type ParsedUsageBatch, type UsageFileFormat
} from "@jarvis/business";

/**
 * WP-D2 (UA-3 «churn/product usage»): eierens CLI for produktbruk - CSV/JSONL-import, oversikt over kontoer, kobling konto -> selskap og «glem bruker». Selve logikken er skilt fra
 * prosess-inngangen (`product-usage-main.ts`) slik at den kan testes uten å starte en prosess. Kjører som RUNTIME-rollen (RLS håndheves, CHECK-ene i 090 gjelder) - aldri admin.
 *
 * Sikkerhet: alt som skriver er en DRY-RUN uten `--confirm` (viser hva som ville skjedd, skriver ingenting). Ukjente flagg/kommandoer avvises. Filinnholdet leses fra STDIN
 * (ingen filstier fra brukeren => ingen path traversal; ingen volummontering i containeren). Kun pseudonyme referanser godtas (samme regler som webhooken). Ingen
 * hemmeligheter leses eller skrives; utdata ekkoer aldri hendelsesinnhold utover pseudonyme id-er eieren selv har levert.
 */
export interface UsageCliIo {
  out(line: string): void;
  err(line: string): void;
  /** Leser hele stdin (maks `maxBytes`; mer => `file_too_large`). */
  readStdin(maxBytes: number): Promise<string>;
}

export class UsageCliUsageError extends Error {}

const VALUE_FLAGS = new Set(["tenant", "format", "label", "account", "company", "user"]);
const BOOLEAN_FLAGS = new Set(["confirm", "linked", "unlinked"]);
const COMMANDS = ["import", "accounts", "link", "unlink", "forget-user"] as const;
type Command = (typeof COMMANDS)[number];

export interface UsageCliArgs {
  command: Command;
  flags: Record<string, string>;
  confirm: boolean;
  linked?: boolean;
}

export function parseUsageCliArgs(argv: readonly string[]): UsageCliArgs {
  const [command, ...rest] = argv;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) throw new UsageCliUsageError(`ukjent kommando «${command ?? ""}» (gyldige: ${COMMANDS.join(", ")})`);
  const flags: Record<string, string> = {};
  let confirm = false;
  let linked: boolean | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) throw new UsageCliUsageError(`uventet argument «${token}»`);
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (key === "confirm") { if (confirm) throw new UsageCliUsageError("--confirm er oppgitt flere ganger"); confirm = true; }
      else {
        if (linked !== undefined) throw new UsageCliUsageError("bruk enten --linked eller --unlinked, én gang");
        linked = key === "linked";
      }
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageCliUsageError(`ukjent flagg --${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageCliUsageError(`--${key} mangler verdi`);
    if (key in flags) throw new UsageCliUsageError(`--${key} er oppgitt flere ganger`);
    flags[key] = value;
    i += 1;
  }
  return { command: command as Command, flags, confirm, ...(linked !== undefined ? { linked } : {}) };
}

const TENANT_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function need(args: UsageCliArgs, flag: string, io: UsageCliIo): string | undefined {
  const v = args.flags[flag];
  if (v === undefined) io.err(`--${flag} er påkrevd`);
  return v;
}

function printSummary(io: UsageCliIo, s: IngestSummary): void {
  io.out(`  mottatt (gyldige, distinkte): ${s.received}`);
  io.out(`  lagret nå:                    ${s.inserted}`);
  io.out(`  allerede lagret (duplikater): ${s.duplicates}`);
  io.out(`  konflikt (samme id, annet innhold - IKKE anvendt): ${s.conflicts}`);
  io.out(`  avvist:                       ${s.rejected}`);
  io.out(`  kontoer: ${s.accounts_seen} (nye: ${s.new_accounts})`);
  for (const r of s.rejected_detail) io.out(`    avvist #${r.position}: ${r.reason}`);
  if (s.rejected > s.rejected_detail.length) io.out(`    … og ${s.rejected - s.rejected_detail.length} til`);
}

function describeBatch(io: UsageCliIo, batch: ParsedUsageBatch): void {
  const accounts = new Set(batch.accepted.map((e) => e.account_ref));
  const times = batch.accepted.map((e) => e.occurred_at).sort();
  io.out(`  gyldige hendelser: ${batch.accepted.length} (kontoer: ${accounts.size})`);
  if (times.length > 0) io.out(`  tidsrom: ${times[0]} .. ${times[times.length - 1]}`);
  io.out(`  avvist: ${batch.rejected.length}`);
  for (const r of batch.rejected.slice(0, 20)) io.out(`    avvist #${r.position}: ${r.reason}`);
  if (batch.rejected.length > 20) io.out(`    … og ${batch.rejected.length - 20} til`);
}

/** Returnerer prosessens exit-kode: 0 = ok/dry-run, 2 = feil bruk/ugyldig input, 3 = avvist av databasen/konflikt. */
export async function runProductUsageCli(
  argv: readonly string[],
  owner: { owner_person_id: string },
  pool: pg.Pool,
  io: UsageCliIo,
  nowMs: number = Date.now()
): Promise<number> {
  let args: UsageCliArgs;
  try {
    args = parseUsageCliArgs(argv);
  } catch (err) {
    io.err((err as Error).message);
    io.err("bruk: product-usage-main.ts <import|accounts|link|unlink|forget-user> --tenant <tenant-id> [...] [--confirm]");
    return 2;
  }
  const tenant = need(args, "tenant", io);
  if (tenant === undefined) return 2;
  if (!TENANT_RE.test(tenant)) { io.err("ugyldig --tenant (a-z, 0-9, bindestrek og understrek, 2-64 tegn)"); return 2; }
  const svc = new ProductUsageService(pool);
  const actor = owner.owner_person_id;

  try {
    switch (args.command) {
      case "import": {
        const format = need(args, "format", io);
        const label = need(args, "label", io);
        if (format === undefined || label === undefined) return 2;
        if (format !== "csv" && format !== "jsonl") { io.err("--format må være csv eller jsonl"); return 2; }
        const source = fileUsageSource(format as UsageFileFormat, label);
        let text: string;
        try {
          text = await io.readStdin(USAGE_LIMITS.import_max_bytes);
        } catch {
          io.err(`filen er for stor eller kunne ikke leses (maks ${USAGE_LIMITS.import_max_bytes / (1024 * 1024)} MiB)`);
          return 2;
        }
        if (text.trim() === "") { io.err("tom inndata (send filen på stdin: ... < fil.csv)"); return 2; }
        const batch = source.parse(text, nowMs);
        io.out(`Produktbruk-import til ${tenant} (${source.source_id}, ${format}):`);
        describeBatch(io, batch);
        if (!args.confirm) {
          io.out("");
          io.out("DRY-RUN: ingenting er skrevet. Kjør samme kommando med  --confirm  for å lagre.");
          return 0;
        }
        const summary = await svc.ingest(tenant, source, batch, { via: "import", actor_person_id: actor });
        io.out("");
        io.out("Lagret:");
        printSummary(io, summary);
        if (summary.conflicts > 0) { io.err("noen hendelses-id-er finnes fra før med ANNET innhold og ble ikke anvendt - sjekk avsenderens id-bruk"); return 3; }
        return 0;
      }
      case "accounts": {
        const rows = await svc.listAccounts(tenant, "business", { ...(args.linked !== undefined ? { linked: args.linked } : {}), limit: 200 });
        io.out(`Kontoer i ${tenant}${args.linked === true ? " (koblet)" : args.linked === false ? " (ikke koblet)" : ""}: ${rows.length}`);
        for (const r of rows) io.out(`  ${r.account_ref}  selskap=${r.company_id ?? "-"}  siste hendelse=${r.last_event_at ? new Date(r.last_event_at).toISOString() : "-"}`);
        return 0;
      }
      case "link": {
        const account = need(args, "account", io);
        const company = need(args, "company", io);
        if (account === undefined || company === undefined) return 2;
        if (!isPseudonymousRef(account)) { io.err("--account må være en pseudonym referanse (ikke e-post/telefon/IP)"); return 2; }
        if (!args.confirm) {
          io.out(`DRY-RUN: ville koblet konto ${account} til selskap ${company} i ${tenant}. Kjør med --confirm for å lagre.`);
          return 0;
        }
        const r = await svc.linkAccount(tenant, "business", account, company, actor);
        io.out(r.changed ? `Koblet ${account} til ${company}${r.previous_company_id ? ` (var ${r.previous_company_id})` : ""}.` : "Allerede koblet - ingenting endret.");
        return 0;
      }
      case "unlink": {
        const account = need(args, "account", io);
        if (account === undefined) return 2;
        if (!isPseudonymousRef(account)) { io.err("--account må være en pseudonym referanse"); return 2; }
        if (!args.confirm) { io.out(`DRY-RUN: ville fjernet koblingen for ${account} i ${tenant} (vurdering og churn-loop forsvinner). Kjør med --confirm.`); return 0; }
        const r = await svc.unlinkAccount(tenant, "business", account, actor);
        io.out(r.changed ? `Koblingen for ${account} er fjernet.` : "Kontoen var ikke koblet - ingenting endret.");
        return 0;
      }
      case "forget-user": {
        const user = need(args, "user", io);
        if (user === undefined) return 2;
        if (!isPseudonymousRef(user)) { io.err("--user må være en pseudonym referanse"); return 2; }
        if (!args.confirm) { io.out(`DRY-RUN: ville nullet user_ref «${user}» på alle hendelser i ${tenant} (volum per konto beholdes). Kjør med --confirm.`); return 0; }
        const n = await svc.forgetUserRef(tenant, "business", user, actor);
        io.out(`Glemt: ${n} hendelser fikk user_ref nullet.`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof UsageImportError) { io.err(`ugyldig fil: ${err.message}`); return 2; }
    if (err instanceof ProductUsageError) {
      io.err(`avvist: ${err.message} - ingenting er endret`);
      return err.code === "invalid_input" ? 2 : 3;
    }
    throw err;
  }
}
