import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PERSONALITY_CONFIG,
  PersonalityConfigSchema,
  type PersonalityConfig
} from "@jarvis/self-modification";

/**
 * Task #121 (D-214): repo-rot `config/charlie-personality.json` - den ENESTE
 * filen `self_modification.propose_personality_change` kan auto-merge uten
 * eiergjennomgang. Lastes FRISK fra disk på hver samtale (billig, liten fil)
 * slik at en auto-merget endring slår inn med en gang, uten omstart av
 * prosessen - fail-closed til `DEFAULT_PERSONALITY_CONFIG` på ENHVER
 * lese-/parse-/valideringsfeil (manglende fil, ugyldig JSON, feil skjema)
 * slik at en korrupt/delvis-skrevet konfigurasjonsfil ALDRI kan krasje eller
 * degradere samtalemotoren - kun rulle tilbake til kjent-god standardtone.
 */
const CONFIG_PATH = fileURLToPath(new URL("../../../config/charlie-personality.json", import.meta.url));

export function loadPersonalityConfig(): PersonalityConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = PersonalityConfigSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (err) {
    // D-396 (JARVIS-057): fall-tilbake til standardverdier er riktig, men skal ALDRI være stille - en manglende fil (feil image) eller ugyldig JSON
    // betyr at eierens konfig ikke har effekt. Logger kun feiltype/filnavn, aldri filinnhold.
    const code = (err as NodeJS.ErrnoException).code;
    console.warn(JSON.stringify({
      msg: "personality_config_fallback_to_default",
      reason: code === "ENOENT" ? "file_missing" : err instanceof SyntaxError ? "invalid_json" : "schema_invalid",
      file: "config/charlie-personality.json"
    }));
    return DEFAULT_PERSONALITY_CONFIG;
  }
}
