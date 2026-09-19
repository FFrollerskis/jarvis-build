import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-180 (W1, arkitekt-order D183 §F): `modules/watchdog/scripts/
 * w1-watchdog-durability-host-run.ts` er den ENE host-kommandoen Tobias
 * trenger for å bevise W1 LIVE. Speiler NØYAKTIG samme struktur som
 * `d174-executive-control-surface-host-run-wiring.test.ts` (se dens egen
 * filhode) - denne suiten beviser den strukturelt, uten å faktisk kjøre
 * Docker/pnpm/embedded Postgres (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/w1-watchdog-durability-host-run.ts");
const liveScriptSource = readSource("../scripts/w1-watchdog-durability-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker build", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(codeOnly).not.toMatch(/shell:\s*true/);
    }
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
  });
  it("kjører migrate FØR api/worker restartes med --force-recreate", () => {
    const migrateIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"--force-recreate", "api", "worker"');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeLessThan(restartIdx);
  });
  it("kjører selve w1-watchdog-durability-live.ts akseptansen til slutt, med .env og type-stripping", () => {
    expect(hostRunSource).toContain('"--env-file=.env", "--experimental-transform-types",');
    expect(hostRunSource).toContain('"modules/watchdog/scripts/w1-watchdog-durability-live.ts"');
  });
});

describe("live-scriptet: ingen ekte Telegram-API-kall, ingen ekte kredensial-mekanisme", () => {
  it("bruker en skriptbar ScriptedTelegramTransport-fake ved nettverksgrensen, aldri en rå fetch mot api.telegram.org", () => {
    expect(liveScriptSource).toContain("class ScriptedTelegramTransport implements ToolTransport");
    expect(liveScriptSource).not.toContain("api.telegram.org");
  });
  it("WatchdogEmergencyAlertSink sin egen produksjonskode kjøres UENDRET (kun transporten under er fake) - D-181/BLOCKER B1", () => {
    expect(liveScriptSource).toContain("new WatchdogEmergencyAlertSink(scriptedTelegram, secrets)");
  });
  it("SAMME scriptedTelegram-instans brukes BÅDE for den ordinære telegram-verktøyregistreringen OG nødvarsel-sinken", () => {
    expect(liveScriptSource).toMatch(/firstWaveTools\(\{\s*telegram:\s*scriptedTelegram\s*\}\)/);
    expect(liveScriptSource.match(/new ScriptedTelegramTransport\(\)/g)?.length).toBe(1);
  });
});

describe("D-181 (BLOCKER B1): live-scriptet beviser BEGGE samtidig - ordinær telegram.notify nektet, watchdog sin egen sti levert", () => {
  it("seksjon 2b kjører BÅDE et ordinært gateway.execute(telegram.notify)-kall OG primary.alertSink.send() under SAMME aktive tilstand", () => {
    const idx = liveScriptSource.indexOf("BLOKKER B1");
    expect(idx).toBeGreaterThan(-1);
    const sectionBody = liveScriptSource.slice(idx, idx + 1800);
    expect(sectionBody).toContain('tool_id: "telegram", action: "notify"');
    expect(sectionBody).toContain('"kill_switch_active"');
    expect(sectionBody).toContain("primary.alertSink.send(");
  });
  it("D-184: seksjon 2 beviser at watchdog-ens EGEN tick() leverte varselet (ikke bare et manuelt alertSink.send() i 2b)", () => {
    const s2Idx = liveScriptSource.indexOf('"2) watchdog.tick()');
    expect(s2Idx).toBeGreaterThan(-1);
    const sectionBody = liveScriptSource.slice(s2Idx, s2Idx + 2200);
    expect(sectionBody).toContain("const sentBeforeTick = scriptedTelegram.sent.length;");
    expect(sectionBody).toContain("scriptedTelegram.sent.length > sentBeforeTick");
    expect(sectionBody).toContain("w1_emergency_alert_delivered_by_watchdog_tick");
  });

  it("D-184: rekkefølgen er OBSERVERT i kjøringen (durabel tilstand avlest PÅ leveringstidspunktet), ikke lest ut av kildekoden", () => {
    // Observatøren ligger rundt den EKTE sinken, inne i watchdog-ens egen kjede.
    expect(liveScriptSource).toContain("durableActiveAtSendTime: await killSwitch.isActiveDurable()");
    expect(liveScriptSource).toContain("sentCountAtSendTime: scriptedTelegram.sent.length");
    expect(liveScriptSource).toContain("w1_durable_shutdown_observed_before_alert");
    // ...og den ENDRER ingenting: den delegerer til den uendrede alertSink.send().
    expect(liveScriptSource).toMatch(/await alertSink\.send\(alert\)/);
  });

  it("D-184: det som FAKTISK logges paa varslings-feilstien skannes for secret-lekkasje (ikke bare diagnostikk)", () => {
    expect(liveScriptSource).toContain("capturedErrorLogs");
    const auditIdx = liveScriptSource.indexOf("w1_audit_evidence_no_secret_leakage =");
    expect(auditIdx).toBeGreaterThan(-1);
    const auditBody = liveScriptSource.slice(Math.max(0, auditIdx - 900), auditIdx);
    expect(auditBody).toContain("JSON.stringify(capturedErrorLogs)");
  });

  it("seksjon 2b kommer FØR seksjon 3 (fersk-pool), altså mens primary sin kill switch fortsatt er aktiv fra seksjon 2", () => {
    const s2Idx = liveScriptSource.indexOf('"2) watchdog.tick()');
    const s2bIdx = liveScriptSource.indexOf("BLOKKER B1");
    const s3Idx = liveScriptSource.indexOf('"3) UAVHENGIG, FERSK pool');
    expect(s2Idx).toBeGreaterThan(-1);
    expect(s2bIdx).toBeGreaterThan(s2Idx);
    expect(s3Idx).toBeGreaterThan(s2bIdx);
  });
});

describe("live-scriptet: kill switch-aktivering er alltid kortvarig og garantert opprettet i finally", () => {
  it("har en finally-blokk (rundt HELE main()-forsøket) som deaktiverer killSwitch og fjerner den synthetiske cost_events-raden uansett feil", () => {
    const cleanupIdx = liveScriptSource.indexOf("cleanupKillSwitch");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupBody = liveScriptSource.slice(cleanupIdx, cleanupIdx + 500);
    expect(cleanupBody).toContain("deactivateDurable(OWNER_PERSON)");
    expect(cleanupBody).toContain("DELETE FROM cost_events WHERE kind = $1");
  });
  it("verifiserer at owner_control_state er UENDRET fra før kjøringen (CLEANUP-seksjonen)", () => {
    expect(liveScriptSource).toContain("owner_control_state_after");
    expect(liveScriptSource).toContain("w1_cleanup_state_unchanged");
  });
});

describe("live-scriptet: proof-punktene fra D183 §F er alle representert", () => {
  const expectedResultKeys = [
    "q21_runtime_role_safe",
    "w1_cost_threshold_triggered_with_test_data",
    "w1_durable_kill_switch_active",
    "w1_ordinary_telegram_notify_remains_blocked_under_kill_switch",
    "w1_alert_path_attempted",
    "w1_emergency_alert_delivered_by_watchdog_tick",
    "w1_durable_shutdown_observed_before_alert",
    "w1_fresh_pool_observes_active_state",
    "w1_policy_enforcement_observes_active_state",
    "w1_restart_style_reconstruction_sees_active_state",
    "w1_owner_recovery_via_canonical_path",
    "w1_alert_failure_does_not_prevent_shutdown",
    "w1_no_duplicate_activation_on_repeated_tick",
    "w1_cleanup_state_unchanged",
    "w1_audit_evidence_no_secret_leakage"
  ];
  it.each(expectedResultKeys)("results-objektet inneholder nøkkelen %s", (key) => {
    expect(liveScriptSource).toContain(`${key}:`);
  });
});

/**
 * D-190 (BLOCKER B3, arkitekt-order D190 mot PR #96 - funn fra en EKTE
 * Windows/Docker/Postgres-vertskjøring, run_id `aad6de29`): den ekte
 * `jarvis_runtime`-rollen (RLS) tillater IKKE INSERT/DELETE på `cost_events`
 * - kun den ordinære produksjonsspørringsveien (SELECT, som `costExplosionCheck`
 * selv utfører). Live-scriptet brukte tidligere den samme runtime-`pool`-en
 * for å SETTE OPP/RYDDE OPP den syntetiske test-fixturen, noe som feilet host-
 * kjøringen FØR watchdog-atferden i det hele tatt kunne bevises. Denne suiten
 * beviser strukturelt at ALLE fixture-INSERT/DELETE-operasjoner nå går via
 * `adminPool` (som allerede brukes for `owner_control_state`-snapshots), MENS
 * selve atferden som testes (costExplosionCheck, KillSwitch, PolicyGateway,
 * fresh-pool-sjekker) forblir UENDRET på runtime-`pool`/`configFromEnv()` -
 * ingen utvidelse av runtime-rollens faktiske privilegier, ingen RLS-endring.
 */
describe("D190 §B3: syntetisk cost_events-fixture bruker adminPool, ALDRI runtime-pool - selve atferden som testes forblir uendret på runtime-pool", () => {
  it("1) syntetisk cost-INSERT (seksjon 1) bruker adminPool, ikke pool", () => {
    const insertIdx = liveScriptSource.indexOf("1) syntetisk kostnadseksplosjon");
    expect(insertIdx).toBeGreaterThan(-1);
    const block = liveScriptSource.slice(insertIdx, liveScriptSource.indexOf("});", insertIdx));
    expect(block).toMatch(/adminPool\.query\(\s*"INSERT INTO cost_events/);
    expect(block).not.toMatch(/[^.]pool\.query\(\s*"INSERT INTO cost_events/);
  });

  it("2) syntetisk cost-DELETE (seksjon 8, FØR re-fixture) bruker adminPool, ikke pool", () => {
    const s8Idx = liveScriptSource.indexOf("8) simulert varslingsfeil");
    expect(s8Idx).toBeGreaterThan(-1);
    const block = liveScriptSource.slice(s8Idx, liveScriptSource.indexOf("});", s8Idx));
    const deleteMatch = block.match(/(\w*Pool)\.query\(\s*"DELETE FROM cost_events/);
    expect(deleteMatch?.[1]).toBe("adminPool");
  });

  it("3) seksjon 8 sin re-fixture-INSERT (for varslingsfeil-caset) bruker adminPool, ikke pool", () => {
    const s8Idx = liveScriptSource.indexOf("8) simulert varslingsfeil");
    const block = liveScriptSource.slice(s8Idx, liveScriptSource.indexOf("});", s8Idx));
    const insertMatch = block.match(/(\w*Pool)\.query\(\s*"INSERT INTO cost_events/);
    expect(insertMatch?.[1]).toBe("adminPool");
  });

  it("4) finally-blokkens fixture-DELETE (garantert cleanup) bruker adminPool, ikke pool - kan ALDRI feile med 'permission denied for table cost_events' igjen", () => {
    const cleanupIdx = liveScriptSource.indexOf("const cleanupKillSwitch");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const block = liveScriptSource.slice(cleanupIdx, cleanupIdx + 600);
    const deleteMatch = block.match(/(\w*Pool)\.query\(\s*"DELETE FROM cost_events/);
    expect(deleteMatch?.[1]).toBe("adminPool");
  });

  it("5) ALLE cost_events-mutasjoner (INSERT/DELETE) i hele live-scriptet går via adminPool - null gjenstående mutasjon via runtime-pool", () => {
    const mutations = [...liveScriptSource.matchAll(/(\w*Pool)\.query\(\s*"(INSERT INTO cost_events|DELETE FROM cost_events)/g)];
    expect(mutations.length).toBeGreaterThanOrEqual(5); // 2 INSERT + 3 DELETE (seksjon 1, seksjon 8 x2, slutt-av-try, finally)
    for (const m of mutations) {
      expect(m[1]).toBe("adminPool");
    }
  });

  it("6) costExplosionCheck mottar FORTSATT runtime-pool (sidePool, avledet fra buildStack(pool) - IKKE adminPool), OG et eksplisitt OWNER_TENANT (D-191)", () => {
    const callIdx = liveScriptSource.indexOf("costExplosionCheck(sidePool,");
    expect(callIdx).toBeGreaterThan(-1);
    expect(liveScriptSource).not.toMatch(/costExplosionCheck\(adminPool/);
    const call = liveScriptSource.slice(callIdx, liveScriptSource.indexOf(";", callIdx));
    expect(call).toContain("OWNER_PERSON");
    expect(call).toContain("OWNER_TENANT");
  });

  it("7) den ordinære trussel-SELECT-en i seksjon 1 (beviser at jarvis_runtime kan LESE via den ekte produksjonsspørringsveien) kjører nå INNI withTenantTransaction(pool, OWNER_TENANT, ...) - SAMME kanoniske mekanisme som costExplosionCheck selv bruker (D-191)", () => {
    const selectIdx = liveScriptSource.indexOf("SELECT coalesce(sum(amount_ore)");
    expect(selectIdx).toBeGreaterThan(-1);
    const before = liveScriptSource.slice(Math.max(0, selectIdx - 400), selectIdx);
    expect(before).toMatch(/withTenantTransaction\(pool,\s*OWNER_TENANT,/);
    // Selve SELECT-en kjører nå på transaksjons-klienten, ikke direkte på pool.
    const immediatelyBefore = liveScriptSource.slice(Math.max(0, selectIdx - 60), selectIdx);
    expect(immediatelyBefore).toMatch(/\bclient\.query\(\s*"$/);
  });

  it("liveScriptSource importerer withTenantTransaction fra @jarvis/core (D-191)", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
  });

  it("8) alle tre fresh-pool-sjekkene (seksjon 3/4/5) bruker fortsatt createPool(configFromEnv()) - ekte runtime-credentials, ingen adminPool", () => {
    const freshPoolCalls = [...liveScriptSource.matchAll(/const freshPool = createPool\(configFromEnv\(\)\)/g)];
    expect(freshPoolCalls.length).toBe(3);
  });

  it("9) KillSwitch/PolicyGateway under test forblir konstruert med runtime-pool-avledede instanser - INGEN av dem tar adminPool som datakilde", () => {
    expect(liveScriptSource).not.toMatch(/new KillSwitch\(adminPool/);
    expect(liveScriptSource).not.toMatch(/new PolicyGateway\(\{[^}]*adminPool/s);
  });

  it("10) ingen privilegie-/RLS-utvidelse forsøkt fra harnesset selv - ingen GRANT/ALTER ROLE/ALTER TABLE-setning noe sted i live- eller host-run-scriptet (lesing/logging av EKSISTERENDE status.bypassrls, som beviser at den er false, er IKKE en utvidelse og er bevisst tillatt)", () => {
    expect(liveScriptSource).not.toMatch(/\b(GRANT|ALTER ROLE|ALTER TABLE)\b/i);
    expect(hostRunSource).not.toMatch(/\b(GRANT|ALTER ROLE|ALTER TABLE)\b/i);
  });

  it("11) fixture-cleanup forblir kjøre-scoped til SYNTHETIC_COST_KIND i ALLE tre DELETE-setningene - aldri en ubetinget DELETE mot cost_events", () => {
    const deletes = [...liveScriptSource.matchAll(/adminPool\.query\(\s*"DELETE FROM cost_events WHERE kind = \$1"/g)];
    expect(deletes.length).toBe(3);
    expect(liveScriptSource).not.toMatch(/DELETE FROM cost_events["'`]\s*\)/);
  });
});

/**
 * D-191 (BLOCKER B4 §F, cleanup-robusthet): FØR denne fiksen var kill-switch-
 * deaktivering og fixture-DELETE to RÅ `await`-kall (ikke `section()`-
 * innpakket) rett etter hverandre i `main()` sin egen `finally`-blokk. Kastet
 * den FØRSTE, kjørte den ANDRE aldri - OG hele feilen forplantet seg UT AV
 * `main()`, forbi det topp-nivå `finish()`-kallet (`await main(); finish();`)
 * - INGEN sammendrag, INGEN `hard_fail`-beregning i det hele tatt. Denne
 * suiten beviser strukturelt at begge operasjonene nå har SIN EGEN try/catch
 * (kan derfor aldri forhindre hverandre), og at begge har en dedikert
 * `results`-nøkkel som starter "FAIL" og KUN flippes til "PASS" ved suksess -
 * slik at `finish()` sin eksisterende `hard_fail`-skanning automatisk fanger
 * en cleanup-feil, uten noen ny, parallell hard_fail-mekanisme.
 */
describe("D191 §F: kill-switch-cleanup og fixture-cleanup kan ALDRI forhindre hverandre - en cleanup-feil produserer FORTSATT et sammendrag OG hard_fail=true", () => {
  it("w1_cleanup_kill_switch_deactivated og w1_cleanup_fixture_removed er begge deklarert i results-objektet, initialisert FAIL", () => {
    const resultsIdx = liveScriptSource.indexOf("const results: Record<string, Verdict>");
    expect(resultsIdx).toBeGreaterThan(-1);
    const resultsBlock = liveScriptSource.slice(resultsIdx, liveScriptSource.indexOf("};", resultsIdx));
    expect(resultsBlock).toMatch(/w1_cleanup_kill_switch_deactivated:\s*"FAIL"/);
    expect(resultsBlock).toMatch(/w1_cleanup_fixture_removed:\s*"FAIL"/);
  });

  it("kill-switch-deaktivering og fixture-DELETE i finally-blokken har HVER SIN egen try/catch - ikke én try/catch rundt begge", () => {
    // Søker etter den YTRE finally-blokken (rundt HELE main()-forsøket), ikke
    // en av de tidligere, INDRE finally-blokkene (seksjon 3/4/5 sin egen
    // `freshPool.end()`-opprydding) - starter derfor søket ETTER seksjon 10.
    const finallyIdx = liveScriptSource.indexOf("} finally {", liveScriptSource.indexOf("audit-bevis"));
    expect(finallyIdx).toBeGreaterThan(-1);
    const cleanupBlock = liveScriptSource.slice(finallyIdx, liveScriptSource.indexOf("CLEANUP: owner_control_state", finallyIdx));
    // To distinkte try-blokker, hver med sin egen catch, mellom finally og owner_control_state-seksjonen.
    const tryCount = [...cleanupBlock.matchAll(/\btry\s*\{/g)].length;
    const catchCount = [...cleanupBlock.matchAll(/\}\s*catch\s*\(/g)].length;
    expect(tryCount).toBeGreaterThanOrEqual(2);
    expect(catchCount).toBeGreaterThanOrEqual(2);
    // Kill-switch-linjene kommer FØR fixture-DELETE-linjen, hver i sin egen blokk.
    const killSwitchIdx = cleanupBlock.indexOf("cleanupKillSwitch");
    const fixtureDeleteIdx = cleanupBlock.indexOf("adminPool.query(\"DELETE FROM cost_events");
    expect(killSwitchIdx).toBeGreaterThan(-1);
    expect(fixtureDeleteIdx).toBeGreaterThan(killSwitchIdx);
    // Suksess-flippet ("PASS") for BEGGE nøklene finnes et sted i denne blokken.
    expect(cleanupBlock).toMatch(/w1_cleanup_kill_switch_deactivated\s*=\s*"PASS"/);
    expect(cleanupBlock).toMatch(/w1_cleanup_fixture_removed\s*=\s*"PASS"/);
  });

  it("finish() sin hard_fail-skanning dekker ALLE results-verdier generisk (Object.values(...).some(...)) - ingen spesialtilfelle trengs for de to nye nøklene", () => {
    const finishIdx = liveScriptSource.indexOf("function finish(): void");
    expect(finishIdx).toBeGreaterThan(-1);
    const finishBody = liveScriptSource.slice(finishIdx, liveScriptSource.indexOf("}", liveScriptSource.indexOf("hard_fail=", finishIdx)));
    expect(finishBody).toMatch(/Object\.values\(results\)\.some\(/);
  });

  it("toppnivå-kjøringen (await main(); finish();) er FORTSATT strukturert slik at finish() kjører rett etter main() - INGEN separat catch som hopper over den", () => {
    const topLevelIdx = liveScriptSource.lastIndexOf("await main();");
    expect(topLevelIdx).toBeGreaterThan(-1);
    const afterMain = liveScriptSource.slice(topLevelIdx, topLevelIdx + 60);
    expect(afterMain).toMatch(/await main\(\);\s*\n\s*finish\(\);/);
  });
});
