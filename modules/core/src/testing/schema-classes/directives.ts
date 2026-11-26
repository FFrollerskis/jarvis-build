import type { SqlComment } from "./sql-scan.ts";

/**
 * WP-MC8a: annotasjonsformatet i NYE migrasjonsfiler (HF3 §9.2/§17.2, D-MC-34).
 *
 *   -- jarvis-class: <tabell> <KLASSE> [tenant-payload="<begrunnelse>"]
 *   -- jarvis-definer: <navn>(<argumenttyper>) reason="<begrunnelse>"
 *
 * Én `jarvis-class`-linje per `CREATE TABLE` i filen (annotasjonen ligger i selve migrasjonsfilen, aldri i en delt JSON - parallelle pakker
 * får da ingen flettekonflikt). `<KLASSE>` er `GLOBAL`, `USER_OWNED`, `ORG_OWNED` eller `PLATFORM`. `tenant-payload` er kun gyldig for
 * `GLOBAL` og er den eksplisitte, begrunnede tillatelsen til at en global tabell bærer tenant-nyttelast (HF3 §17.2). `jarvis-definer`
 * er allowlist-oppføringen for en `SECURITY DEFINER`-funksjon (default deny); signaturen er Postgres' kanoniske `regprocedure`-tekst.
 *
 * En linje som ligner et direktiv, men ikke følger grammatikken, er en FEIL (aldri stille ignorert).
 */

export const SCHEMA_CLASSES = ["GLOBAL", "USER_OWNED", "ORG_OWNED", "PLATFORM"] as const;
export type SchemaClass = (typeof SCHEMA_CLASSES)[number];

export function isSchemaClass(value: unknown): value is SchemaClass {
  return typeof value === "string" && (SCHEMA_CLASSES as readonly string[]).includes(value);
}

export const MIN_REASON_LENGTH = 10;

export interface ClassDirective {
  readonly kind: "class";
  readonly table: string;
  readonly class: SchemaClass;
  readonly tenantPayload: string | null;
  readonly line: number;
}

export interface DefinerDirective {
  readonly kind: "definer";
  /** Kanonisk signatur, f.eks. `prune_policy_decisions(integer,integer)`. */
  readonly signature: string;
  readonly name: string;
  readonly reason: string;
  readonly line: number;
}

export interface MalformedDirective {
  readonly line: number;
  readonly text: string;
  readonly problem: string;
}

export type Directive = ClassDirective | DefinerDirective;

const INTENT = /^\s*jarvis[-_ ]?(class|definer)\b/i;
const CLASS_LINE = /^\s*jarvis-class:\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+([A-Z_]+)(?:\s+tenant-payload="([^"]*)")?\s*$/;
const DEFINER_LINE = /^\s*jarvis-definer:\s+([a-z_][a-z0-9_]*)\(([^()]*)\)\s+reason="([^"]*)"\s*$/;

/** Normaliserer en funksjonssignatur til Postgres' `regprocedure`-form: små bokstaver, ingen mellomrom. */
export function normalizeSignature(name: string, args: string): string {
  const normalizedArgs = args
    .split(",")
    .map((a) => a.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((a) => a !== "")
    .join(",");
  return `${name.toLowerCase()}(${normalizedArgs})`;
}

export interface ParsedDirectives {
  readonly directives: Directive[];
  readonly malformed: MalformedDirective[];
}

export function parseDirectives(comments: readonly SqlComment[]): ParsedDirectives {
  const directives: Directive[] = [];
  const malformed: MalformedDirective[] = [];
  for (const c of comments) {
    if (!INTENT.test(c.text)) continue;
    const text = c.text.trim();
    const cls = CLASS_LINE.exec(c.text);
    if (cls !== null) {
      const klass = cls[2] as string;
      const payload = cls[3];
      if (!isSchemaClass(klass)) {
        malformed.push({ line: c.line, text, problem: `ukjent klasse '${klass}' (gyldige: ${SCHEMA_CLASSES.join(", ")})` });
        continue;
      }
      if (payload !== undefined && klass !== "GLOBAL") {
        malformed.push({ line: c.line, text, problem: "tenant-payload er kun gyldig for GLOBAL" });
        continue;
      }
      if (payload !== undefined && payload.trim().length < MIN_REASON_LENGTH) {
        malformed.push({ line: c.line, text, problem: `tenant-payload krever en begrunnelse på minst ${MIN_REASON_LENGTH} tegn` });
        continue;
      }
      directives.push({ kind: "class", table: cls[1] as string, class: klass, tenantPayload: payload === undefined ? null : payload.trim(), line: c.line });
      continue;
    }
    const def = DEFINER_LINE.exec(c.text);
    if (def !== null) {
      const reason = (def[3] as string).trim();
      if (reason.length < MIN_REASON_LENGTH) {
        malformed.push({ line: c.line, text, problem: `reason krever en begrunnelse på minst ${MIN_REASON_LENGTH} tegn` });
        continue;
      }
      const name = def[1] as string;
      directives.push({ kind: "definer", signature: normalizeSignature(name, def[2] as string), name, reason, line: c.line });
      continue;
    }
    malformed.push({
      line: c.line,
      text,
      problem: 'følger ikke grammatikken: `-- jarvis-class: <tabell> <GLOBAL|USER_OWNED|ORG_OWNED|PLATFORM> [tenant-payload="..."]` eller `-- jarvis-definer: <navn>(<typer>) reason="..."`'
    });
  }
  return { directives, malformed };
}
