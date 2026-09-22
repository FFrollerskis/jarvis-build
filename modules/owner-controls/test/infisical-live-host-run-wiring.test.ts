import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-35 Infisical live host-akseptanse (D-235):
 * `modules/owner-controls/scripts/infisical-live-host-run.ts` er ÉN host-
 * kommando Tobias trenger for å bevise D-35 sin 10-punkts Infisical-
 * produksjonsport mot en EKTE, kjørende Infisical-instans. SAMME "bevis
 * strukturen, ALDRI koble til noe ekte"-mønster som
 * `k1-owner-control-authority-host-run-wiring.test.ts` (se den for
 * presedens) - INGEN Docker/Postgres/nettverkstilkobling her, KUN
 * kildeteksten selv.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/infisical-live-host-run.ts");
const liveScriptSource = readSource("../scripts/infisical-live.ts");

describe("host-run.ts - workspace/infra-bootstrap gjenbruker EKSISTERENDE mønstre, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(codeOnly).not.toMatch(/shell:\s*true/);
    }
  });
  it("sjekker at de FIRE påkrevde INFISICAL_*-variablene er satt i .env FØR noe Docker-kall gjøres", () => {
    const requiredIdx = hostRunSource.indexOf('const required = ["INFISICAL_URL", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_PROJECT_ID"]');
    const ensureWorkspaceIdx = hostRunSource.indexOf("ensureWorkspaceInstalled();");
    expect(requiredIdx).toBeGreaterThan(-1);
    expect(hostRunSource.indexOf("assertInfisicalEnvPresent();")).toBeLessThan(ensureWorkspaceIdx);
    expect(requiredIdx).toBeLessThan(ensureWorkspaceIdx);
  });
  it("bringer OPP postgres/infisical-redis/infisical (IKKE api/worker - dette scriptet tester ikke dem) FØR migrate kjøres", () => {
    const upIdx = hostRunSource.indexOf('"up", "-d", "postgres", "infisical-redis", "infisical"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(upIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeLessThan(migrateRunIdx);
    expect(hostRunSource).not.toContain('"build", "migrate", "api", "worker"');
  });
  it("gir compose-argumentene videre til live-scriptet via --compose-args, ETTER migrate", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/owner-controls/scripts/infisical-live.ts"');
    const composeArgsFlagIdx = hostRunSource.indexOf('"--compose-args"');
    expect(liveCallIdx).toBeGreaterThan(migrateRunIdx);
    expect(composeArgsFlagIdx).toBeGreaterThan(liveCallIdx);
  });
});

describe("live-scriptet krever compose-argumenter (gjør ekte docker exec/restart/stop/start MIDT i kjøringen)", () => {
  it("kaster en tydelig feil hvis --compose-args mangler, FØR noen tilstand endres", () => {
    const errorIdx = liveScriptSource.indexOf("infisical_missing_compose_args");
    const mainCallIdx = liveScriptSource.indexOf("await main();");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(mainCallIdx);
  });
});

describe("live-scriptet fail-closer FØR noe Infisical-kall gjøres når konfigurasjon mangler eller peker container-internt", () => {
  it("sjekker infisical.available() og gir BLOCKED_INFISICAL_NOT_CONFIGURED for ALLE punkter hvis ikke konfigurert", () => {
    const availableIdx = liveScriptSource.indexOf("infisical.available()");
    const blockedIdx = liveScriptSource.indexOf('results[key] = "BLOCKED_INFISICAL_NOT_CONFIGURED"');
    expect(availableIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeGreaterThan(availableIdx);
  });
  it("avviser en container-intern INFISICAL_URL (f.eks. 'infisical:8080') FØR noe nettverkskall, med en handlingsrettet feilmelding", () => {
    expect(liveScriptSource).toContain("function requireHostReachableInfisicalUrl(url: string): void {");
    expect(liveScriptSource).toContain("infisical_url_looks_container_internal");
    expect(liveScriptSource).toContain("INFISICAL_URL=http://127.0.0.1:3060");
  });
});

describe("live-scriptet bruker PRODUKSJONENS EGEN komposisjon - samme secret-kjede/ToolGateway-konstruksjon som apps/api/src/main.ts (D-211/D-213)", () => {
  it("readSecrets: Infisical PRIMÆR, FallbackSecretProvider(EnvSecretProvider, BusinessInternalSecretProvider) UENDRET fallback-kjede", () => {
    expect(liveScriptSource).toContain(
      "new FallbackSecretProvider(infisical, new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()))"
    );
  });
  it("ToolGateway konstrueres med `infisical` som 5. argument (writableSecrets) - SAMME instans som i les-kjeden, ALDRI to Infisical-tilkoblinger", () => {
    expect(liveScriptSource).toContain("new ToolGateway(sidePool, policy, readSecrets, ownerControls, infisical)");
  });
  it("OwnerControlsTransport konstrueres med `gateway` som 2. argument (D-213 - kobler set_connector_credential/test_connector til ToolGateway.setSecret()/nøstet execute())", () => {
    expect(liveScriptSource).toContain("new OwnerControlsTransport(service, gateway)");
  });
  it("importerer OwnerControlsService/OwnerControlsTransport/audit-evidence fra DEN LOKALE ../src/ (ALDRI @jarvis/owner-controls - unngår sirkulær pakkeavhengighet siden @jarvis/owner-controls selv avhenger av @jarvis/tool-gateway)", () => {
    expect(liveScriptSource).toContain('from "../src/service.ts"');
    expect(liveScriptSource).toContain('from "../src/transport.ts"');
    expect(liveScriptSource).toContain('from "../src/audit-evidence.ts"');
    expect(liveScriptSource).not.toMatch(/from\s*"@jarvis\/owner-controls"/);
  });
});

describe("D213 skrive-sti (aldri en snarvei direkte i Infisical for selve mutasjonen)", () => {
  it("kaller owner_controls.set_connector_credential for ALLE TRE skrivingene (initial/rotasjon/gjenoppretting) - ALDRI infisical.set()/provider.set() direkte", () => {
    const occurrences = liveScriptSource.match(/action:\s*"set_connector_credential"/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    expect(liveScriptSource).toContain("async function setConnectorCredential(gateway: ToolGateway, value: string)");
    expect(liveScriptSource).not.toMatch(/infisical\.set\(/);
  });
  it("verifiserer dashbordets configured:true via DEN SAMME listConnectorStatus() dashbordet selv bruker (@jarvis/tool-gateway), ikke en egen, parallell statuslogikk", () => {
    expect(liveScriptSource).toContain("listConnectorStatus(apiStack.gateway)");
  });
  it("test_connector-seksjonen forventer den STRUKTURERTE presence_only-responsen for en connector uten live_test - IKKE en kastet feil", () => {
    expect(liveScriptSource).toContain('data?.test_method === "presence_only"');
    expect(liveScriptSource).toContain("data.tested === false");
  });
});

describe("D-41 blast radius: KUN kjøre-unike test-artefakter røres, ALDRI en ekte credential_ref/connector, og synthetisk connector fjernes igjen", () => {
  it("TEST_SECRET_REF/SYNTHETIC_CONNECTOR_ID er kjøre-unike (inneholder runId), ikke hardkodede, delte navn", () => {
    expect(liveScriptSource).toContain("const TEST_SECRET_REF = `JARVIS_D235_INFISICAL_TEST_${runId}`;");
    expect(liveScriptSource).toContain("const SYNTHETIC_CONNECTOR_ID = `d235_infisical_acceptance_connector_${runId}`;");
  });
  it("pusher den syntetiske connectoren inn i CONNECTOR_REGISTRY OG fjerner den igjen i CLEANUP (splice)", () => {
    const pushIdx = liveScriptSource.indexOf("CONNECTOR_REGISTRY.push(syntheticConnector);");
    const spliceIdx = liveScriptSource.indexOf("CONNECTOR_REGISTRY.splice(idx, 1);");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(spliceIdx).toBeGreaterThan(pushIdx);
  });
  it("CLEANUP kjøres inni en `finally`-blokk rundt HELE hovedsekvensen", () => {
    const tryIdx = liveScriptSource.indexOf("try {");
    const finallyIdx = liveScriptSource.indexOf("} finally {");
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    expect(cleanupIdx).toBeGreaterThan(finallyIdx);
  });
  it("backup/recovery-seksjonen dropper KUN sin egen scratch-database (--if-exists) - ALDRI 'infisical' eller 'jarvis' selv", () => {
    expect(liveScriptSource).toContain('"dropdb", "-U", adminUser, "-h", "127.0.0.1", "--if-exists", scratchDbName');
    expect(liveScriptSource).not.toMatch(/dropdb[^\n]*"infisical"/);
    expect(liveScriptSource).not.toMatch(/dropdb[^\n]*"jarvis"/);
  });
});

describe("D35_P8 (rotasjon/tilbakekalling) - EKTE Infisical v3 raw secrets DELETE-API, verifisert mot faktisk backend-kildekode, ikke gjettet", () => {
  it("bruker samme /api/v3/secrets/raw/-URL-form som den allerede etablerte get()/set() i gateway.ts", () => {
    expect(liveScriptSource).toContain("`${INFISICAL_URL}/api/v3/secrets/raw/${encodeURIComponent(ref)}`");
    expect(liveScriptSource).toContain('method: "DELETE"');
  });
  it("bekrefter fail-closed ETTER tilbakekalling (get()=null OG hasSecret()=false), ALDRI kun én av dem", () => {
    const revokeOkIdx = liveScriptSource.indexOf("const revokeOk = deleteStatus >= 200");
    expect(revokeOkIdx).toBeGreaterThan(-1);
    expect(liveScriptSource.slice(revokeOkIdx, revokeOkIdx + 200)).toContain("afterRevoke === null");
    expect(liveScriptSource.slice(revokeOkIdx, revokeOkIdx + 200)).toContain("!hasSecretAfterRevoke");
  });
});

describe("D35_P7 (secret aldri logget) - scriptets EGNE loglinjer interpolerer ALDRI en rå test-secret-verdi direkte, kun via shortHash()", () => {
  it("INITIAL_VALUE/ROTATED_VALUE/RESTORED_VALUE forekommer ALDRI som en direkte template-interpolasjon (kun via shortHash(...)/som parameterverdi/i sammenligninger)", () => {
    expect(liveScriptSource).not.toContain("${INITIAL_VALUE}");
    expect(liveScriptSource).not.toContain("${ROTATED_VALUE}");
    expect(liveScriptSource).not.toContain("${RESTORED_VALUE}");
  });
  it("sjekker BÅDE loggbufferet OG owner_controls-audit-payloaden for denne kjøringen mot alle tre verdiene", () => {
    expect(liveScriptSource).toContain("const noneInLog = !logBuffer.some((line) => ALL_TEST_SECRET_VALUES.some((v) => line.includes(v)));");
    expect(liveScriptSource).toContain("queryRunScopedOwnerControlsAudit(adminPool");
  });
});

describe("D35_P10 (backup/recovery) - dekrypterer ALDRI secretValue selv, kun strukturelt radbevis (D-41: aldri reimplementert Infisical sin egen KMS-logikk)", () => {
  it("spør etter raden via plaintext 'key'-kolonnen i secrets_v2 - INGEN spørring SELECTer/dekrypterer encryptedValue", () => {
    expect(liveScriptSource).toContain('"SELECT 1 FROM secrets_v2 WHERE key = $1"');
    expect(liveScriptSource).not.toMatch(/SELECT[^;]*encryptedValue/);
  });
});

describe("D35_P4 (TLS) - dokumentert N/A MED forbehold, ALDRI et fabrikkert TLS-PASS", () => {
  it("setter verdikten til N/A_DOCUMENTED, ALDRI PASS, og nevner port-publiseringsforbeholdet eksplisitt", () => {
    expect(liveScriptSource).toContain('results.d35_p4_tls_secure_transport = "N/A_DOCUMENTED";');
    expect(liveScriptSource).toContain("3060:8080");
  });
});

describe("finish() krever ALDRI selvstendig PASS/VERIFIED-status - kun en arkitekt-review-kandidat-markør, samme disiplin som stripe-real-payment-acceptance.ts", () => {
  it("bruker PASS_PENDING_ARCHITECT_REVIEW, ALDRI et ordløst/bekreftende 'VERIFIED'", () => {
    expect(liveScriptSource).toContain("PASS_PENDING_ARCHITECT_REVIEW");
    expect(liveScriptSource).not.toMatch(/=\s*"VERIFIED"/);
  });
});
