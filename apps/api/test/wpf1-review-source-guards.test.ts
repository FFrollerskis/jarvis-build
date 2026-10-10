import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-F1, uavhengig review (PR #321) F4: api og worker MÅ alltid bygge produksjonsgatewayen med `classDPipeline: { enforce: true, ... }` (resten av klasse D-pipelinen - fersk lesing,
 * etterbetingelse, idempotensnøkkel, varsler - er avhengig av flagget; selve step-up-kravet håndheves nå uavhengig av det). Kildevakt: leser `main.ts` og `worker-main.ts` som tekst.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("produksjonsgatewayen i api og worker bygges alltid med klasse D-pipelinen påslått", () => {
  for (const file of ["main.ts", "worker-main.ts"]) {
    it(`${file}: \`new ToolGateway(...)\` får \`classDPipeline: { enforce: true\``, () => {
      const text = readFileSync(join(SRC, file), "utf8");
      const start = text.indexOf("new ToolGateway(");
      expect(start, "ToolGateway konstrueres her").toBeGreaterThan(-1);
      const construction = text.slice(start, start + 600);
      expect(construction).toMatch(/classDPipeline:\s*\{\s*enforce:\s*true\b/);
      expect(text.match(/new ToolGateway\(/g)).toHaveLength(1); // ingen annen, svakere gateway i samme prosess
    });
  }
});
