import { businessClassCAdapters } from "@jarvis/business";
import { growthClassCAdapters } from "@jarvis/growth";
import { CLASS_C_PIPELINE_FLAG, createClassCPipeline, defaultClassCAdapters, parseClassCMode, type ClassCPipeline } from "@jarvis/tool-gateway";

/**
 * WP-AUTH2a (JARVIS-014): ÉN felles kobling av klasse C-pipelinen for api OG worker (API/worker-parity: begge kaller denne, ingen kopi). Modus leses fra `JARVIS_CLASS_C_PIPELINE`:
 *   - `off` (standard, tom/usatt og ENHVER ukjent verdi): INGEN option sendes til `ToolGateway` - gatewayen er identisk med main (ukjent verdi meldes høyt, aldri en stille `enforce`);
 *   - `observe` / `enforce`: pipelinen settes sammen av adaptere fra tool-gateway (GitHub, Drive) og fra domenemodulene som eier tilstanden (vekst, forretning).
 * Et adapter-sett for en handling som ikke er registrert i denne prosessen er harmløst (`begin()` engasjerer kun for registrerte klasse C-handlinger med adapter).
 */
export interface ClassCWiring {
  /** Spres inn i `ToolGateway`-options: tom ved modus off. */
  options: { classCPipeline?: ClassCPipeline };
  /** Oppstartslogg (kun navn og modus), eller `null` når pipelinen er av. */
  log: Record<string, unknown> | null;
  /** Sann når flagget hadde en ukjent verdi (tolket som off): meldes med `console.error`. */
  invalid: boolean;
}

export function createClassCWiring(env: Record<string, string | undefined>): ClassCWiring {
  const { mode, invalid } = parseClassCMode(env[CLASS_C_PIPELINE_FLAG]);
  if (invalid) return { options: {}, log: { msg: "class_c_pipeline_mode_invalid", flag: CLASS_C_PIPELINE_FLAG, effective_mode: "off" }, invalid: true };
  if (mode === "off") return { options: {}, log: null, invalid: false };
  const pipeline = createClassCPipeline({ mode, adapters: [...defaultClassCAdapters(), ...growthClassCAdapters(), ...businessClassCAdapters()] });
  return { options: { classCPipeline: pipeline }, log: pipeline.describe(), invalid: false };
}
