/**
 * D-386 - LIVE evalueringsskript for embedding-kvalitet på norsk (MEMORY_ARCHITECTURE §9, første trinn).
 *
 * Kjører mot den FAKTISKE embedding-provideren som er konfigurert i miljøet (`createEmbeddingProviderFromEnv`, dvs. Ollama/bge-m3
 * når `JARVIS_EMBEDDING_PROVIDER=ollama`), uten database: 40 norske fakta og 40 parafraserte spørsmål; rapporterer recall@1/@3
 * (riktig faktum blant de 1/3 mest like) og median-latens. Samme sett kjøres også mot `LocalHashEmbedding` for å vise forskjellen.
 *
 * Kjøring i api-containeren på NAS:
 *   docker compose -f infra/local/docker-compose.yml exec api node --experimental-transform-types ops/memory/embedding-eval-live.ts
 * Lokalt: JARVIS_EMBEDDING_PROVIDER=ollama JARVIS_EMBEDDING_URL=http://100.101.102.103:11434 node --experimental-transform-types ops/memory/embedding-eval-live.ts
 *
 * Ingen hemmeligheter, ingen skriving. Resultatet er BEVIS for D-386-påstanden «semantisk gjenfinning virker på norsk», ikke en
 * påstand i seg selv - kopier utskriften inn i PR/decision-loggen.
 */
import { createEmbeddingProviderFromEnv, LocalHashEmbedding, type EmbeddingProvider } from "@jarvis/memory";

const PAIRS: ReadonlyArray<{ fact: string; question: string }> = [
  { fact: "Tobias har en hund som heter Rex.", question: "hva heter hunden min?" },
  { fact: "Søsteren til Tobias heter Ida og bor i Tromsø.", question: "hvor bor søstera mi?" },
  { fact: "Tobias foretrekker korte svar om morgenen.", question: "hvordan vil jeg ha svarene tidlig på dagen?" },
  { fact: "Tobias kjører en rød Volvo XC60 fra 2021.", question: "hvilken bil har jeg?" },
  { fact: "Pappa til Tobias heter Henrik og er pensjonert lærer.", question: "hva jobbet faren min med?" },
  { fact: "Hytta ligger på Hafjell og ble kjøpt i 2019.", question: "når kjøpte vi hytta?" },
  { fact: "Tobias skal til tannlegen fredag 9. oktober klokken 10.", question: "når har jeg tannlegetime?" },
  { fact: "Dennis er kunde hos Kundeoppfølging AS og har kontrakt ut 2026.", question: "hvor lenge varer avtalen med Dennis?" },
  { fact: "Tobias drikker ikke kaffe, bare te.", question: "liker jeg kaffe?" },
  { fact: "Jarvis-prosjektet bruker Postgres med pgvector på NAS-en.", question: "hvilken database kjører jarvis på?" },
  { fact: "Tobias sin mor heter Anne og fyller 60 år 3. mars.", question: "når har mamma bursdag?" },
  { fact: "Lønnen fra Kundeoppfølging AS kommer den 15. hver måned.", question: "hvilken dato får jeg lønn?" },
  { fact: "Tobias trener styrke på Sats tirsdag og torsdag.", question: "hvilke dager trener jeg?" },
  { fact: "Nettsiden deployes med Vercel og trenger env-variabelen SANITY_TOKEN.", question: "hvordan deployer jeg nettsiden?" },
  { fact: "Tobias er allergisk mot skalldyr.", question: "er det noe mat jeg ikke tåler?" },
  { fact: "Ferien i sommer går til Kroatia i uke 28.", question: "hvor skal vi på ferie?" },
  { fact: "Tobias bruker Todoist til oppgaver og Notion til notater.", question: "hvilken app bruker jeg til gjøremål?" },
  { fact: "Møtet med Linda om markedsplanen er flyttet til mandag.", question: "når er møtet med Linda?" },
  { fact: "Tobias betaler 14 500 kroner i husleie per måned.", question: "hvor mye koster leiligheten?" },
  { fact: "Printeren hjemme er en HP OfficeJet og står på kontoret.", question: "hvilken skriver har jeg?" },
  { fact: "Tobias foretrekker å bli vekket klokken 06:30 på hverdager.", question: "når vil jeg stå opp?" },
  { fact: "Bilen skal på EU-kontroll innen 30. november.", question: "når må bilen på kontroll?" },
  { fact: "Tobias sin bestevenn heter Martin og bor i Bergen.", question: "hvor bor kompisen min Martin?" },
  { fact: "Vi bestilte bord på Maaemo til 20. desember.", question: "hvilken restaurant skal vi til i desember?" },
  { fact: "Kundeoppfølging AS har organisasjonsnummer 912 345 678.", question: "hva er org.nummeret til firmaet?" },
  { fact: "Tobias lærer seg spansk med Duolingo hver kveld.", question: "hvilket språk holder jeg på å lære?" },
  { fact: "Strømavtalen er spotpris hos Tibber.", question: "hvem er strømleverandøren min?" },
  { fact: "Tobias liker ikke å få lange lister i talesvar.", question: "hvordan vil jeg ha svar når jeg snakker?" },
  { fact: "Hunden Rex skal til veterinæren for vaksine i april.", question: "når skal hunden vaksineres?" },
  { fact: "Tobias sitt favorittlag er Rosenborg.", question: "hvilket fotballag heier jeg på?" },
  { fact: "Passordskapet er Infisical, og nøkler roteres hvert kvartal.", question: "hvor ofte bytter vi nøkler?" },
  { fact: "Nabo Kari passer katten når vi er bortreist.", question: "hvem tar seg av katten når vi reiser?" },
  { fact: "Tobias har bestilt ny mobil, en Pixel 9, levering neste uke.", question: "hvilken telefon kommer i posten?" },
  { fact: "Regnskapet sendes til regnskapsfører Per innen den 5. hver måned.", question: "når må bilagene sendes til regnskap?" },
  { fact: "Tobias foretrekker vindusplass på fly.", question: "hvor vil jeg sitte på flyet?" },
  { fact: "Barnas skole har planleggingsdag 15. november.", question: "når er det fri fra skolen i november?" },
  { fact: "Tobias sin fastlege er på Grünerløkka legesenter.", question: "hvor er legen min?" },
  { fact: "Vi bruker Slack-kanalen #drift til varsler fra NAS-en.", question: "hvor kommer driftsvarslene?" },
  { fact: "Tobias har gift seg med Maria i 2018.", question: "når giftet jeg meg?" },
  { fact: "Hagen skal få ny terrasse til våren, budsjett 80 000 kroner.", question: "hva koster terrassen?" }
];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += (a[i] ?? 0) * (b[i] ?? 0); na += (a[i] ?? 0) ** 2; nb += (b[i] ?? 0) ** 2; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function evaluate(provider: EmbeddingProvider): Promise<{ recall1: number; recall3: number; medianMs: number; misses: string[] }> {
  const facts = await provider.embedBatch(PAIRS.map((p) => p.fact));
  const latencies: number[] = [];
  let hit1 = 0, hit3 = 0;
  const misses: string[] = [];
  for (let i = 0; i < PAIRS.length; i++) {
    const t0 = Date.now();
    const q = await provider.embed(PAIRS[i]!.question);
    latencies.push(Date.now() - t0);
    const ranked = facts.map((f, j) => ({ j, sim: cosine(q, f) })).sort((a, b) => b.sim - a.sim);
    const rank = ranked.findIndex((r) => r.j === i);
    if (rank === 0) hit1++;
    if (rank >= 0 && rank < 3) hit3++;
    else misses.push(`${PAIRS[i]!.question} → #${rank + 1} (topp: «${PAIRS[ranked[0]!.j]!.fact}»)`);
  }
  latencies.sort((a, b) => a - b);
  return { recall1: hit1 / PAIRS.length, recall3: hit3 / PAIRS.length, medianMs: latencies[Math.floor(latencies.length / 2)] ?? 0, misses };
}

const configured = createEmbeddingProviderFromEnv();
console.log(JSON.stringify({ msg: "embedding_eval_start", model: configured.model, dim: configured.dim, pairs: PAIRS.length }));
const hash = await evaluate(new LocalHashEmbedding());
console.log(JSON.stringify({ provider: "local-hash-v1", recall_at_1: hash.recall1, recall_at_3: hash.recall3, median_ms: hash.medianMs }));
if (configured.model !== "local-hash-v1") {
  const real = await evaluate(configured);
  console.log(JSON.stringify({ provider: configured.model, recall_at_1: real.recall1, recall_at_3: real.recall3, median_ms: real.medianMs }));
  for (const m of real.misses) console.log(`  bom: ${m}`);
  const verdict = real.recall3 >= 0.85 ? "PASS" : "FAIL";
  console.log(JSON.stringify({ msg: "embedding_eval_verdict", verdict, threshold_recall_at_3: 0.85, model: configured.model }));
  process.exitCode = verdict === "PASS" ? 0 : 1;
} else {
  console.log(JSON.stringify({ msg: "embedding_eval_skipped_real_model", reason: "JARVIS_EMBEDDING_PROVIDER er ikke ollama - kun hash-baseline kjørt" }));
  process.exitCode = 2;
}
