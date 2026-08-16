import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16) §10/§11: `p1a-drive-runtime-
 * smoke.ts` er et top-level side-effekt-skript (kobler til ekte Postgres,
 * gjør et ekte Google Drive-kall) - kan IKKE trygt importeres direkte i en
 * testfil, samme presedens som `db-role-wiring.test.ts`/
 * `drive-runtime-wiring.test.ts`. Denne suiten beviser strukturelt at
 * smoke-scriptet faktisk bruker den NORMALE runtime-banen (ikke en
 * parallell/akseptanse-only vei), er READ-ONLY, og ALDRI logger secrets.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../scripts/p1a-drive-runtime-smoke.ts");
const codeOnly = source
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("p1a-drive-runtime-smoke.ts bruker den NORMALE ToolGateway/firstWaveTools-runtime-banen", () => {
  it("bruker driveTransportsIfConfigured() spredd inn i firstWaveTools({...}) - NØYAKTIG samme mønster som main.ts/worker-main.ts", () => {
    expect(source).toContain("...driveTransportsIfConfigured()");
    expect(source).toContain("firstWaveTools(apiTransports)");
  });
  it("bruker EKTE PgDeviceRegistry/PgApprovalStore/PolicyGateway - ikke InMemory-test-doubles (dette er et LIVE bevis, ikke en enhetstest)", () => {
    expect(source).toContain("new PgDeviceRegistry(pool, tenantId)");
    expect(source).toContain("new PgApprovalStore(pool)");
    expect(codeOnly).not.toMatch(/InMemoryDeviceRegistry|InMemoryNonceStore/);
  });
  it("kaller toolGateway.execute() (den SAMME utførelsesveien som main.ts/worker-main.ts bruker) - ingen direkte transport.invoke()-omvei", () => {
    expect(source).toMatch(/toolGateway\.execute\(\{[\s\S]*?tool_id:\s*"drive"/);
    expect(codeOnly).not.toMatch(/\.invoke\(/);
  });
});

describe("READ-ONLY: ingen Drive-mutasjon forsøkes i denne closeout-smoke-testen", () => {
  it("den ENESTE Drive-handlingen som utføres er get_metadata (klasse A) - ingen create/update/rename/move/trash/delete/permission-handling", () => {
    expect(source).toContain('action: "get_metadata"');
    for (const mutatingAction of ["create_file", "create_folder", "update_content", "rename", "move", "trash", "delete_permanent", "create_permission", "update_permission", "delete_permission"]) {
      expect(codeOnly).not.toContain(`"${mutatingAction}"`);
    }
  });
});

describe("token_leak-bevis og fail-closed Q-21-oppførsel er tilstede", () => {
  it("sjekker den persisterte audit_events-raden for refreshToken/clientSecret - aldri en antatt/stille PASS", () => {
    expect(source).toContain("r.p.includes(refreshToken)");
    expect(source).toContain("r.p.includes(clientSecret)");
  });
  it("kaller assertRuntimeCredentialsConfigured()/assertRuntimeRoleSafe(pool) FØR noe Drive-kall forsøkes (samme fail-closed-presedens som main.ts/worker-main.ts/ua2-p1a-live.ts)", () => {
    const credIdx = source.indexOf("assertRuntimeCredentialsConfigured()");
    const roleIdx = source.indexOf("assertRuntimeRoleSafe(pool)");
    const executeIdx = source.indexOf("toolGateway.execute(");
    expect(credIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeGreaterThan(credIdx);
    expect(executeIdx).toBeGreaterThan(roleIdx);
  });
});

describe("ingen secrets logges", () => {
  const logLines = codeOnly.split("\n").filter((line) => /\blog\(|console\.(error|log)\(/.test(line));
  const forbiddenIdentifiers = ["refreshToken", "clientSecret", "clientId"];

  it("ingen log()/console.*-linje interpolerer selve credential-verdiene direkte (kun Boolean(...)-tilstedeværelse er tillatt)", () => {
    for (const line of logLines) {
      for (const forbidden of forbiddenIdentifiers) {
        if (line.includes(`Boolean(${forbidden})`)) continue;
        expect(line, `secret-lekkasje-kandidat: "${line.trim()}" inneholder ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("ett-kommando-kontrakten er dokumentert og eksakt (HOST-FIX 2026-08-16: --env-file=.env er PÅKREVD)", () => {
  it("toppkommentaren viser NØYAKTIG kommandoen Tobias skal kjøre, MED --env-file=.env - scriptet leser process.env direkte og laster ALDRI .env selv", () => {
    expect(source).toContain("node --env-file=.env --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts");
  });
  it("regresjonsvakt: den TIDLIGERE, ufullstendige kommandoen (uten --env-file) finnes IKKE lenger NOE STED i fila (host-bevist BLOCKED_NO_CREDENTIALS-feil, 2026-08-16)", () => {
    expect(source).not.toMatch(/node --experimental-transform-types apps\/api\/scripts\/p1a-drive-runtime-smoke\.ts/);
  });
  it("krever INGEN ny OAuth-samtykke - leser KUN allerede persisterte JARVIS_GOOGLE_*-verdier fra .env, aldri en client-secret-JSON-fil", () => {
    expect(codeOnly).not.toMatch(/JARVIS_GOOGLE_CLIENT_SECRET_JSON|readFileSync/);
  });
});
