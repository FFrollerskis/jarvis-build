/**
 * WP-D4 (gjennomgang av PR #315, M3): eierens erklæring om hvilke leverandører som er LIVE-verifisert for verktøykall (og Kimi for streaming) etter `mesh-live-smoke.ts --tools`.
 *
 * Registeret påstår at Kimi og Hermes kan verktøykall (Kimi også streaming), og det er bevist mot fake servere - men aldri mot de ekte leverandørene (ingen nøkler i bygg-miljøet). Uten denne erklæringen skal AUTO-ruting
 * derfor IKKE velge dem for verktøyløkker/streaming (de rangerte høyt: lokal > hermes > kimi > openai > anthropic). Eksplisitte valg påvirkes ikke.
 *
 *  - `JARVIS_MESH_TOOLS_VERIFIED` = kommaseparert liste av leverandørnavn (`kimi`, `hermes`). Tom/usatt = ingen (standard, trygt).
 *  - Ugyldig verdi (tegn utenfor `a-z0-9_`, tomme ledd, over 16 medlemmer) = TOM liste og en logglinje (fail-closed: en skrivefeil aktiverer aldri noe). Aldri en halvparset liste.
 *  - Eieren setter variabelen KUN etter at `--tools` ga `TOOL_CALL_OK`/`ROUNDTRIP_OK` (og `STREAM_TOOL_CALL_OK` for streaming) for leverandøren (docs/runbooks/AI_MESH_ACCEPTANCE.md).
 */
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_MEMBERS = 16;

export interface ParsedMeshToolsVerified {
  providers: ReadonlySet<string>;
  /** `false` når verdien var ugyldig (da er `providers` tom). */
  valid: boolean;
}

export function parseMeshToolsVerified(raw: string | undefined): ParsedMeshToolsVerified {
  const listed = (raw ?? "").trim();
  if (listed === "") return { providers: new Set(), valid: true };
  const names = listed.split(",").map((n) => n.trim());
  if (names.some((n) => !NAME.test(n)) || new Set(names).size > MAX_MEMBERS) return { providers: new Set(), valid: false };
  return { providers: new Set(names), valid: true };
}

/** Leser `JARVIS_MESH_TOOLS_VERIFIED` fra miljøet. Ugyldig verdi gir en tom liste og en logglinje (aldri verdien selv). */
export function meshToolsVerifiedFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ReadonlySet<string> {
  const parsed = parseMeshToolsVerified(env["JARVIS_MESH_TOOLS_VERIFIED"]);
  if (!parsed.valid) {
    console.error(JSON.stringify({ msg: "mesh_tools_verified_invalid", reason: "forventet kommaseparerte leverandørnavn (a-z, 0-9, _), maks 16", fallback: "ingen verifisert" }));
  }
  return parsed.providers;
}
