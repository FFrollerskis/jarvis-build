import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { FakeHomeAssistant } from "../../../modules/tool-gateway/test/support/fake-home-assistant.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2 fiks-runde 2 (delta-review A, NY-2/D05): domenets ventetid (`settleMsByDomain`) når FAKTISK HA-transporten gjennom selve oppkoblingen. Uten pass-through i `createPersonalWiring` falt alarmen stille tilbake til den globale
 * ventetiden (20 s): en alarm med 30 s utgangsforsinkelse ble en falsk UKJENT (A-M1 tilbake), og ingen test merket det. Her drives de ferdig oppkoblede verktøyene (`wiring.tools[i].transport`) mot en fake HA med virtuell klokke.
 */
const identity: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };
let ha: FakeHomeAssistant;
beforeAll(async () => { ha = new FakeHomeAssistant(); await ha.start(); });
afterAll(async () => { await ha?.stop(); });
beforeEach(() => ha.reset());

interface Wait { settled: boolean; matched: boolean; polls: number; state: { state: string } | null }

function wired(env: Record<string, string>) {
  let t = 0;
  const wiring = createPersonalWiring({
    env: { JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_HOME_TARGETS: "alarm_control_panel.home,lock.front_door", ...env },
    pool: {} as never, gateway: {} as never, readSecret: async (ref) => (ref === "JARVIS_HA_BASE_URL" ? ha.baseUrl : null),
    homeTimers: { now: () => t, sleep: async (ms) => { t += ms; } }
  });
  const invoke = async (action: string, params: Record<string, JsonValue>): Promise<Wait> => {
    const def = wiring.tools.find((x) => x.tool_id === "home-assistant" && x.action === action);
    expect(def, action).toBeDefined();
    return (await def!.transport.invoke(action, params, ha.token, { identity })).data as unknown as Wait;
  };
  return { invoke, clock: () => t };
}

describe("oppkoblingen sender domenets ventetid til transporten (settleMsByDomain)", () => {
  it("standard: alarmen venter 90 s (en armering med 30 s utgangsforsinkelse verifiseres), mens en lås som aldri slår inn gis opp etter de globale 20 s", async () => {
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 30;
    const alarm = wired({});
    expect(await alarm.invoke("critical_alarm", { entity: "alarm_control_panel.home", armed: true })).toMatchObject({ matched: true, polls: 31 });
    expect(alarm.clock()).toBeGreaterThanOrEqual(30_000);

    ha.reset();
    ha.set("lock.front_door", { state: "unlocked", mode: "ineffective" });
    const lock = wired({});
    expect(await lock.invoke("critical_lock", { entity: "lock.front_door", locked: true })).toMatchObject({ matched: false });
    expect(lock.clock()).toBeGreaterThanOrEqual(19_000);
    expect(lock.clock()).toBeLessThan(30_000);
  });

  it("`JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN` virker gjennom oppkoblingen: kortere frist for alarmen gir opp en 45 s lang armering, lengre verifiserer den, og en kort frist for låsen brukes (ikke de globale 20 s)", async () => {
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 45;
    const short = wired({ JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN: "alarm_control_panel=40000" });
    expect(await short.invoke("critical_alarm", { entity: "alarm_control_panel.home", armed: true })).toMatchObject({ matched: false, state: { state: "arming" } });

    ha.reset();
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 45;
    const long = wired({ JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN: "alarm_control_panel=60000" });
    expect(await long.invoke("critical_alarm", { entity: "alarm_control_panel.home", armed: true })).toMatchObject({ matched: true });

    ha.reset();
    ha.set("lock.front_door", { state: "unlocked", mode: "ineffective" });
    const lock = wired({ JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN: "lock=3000" });
    expect(await lock.invoke("critical_lock", { entity: "lock.front_door", locked: true })).toMatchObject({ matched: false });
    expect(lock.clock()).toBeLessThan(8_000); // domenets 3 s, ikke de globale 20 s
  });
});
