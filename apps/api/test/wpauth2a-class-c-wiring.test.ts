import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { CLASS_C_PIPELINE_FLAG, ToolGateway } from "@jarvis/tool-gateway";
import { createClassCWiring } from "../src/class-c-wiring.ts";

/**
 * WP-AUTH2a (K2/K7): flagget `JARVIS_CLASS_C_PIPELINE` er AV som standard, når BÅDE api og worker (compose sender kun det manifestet lister), og begge prosessene bruker den ENE fabrikken (API/worker-parity).
 * Modus AV sender INGEN option til `ToolGateway` - da finnes pipelinen ikke i prosessen (identisk med main).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const FLAG = "JARVIS_CLASS_C_PIPELINE";

const EIGHT = [
  "business.update_lead_status", "drive.create_file", "drive.move", "drive.rename", "drive.trash", "drive.update_content", "github.create_pr", "growth.set_campaign_status"
];

describe("fabrikken: modus -> option", () => {
  it("konstanten er det eksakte flaggnavnet", () => {
    expect(CLASS_C_PIPELINE_FLAG).toBe(FLAG);
  });

  it("AV (usatt, tom, off og enhver ukjent verdi): ingen option, ingen logg - og en ukjent verdi meldes som ugyldig (aldri en stille enforce)", () => {
    for (const raw of [undefined, "", "off", " OFF "]) {
      expect(createClassCWiring(raw === undefined ? {} : { [FLAG]: raw }), String(raw)).toEqual({ options: {}, log: null, invalid: false });
    }
    for (const raw of ["enfroce", "on", "true", "1"]) {
      const w = createClassCWiring({ [FLAG]: raw });
      expect(w.options, raw).toEqual({});
      expect(w.invalid).toBe(true);
      expect(w.log).toMatchObject({ msg: "class_c_pipeline_mode_invalid", flag: FLAG, effective_mode: "off" });
    }
  });

  it("observe/enforce: pipelinen har akkurat de åtte første adapterne, i riktig modus, og loggen bærer kun navn", () => {
    for (const mode of ["observe", "enforce"] as const) {
      const w = createClassCWiring({ [FLAG]: mode });
      expect(w.invalid).toBe(false);
      expect(w.options.classCPipeline?.mode).toBe(mode);
      expect(w.options.classCPipeline?.adapterKeys()).toEqual(EIGHT);
      expect(w.log).toEqual({ msg: "class_c_pipeline", mode, adapters: EIGHT });
    }
  });

  it("gatewayen rapporterer modusen: AV uten option, ellers den valgte", () => {
    const make = (env: Record<string, string>) => new ToolGateway({} as never, {} as never, { name: "t", get: async () => null }, undefined, undefined, createClassCWiring(env).options);
    expect(make({}).classCMode()).toBe("off");
    expect(make({ [FLAG]: "observe" }).classCMode()).toBe("observe");
    expect(make({ [FLAG]: "enforce" }).classCMode()).toBe("enforce");
  });
});

describe("flagget når containerne", () => {
  it("står i SERVICE_ENV for api OG worker (nøyaktig én gang hver), men ikke i voice/browser/migrate", () => {
    for (const service of ["api", "worker"] as const) expect((SERVICE_ENV[service] as string[]).filter((n) => n === FLAG), service).toHaveLength(1);
    for (const service of ["voice", "browser", "migrate"] as const) expect(SERVICE_ENV[service], service).not.toContain(FLAG);
  });

  it("compose har nøyaktig to videresendingslinjer (api og worker; tom standard = AV)", () => {
    const lines = read("infra/local/docker-compose.yml").split("\n").filter((l) => l.trim().startsWith(`${FLAG}:`));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.trim()).toBe(`${FLAG}: "\${${FLAG}:-}"`);
  });

  it("er ikke en hemmelighet og er dokumentert i .env.example som AV (aldri påslått i eksempelfilen)", () => {
    expect(NEVER_IN_RUNTIME).not.toContain(FLAG);
    const example = read(".env.example");
    expect(example).toContain(`# ${FLAG}=off`);
    expect(example.split("\n").filter((l) => new RegExp(`^${FLAG}=.+`).test(l))).toEqual([]);
  });
});

describe("API/worker-parity i kildekoden", () => {
  for (const file of ["apps/api/src/main.ts", "apps/api/src/worker-main.ts"]) {
    it(`${file}: importerer den felles fabrikken, kaller den ÉN gang med process.env, og spreder kun \`options\` inn i ToolGateway`, () => {
      const source = read(file);
      expect(source).toContain(`import { createClassCWiring } from "./class-c-wiring.ts";`);
      expect(source.match(/createClassCWiring\(process\.env\)/g) ?? []).toHaveLength(1);
      expect(source.match(/\.\.\.classCWiring\.options/g) ?? []).toHaveLength(1);
      expect(source.match(/new ToolGateway\(/g) ?? []).toHaveLength(1);
      // ingen annen lesing av flagget (parseren er den eneste)
      expect(source).not.toContain(FLAG);
    });
  }

  it("ingen annen produksjonsfil i apps/api/src leser flagget enn fabrikken (én kilde til sannhet)", () => {
    for (const file of ["main.ts", "worker-main.ts", "server.ts"]) expect(read(`apps/api/src/${file}`), file).not.toContain(`"${FLAG}"`);
    expect(read("apps/api/src/class-c-wiring.ts")).toContain("CLASS_C_PIPELINE_FLAG");
  });
});
