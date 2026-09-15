import { describe, it, expect } from "vitest";

import {
  EXPECTED_HEAD_FIELD,
  HEAD_TIER,
  declaredExpectedHead,
  headTierFor,
  selectNextTask
} from "../lib/queue.mjs";
import { TASK_STATUS } from "../lib/state.mjs";
import { entryOf, orderComment } from "./fixtures/authority-entries.mjs";

/**
 * D-139: EN STALE ORDRE KAN ALDRI PREEMPTE EN GJELDENDE ORDRE.
 *
 * Den observerte, farlige tilstanden paa hosten: to aldri-utsendte
 * ARCHITECT_TASK laa i koeen samtidig. Den ELDSTE navnga head `4df1472`, som
 * repoet for lengst hadde forlatt; den NYESTE navnga den faktiske head-en.
 * Begge var "fresh", og ferske tasks sorteres eldst-foerst - saa workeren ville
 * valgt den utdaterte, som ville feilet sin egen pre-flight og brukt opp et
 * forsoek, mens den levende ordren ventet.
 *
 * Testene her er bevisst skrevet mot INVARIANTEN, ikke mot de to TASK_ID-ene:
 * det som avgjoer er forholdet mellom deklarert og observert head.
 */

const HEAD_CURRENT = "4315c631cd5528f209ddb90256d868e8ce5da2ea";
const HEAD_STALE = "4df1472ca4f9f6cf25695255691c0a2d945cf472";

/**
 * D-151: entries go through the REAL authority classifier.
 *
 * They used to be hand-assembled `{ ..., uniqueAuthority: true }` literals, which
 * pre-declared the very verdict this suite is now allowed to depend on.
 */
function task(taskId, { createdAt, commentId, head = null, attempts = 0, extraBody = "" }) {
  const body = [
    "ARCHITECT_TASK",
    `TASK_ID=${taskId}`,
    head ? `${EXPECTED_HEAD_FIELD}=${head}` : "",
    extraBody
  ].filter(Boolean).join("\n");
  const comment = orderComment({ taskId, id: commentId, createdAt, body });
  return {
    entry: entryOf([comment], taskId),
    record: attempts > 0 ? { attempts, status: TASK_STATUS.FAILED_RETRYABLE, next_eligible_at: "1970-01-01T00:00:00.000Z" } : null
  };
}

function select(tasks, observedHead) {
  const state = { tasks: {} };
  for (const t of tasks) if (t.record) state.tasks[t.entry.taskId] = { task_id: t.entry.taskId, ...t.record };
  return selectNextTask({
    tasks: tasks.map((t) => t.entry),
    state,
    comments: [],
    trustedAuthor: "tsworkflow",
    nowMs: Date.parse("2026-09-14T12:00:00Z"),
    observedHead
  });
}

describe("declaredExpectedHead leser KUN den betrodde task-kommentaren", () => {
  it("leser EXPECTED_HEAD_SHA fra selve ordren", () => {
    const t = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_CURRENT });
    expect(declaredExpectedHead(t.entry)).toBe(HEAD_CURRENT);
  });

  it("en ordre uten feltet deklarerer ingenting", () => {
    const t = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1 });
    expect(declaredExpectedHead(t.entry)).toBe(null);
  });

  it("D-150: en same-id 'scope-update' flytter INGENTING - den er en andre ordre", () => {
    // Fram til D-150 ble `entry.updates` foldet inn med SIST-VINNER, slik at en
    // forfalsket duplikat kunne re-peke EXPECTED_HEAD_SHA og flytte tasken
    // mellom head-tiere. Same-id-oppdateringer er fjernet som eksekverbar
    // semantikk; en ikke-unik autoritet deklarerer ingenting i det hele tatt.
    // D-151: the duplicate is a REAL second comment classified by the REAL gate,
    // not a flag set on a hand-built entry.
    const original = orderComment({
      taskId: "A-20260101-A", id: 1, createdAt: "2026-01-01T00:00:00Z",
      body: `ARCHITECT_TASK\nTASK_ID=A-20260101-A\n${EXPECTED_HEAD_FIELD}=${HEAD_STALE}`
    });
    const forged = orderComment({
      taskId: "A-20260101-A", id: 2, createdAt: "2026-01-01T01:00:00Z",
      body: `ARCHITECT_TASK\nTASK_ID=A-20260101-A\n${EXPECTED_HEAD_FIELD}=${HEAD_CURRENT}`
    });
    const entry = entryOf([original, forged], "A-20260101-A");
    expect(entry.admissible).toBe(false);
    expect(declaredExpectedHead(entry)).toBe(null);
  });

  it("D-151: en UNIK men REDIGERT ordre deklarerer heller ingen head", () => {
    // `uniqueAuthority` var en TELLING, og en telling ser ingen redigering. En
    // ordre som ble gjennomgaatt med én head og naa navngir en annen kunne
    // dermed fortsatt flytte tasken mellom head-tiere.
    const edited = orderComment({
      taskId: "A-20260101-A",
      id: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T09:00:00Z",
      body: `ARCHITECT_TASK\nTASK_ID=A-20260101-A\n${EXPECTED_HEAD_FIELD}=${HEAD_CURRENT}`
    });
    const entry = entryOf([edited], "A-20260101-A");
    expect(entry.admissible).toBe(false);
    expect(declaredExpectedHead(entry)).toBe(null);
  });

  it("D-151: en ordre uten brukbar comment-id eller created_at deklarerer ingen head", () => {
    const noId = orderComment({
      taskId: "A-20260101-A", id: null, createdAt: "2026-01-01T00:00:00Z",
      body: `ARCHITECT_TASK\nTASK_ID=A-20260101-A\n${EXPECTED_HEAD_FIELD}=${HEAD_CURRENT}`
    });
    expect(declaredExpectedHead(entryOf([noId], "A-20260101-A"))).toBe(null);

    const noTime = orderComment({
      taskId: "A-20260101-A", id: 1, createdAt: "ikke-et-tidspunkt",
      body: `ARCHITECT_TASK\nTASK_ID=A-20260101-A\n${EXPECTED_HEAD_FIELD}=${HEAD_CURRENT}`
    });
    expect(declaredExpectedHead(entryOf([noTime], "A-20260101-A"))).toBe(null);
  });

  it("D-150: en unik ordre som nevner feltet to ganger bruker den siste linjen", () => {
    // Innenfor ÉN ordre er to linjer arkitektens egen tekst, ikke to autoriteter.
    const t = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    t.entry.comment.body += `\n${EXPECTED_HEAD_FIELD}=${HEAD_CURRENT}`;
    expect(declaredExpectedHead(t.entry)).toBe(HEAD_CURRENT);
  });

  it("soppel i feltet deklarerer ingenting - det gjettes aldri", () => {
    const t = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1 });
    t.entry.comment.body += `\n${EXPECTED_HEAD_FIELD}=ikke-en-sha`;
    expect(declaredExpectedHead(t.entry)).toBe(null);
  });
});

describe("headTierFor: deklarert mot observert", () => {
  it("lik sha er CURRENT", () => expect(headTierFor(HEAD_CURRENT, HEAD_CURRENT)).toBe(HEAD_TIER.CURRENT));
  it("ulik sha er STALE", () => expect(headTierFor(HEAD_STALE, HEAD_CURRENT)).toBe(HEAD_TIER.STALE));
  it("forkortet deklarasjon som er prefiks er CURRENT", () =>
    expect(headTierFor(HEAD_CURRENT.slice(0, 8), HEAD_CURRENT)).toBe(HEAD_TIER.CURRENT));
  it("forkortet deklarasjon som IKKE er prefiks er STALE", () =>
    expect(headTierFor(HEAD_STALE.slice(0, 8), HEAD_CURRENT)).toBe(HEAD_TIER.STALE));
  it("ingen deklarasjon er UNDECLARED", () => expect(headTierFor(null, HEAD_CURRENT)).toBe(HEAD_TIER.UNDECLARED));
  it("en head vi IKKE kunne lese gjoer ingen ordre stale", () =>
    expect(headTierFor(HEAD_STALE, null)).toBe(HEAD_TIER.UNDECLARED));
  it("case-forskjell er ikke en forskjell", () =>
    expect(headTierFor(HEAD_CURRENT.toUpperCase().toLowerCase(), HEAD_CURRENT.toUpperCase())).toBe(HEAD_TIER.CURRENT));
});

describe("D-139: utvelgelsen - stale preempter aldri gjeldende", () => {
  it("reproduserer den EKSAKTE host-tilstanden: eldre stale vs. nyere gjeldende", () => {
    const stale = task("D136-PR80-CRASH-WINDOW-PROVENANCE-E2E-20260913-A", {
      createdAt: "2026-09-13T16:29:27Z", commentId: 5654535038, head: HEAD_STALE
    });
    const current = task("D139-PR80-PORT-LEASE-DIRTY-GATE-20260914-A", {
      createdAt: "2026-09-13T23:33:15Z", commentId: 5657063418, head: HEAD_CURRENT
    });

    // Foer fiksen valgte sorteringen den ELDSTE ferske - altsaa den utdaterte.
    const chosen = select([stale, current], HEAD_CURRENT);
    expect(chosen.candidate.taskId).toBe("D139-PR80-PORT-LEASE-DIRTY-GATE-20260914-A");
    expect(chosen.candidateHeadTier).toBe(HEAD_TIER.CURRENT);
    expect(chosen.observedHead).toBe(HEAD_CURRENT);
  });

  it("en STALE fersk ordre taper til og med mot en CURRENT RETRY", () => {
    const staleFresh = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    const currentRetry = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_CURRENT, attempts: 2 });
    const chosen = select([staleFresh, currentRetry], HEAD_CURRENT);
    expect(chosen.candidate.taskId).toBe("B-20260102-A");
  });

  it("en ordre som ikke deklarerer head taper mot en som navngir den observerte", () => {
    const undeclared = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1 });
    const current = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_CURRENT });
    expect(select([undeclared, current], HEAD_CURRENT).candidate.taskId).toBe("B-20260102-A");
  });

  it("men en udeklarert ordre slaar en STALE - den er i det minste utfoerbar", () => {
    const undeclared = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1 });
    const stale = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_STALE });
    expect(select([undeclared, stale], HEAD_CURRENT).candidate.taskId).toBe("A-20260101-A");
  });

  it("en stale ordre STRANDER ikke koeen: den kjoerer naar ingenting gjeldende finnes", () => {
    const stale = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    const chosen = select([stale], HEAD_CURRENT);
    expect(chosen.candidate.taskId).toBe("A-20260101-A");
    expect(chosen.candidateHeadTier).toBe(HEAD_TIER.STALE);
  });

  it("naar head-en IKKE kan leses, endres ingen rekkefoelge - vi gjetter aldri stale", () => {
    const older = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    const newer = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_CURRENT });
    // Uten observert head er begge UNDECLARED, og den gamle eldst-foerst-regelen gjelder.
    expect(select([older, newer], null).candidate.taskId).toBe("A-20260101-A");
  });

  it("hver beslutning oppgir head-tier og deklarert head, ikke bare rekkefoelgen", () => {
    const stale = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    const current = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_CURRENT });
    const result = select([stale, current], HEAD_CURRENT);
    const byId = Object.fromEntries(result.decisions.map((d) => [d.taskId, d]));
    expect(byId["A-20260101-A"].headTier).toBe(HEAD_TIER.STALE);
    expect(byId["A-20260101-A"].expectedHead).toBe(HEAD_STALE);
    expect(byId["A-20260101-A"].headMatchesObserved).toBe(false);
    expect(byId["B-20260102-A"].headTier).toBe(HEAD_TIER.CURRENT);
    expect(byId["B-20260102-A"].headMatchesObserved).toBe(true);
  });

  it("ordningen er TOTAL og deterministisk - samme koe gir samme valg hver gang", () => {
    const a = task("A-20260101-A", { createdAt: "2026-01-01T00:00:00Z", commentId: 1, head: HEAD_STALE });
    const b = task("B-20260102-A", { createdAt: "2026-01-02T00:00:00Z", commentId: 2, head: HEAD_CURRENT });
    const c = task("C-20260103-A", { createdAt: "2026-01-03T00:00:00Z", commentId: 3, head: HEAD_CURRENT });
    const picks = new Set();
    for (let i = 0; i < 25; i++) picks.add(select([a, b, c], HEAD_CURRENT).candidate.taskId);
    expect([...picks]).toEqual(["B-20260102-A"]);
  });
});
