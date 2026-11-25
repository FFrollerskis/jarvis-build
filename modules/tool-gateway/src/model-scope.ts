import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WP-N1b (JARVIS-116 b, Q-76 pkt 8, K1): den MODELL-STEMPLEDE KONTEKSTEN for ett modellstyrt verktøykall - og alle NØSTEDE `ToolGateway.execute()`-kall det gjør. Samme AsyncLocalStorage-mønster som `call-signal.ts`.
 *
 * FØR: kun det øverste verktøykallet bar `ToolInvocationContext.servingModel`. Et nøstet kall (en transport som selv kaller `gateway.execute()`, f.eks. executive-tjenestens `finance.get_kill_switch`) så ingen modell, så
 * utførelseslåsen for `finance*` ble omgått, og hvert nøstet finansoppslag måtte holdes tilbake per tjeneste (kun `executive` var dekket, F-B1).
 *
 * NÅ: `ToolGateway.execute()` setter skopet ÉN gang (`runWithModelScope`, det ENESTE setter-stedet i produksjonskoden, låst av `wpn1b-model-scope-structure.test.ts`) når (1) begrenset-vakten er på (gatewayen har
 * `financeExecutionLock`) og (2) kallet er modellstyrt (`servingModel` stemplet av adapteren i `MeshToolExecutor`, aldri fra parametere). Nøstede `execute()`-kall arver skopet, så utførelseslåsen og alle sentrale lesere
 * (`withholdFinanceFromCurrentModel`, `currentServingModel`) ser SAMME modell uansett nesting-dybde.
 *
 * REGLER (alle låst av tester):
 *  - SKOPET BÆRER ET FERDIG LOKALITETSVEDTAK (`cloud`), beregnet av gatewayen med den ENE lokalitetsregelen (`financeLockServedLocally` via `FinanceExecutionLock.servedLocally`, fail-closed: ukjent/blank/kast/ikke-`true` = sky). Lesere
 *    trenger aldri en egen kopi av regelen (F2-A3: ingen fjerde kopi).
 *  - INGEN MODELL = INGET SKOP (eierens egne HTTP-ruter, `/control`, eier-godkjent bekreftelse): leserne gir `undefined`/`false`, så eieren får alt som før.
 *  - ET SKYSKOP KAN ALDRI LØSNES: et nøstet kall inne i et sky-/ukjent-betjent kall får alltid den ytre modellen, selv om det selv oppgir en lokal (gatewayen håndhever det). Et lokalt skop kan strammes inn av et nøstet kall som oppgir sky.
 *  - VAKT AV (`financeExecutionLock` utelatt = begrenset-vakten er AV): ingen skop settes noe sted, lesere gir `undefined`/`false`, og `execute()` er identisk med main.
 *  - DELT ARBEID: skopet følger den ASYNKRONE kjeden til kallet som satte det. Delt arbeid som lages av ÉN kaller og deles av flere (single-flight, cache, `Promise` i et felt) kjører derfor i den FØRSTE kallerens skop - slikt
 *    arbeid MÅ ikke lese skopet (bruk et eksplisitt valg som er del av nøkkelen, slik `ControlCenterRegistry.buildOne` gjør med `restrictFinance`). Lesere i delt arbeid er forbudt (kildevakt: `wpn1b-model-scope-structure.test.ts`).
 */

/** Modellen som betjener kallet: stemplet av adapteren (`MeshToolExecutor`), aldri fra parametere eller modellens egne argumenter. */
export interface ScopedServingModel {
  provider: string;
  model: string;
}

/** Det som ligger i skopet. `cloud` er gatewayens ferdige vedtak (sky ELLER ukjent = `true`). */
export interface ModelScope {
  readonly servingModel: ScopedServingModel;
  readonly cloud: boolean;
}

const store = new AsyncLocalStorage<ModelScope>();

/** Skopet for kallet som kjører akkurat nå, eller `undefined` (ingen modell i løkka, eller vakten er AV). */
export function currentModelScope(): ModelScope | undefined {
  return store.getStore();
}

/** Modellen som betjener det pågående kallet (også for nøstede kall), eller `undefined` uten skop. */
export function currentServingModel(): ScopedServingModel | undefined {
  return store.getStore()?.servingModel;
}

/**
 * SENTRAL LESER: skal finansavledet innhold holdes tilbake fra modellen som betjener det pågående kallet? `true` KUN når et skop finnes OG gatewayen har vurdert modellen som sky/ukjent. Uten skop (eierens ruter, lokal modell
 * er `cloud: false`, vakten AV) er svaret `false`: ingenting holdes tilbake, identisk med main. Eksakt `true` kreves (alt annet, også en manglende verdi i skopet, er «ikke avgjort» og regnes av `runWithModelScope` som sky).
 */
export function withholdFinanceFromCurrentModel(): boolean {
  return store.getStore()?.cloud === true;
}

/**
 * Setter skopet for `fn` og alt `fn` starter (også nøstede `execute()`-kall). ENESTE kallsted i produksjonskoden: `ToolGateway.execute()`. FAIL-CLOSED: `cloud` er `true` med mindre kalleren eksplisitt sier `false`
 * (en utelatt/ugyldig verdi regnes som sky).
 */
export function runWithModelScope<T>(scope: { servingModel: ScopedServingModel; cloud?: boolean }, fn: () => T): T {
  const frozen: ModelScope = Object.freeze({ servingModel: scope.servingModel, cloud: scope.cloud !== false });
  return store.run(frozen, fn);
}
