# Voice Gateway + Personal Digital Twin Audit Report

**Slice:** `apps/voice-gateway/`, `modules/health/`, `modules/location/`, `modules/vision/`
**Files read:** 55 of 55 (28 voice-gateway, 10 health, 8 location, 9 vision) — full enumeration verified via `find`, every file opened and read in full.
**Method:** static read of every file + targeted greps against `packages/contracts`, `modules/core` migrations, `apps/api/src/{main,conversation}.ts`, `infra/local/docker-compose.yml`, and the relevant DPIA/architecture docs; one empirical Node probe to test an unhandled-`error`-event hypothesis (see A1). DB-backed tests were not executed (`initdb: Permission denied` sandbox limitation, per instructions).

---

## A — Bugs / holes

**A1 — P1 — `apps/voice-gateway/src/tts.ts:191-216` (`LocalPiperTts.generate`)**
Claim: the spawned `piper` child process has no `proc.once("error", …)` handler, so a spawn failure (ENOENT from a misconfigured `JARVIS_PIPER_BIN`, permission denied, deleted binary) is an unhandled `'error'` event that crashes the **entire** voice-gateway Node process, not just the current TTS call. Verified empirically: a minimal repro (`spawn` a nonexistent binary, no `'error'` listener, then `for await` over `stdout`) throws `UNCAUGHT: ENOENT` and kills the process on Node 22.22.2 (this repo's `apps/voice-gateway/package.json` targets Node 22). Contrast with the sibling adapter `LocalWhisperStt` in `stt.ts:224-227`, which correctly does `proc.once("error", reject)` before awaiting — confirming this is an asymmetric oversight, not an intentional choice. `available()` only checks env vars are set (`stt.ts:197-199`, `tts.ts:168-170`), never that the binary actually exists, so this is reachable the moment `JARVIS_PIPER_BIN` points at a bad path.
Fix: add `proc.once("error", (err) => { /* surface via a promise the generator awaits, or rethrow */ })` mirroring `stt.ts`'s pattern before the `for await (const chunk of proc.stdout)` loop.

**A2 — P2 — `apps/voice-gateway/src/server.ts:265` (`new WebSocketServer({ server })`)**
Claim: no `maxPayload` is passed, so `ws`'s default of 100 MiB per message applies (confirmed in `node_modules/.../ws/lib/websocket-server.js:74`). The `"audio"` handler (`server.ts:461-466`) does `Buffer.from(String(message["data"]), "base64")` with no size/shape check before feeding the frame through `rmsEnergy`/VAD/STT (`session.ts:232-261`, `audio.ts:10-21`). A client (malicious or buggy) can send single ~100 MB frames repeatedly — DoS via memory/CPU spikes, with no protocol-level frame-size cap even though the documented frame contract is ~640 bytes (20 ms @16 kHz PCM16, per `session.ts`/test fixtures).
Fix: pass a small `maxPayload` (a few KB) to `WebSocketServer`, and/or reject `"audio"` messages whose decoded buffer length exceeds an expected bound before it reaches the VAD/STT chain.

**A3 — P3 — `apps/voice-gateway/src/server.ts:461-468`**
Claim: `String(message["data"])` / `String(message["utterance_id"])` on a missing field silently coerces to the literal string `"undefined"` (e.g. `Buffer.from("undefined","base64")` decodes to garbage bytes) instead of returning a validation error. Not a security hole (authority/routing gates still apply first) but a malformed-input class that fails silently rather than reporting `invalid_message`.
Fix: validate presence/type of `data`/`utterance_id`/`text` before use; emit `{type:"error", error:"malformed_message"}` otherwise.

---

## B — Placeholders / stubs / dead code

**B1 — P3 — `modules/health/src/fake-source.ts`, `modules/vision/src/fake-source.ts`**
Claim: `FakeHealthMetricSource`/`FakeVisionEventSource` are re-exported from each package's public barrel (`index.ts:3` in both packages via `export * from "./fake-source.ts"`), yet a repo-wide grep (excluding `test/`) shows zero production references — confirmed unreachable from `apps/api/src/main.ts` or anywhere else. Not a security issue (they do nothing dangerous), but since there is currently no real `HealthMetricSource`/`VisionEventSource` implementation anywhere in the tree, "Fake" is today the *only* concrete implementation of each interface reachable via the public package export.
Fix: move the Fake* classes to a test-only export path (or leave undocumented in the package README) so a future consumer doesn't import them believing they're a real adapter.

**B2 — P3 — `apps/voice-gateway/src/main.ts:17-22` (local whisper.cpp/piper tier)**
Claim: fully implemented and unit-tested (`test/local-whisper-stt.test.ts`, `test/local-piper-tts.test.ts`) against faked binaries, but unreachable in the only wired deployment path — see C1 below for the concrete gap. It's real code, not a stub, but it's dead in practice until compose/docs are updated.

---

## C — Gaps

**C1 — P2 — undocumented/unwired env vars — `apps/voice-gateway/src/stt.ts:188-193`, `tts.ts:163-165`, `infra/local/docker-compose.yml:196-224`**
Claim: `JARVIS_WHISPER_BIN`/`JARVIS_WHISPER_MODEL`/`JARVIS_WHISPER_LANG`/`JARVIS_PIPER_BIN`/`JARVIS_PIPER_MODEL` appear only inside `apps/voice-gateway/src/{stt,tts,main}.ts` — grepped across the whole repo (excluding node_modules), they are absent from every `docs/*.md` file and from `infra/local/docker-compose.yml`'s `voice-gateway` service, which only sets `JARVIS_VOICE_PORT`/`JARVIS_CORE_URL`/`OPENAI_API_KEY`. This contradicts CLAUDE.md rule 9 ("alt skal kjøre i Docker på Tobias sin PC") for this specific tier: a user who sets these vars in `.env` still won't have them forwarded into the container.
Fix: add the five vars to `docker-compose.yml`'s `voice-gateway.environment` block (with `${VAR:-}` defaults) and document them in `docs/VOICE_ARCHITECTURE.md` or `docs/VOICE_BENCHMARK.md`.

**C2 — P2 — unverified local-binary CLI contract — `apps/voice-gateway/src/stt.ts:167-177`, `tts.ts:142-151`**
Claim: both adapters explicitly, honestly disclose (per D-41 discipline) that they have never been run against a real installed whisper.cpp/piper binary — the exact flags (`-f -` for stdin, `--output_raw`) are assumptions from public docs, subprocess/error-handling code is only tested against shell-script fakes (`test/fixtures/mock-{whisper,piper}-*.sh`). This is correctly flagged in-code as UNVERIFIED — marking it here per the audit brief's "say unverified" instruction; it is a genuine, currently-open capability gap, not a code defect.

**C3 — P3 — self-attested processor verification — `docs/security/PROCESSOR_REGION_MATRIX.md:20-34`, mirrored in `stt.ts:94-99`/`tts.ts:81-86`**
Claim: the `processor_terms_status: "VERIFIED"` flag that gates OpenAI STT/TTS through `evaluateSpeechRouting()` (enforced at call time — confirmed: `session.ts:218-219` evaluates routing at construction, and `pushAudio`/`enqueueTts`/`speakNext` re-check `.allowed` before every frame/chunk, `session.ts:237-243`, `428-431`, `456-460`) is based entirely on Tobias's own reading of the OpenAI dashboard/FAQ on 2026-09-22, with the matrix itself noting "ingen dato-/versjonsreferanse notert" for the DPA approval. Code and docs are **consistent with each other** (no drift), but the underlying verification is thin (self-attested, no pinned document version) for a flag that gates a P0/D-41 compliance decision.
Fix: pin an actual OpenAI DPA document ID/version and re-verify periodically; not a code change.

**C4 — P3 — no session-duration/idle cap independent of grant TTL — `apps/voice-gateway/src/server.ts`, `session.ts`**
Claim: `activeSession()` (`server.ts:439-455`) re-checks grant expiry on every audio frame for the `SERVER_VERIFIED` path, which is correct — but a `CLIENT_ASSERTED` (unproven) session has no grant to expire at all (`server.ts:444-446`, "ubevist sti — ingen grant å utløpe"), so an unauthenticated WS connection can stay open indefinitely running local STT/TTS turns until the client disconnects. Not a data-exfiltration risk (local-only, D-122 rule 1), but there is no gateway-enforced max-session-duration/idle-timeout or connection-count cap.
Fix: add an idle/duration cap in `createVoiceGateway`'s `ws.on("connection")` handler for the unproven path, independent of grant TTL.

---

## D — Improvements

**D1 — `apps/voice-gateway/src/stt.ts:197-199`, `tts.ts:168-170`**
`available()` only checks env vars are set, never that the path is executable. Combined with A1, a bad `JARVIS_PIPER_BIN` currently crashes the process instead of surfacing as `VoiceHealth`'s `UNAVAILABLE` state. Suggest an `fs.access(path, X_OK)` probe at `main.ts` startup so misconfiguration degrades gracefully (observable via `/status`) rather than only being caught by fixing A1.

**D2 — `modules/health/src/sweep.ts`, `modules/location/src/sweep.ts`, `modules/vision/src/sweep.ts`**
The three `run*RetentionSweepForAllTenants` functions are near-identical (fetch tenants, try/catch per unit, structured `console.error` + collect failures). Verified correctly wired into `apps/api/src/main.ts`'s `DailyScheduler` (lines ~1103/1111/1120), so this is pure duplication, not a functional gap — a shared generic sweep-runner would reduce boilerplate.

**D3 — `modules/vision/src/service.ts:258-302` (`insertValidatedInTransaction`)**
Well-designed and well-tested (idempotent dedupe key including `source_instance_id`, payload-fingerprint-verified replay, retention anchored on `now()` not client-supplied `observed_at`) — no change needed. Noting only for completeness that this is the most defensively-written file in the slice.

---

## E — Doc/code drift

**E1 — no drift found — `docs/VOICE_ARCHITECTURE.md` §5 (fast path) vs `apps/api/src/conversation.ts`**
Claim: rule 6 ("rask bane hopper over LLM, aldri over Policy Gateway") — verified for the LLM-skip half: `handleFastIntent()` (`conversation.ts:363-410`) never touches `ModelGateway`, and every branch (`system_status`, `help`, `create_task`, `task_status`, `home_light`, `cancel_task`) returns `routed:"fast"` directly. `voice-e2e.test.ts`'s "Akseptanse 3" proves this end-to-end over the real WS transport (a "status" utterance yields `routed:"fast"` in both the `reply` and `metrics` messages). The "never skips Policy Gateway" half is **unverified by me**: task creation/cancellation route through `apps/api/src/server.ts`'s `TaskService`/`PolicyGateway` wiring, which is outside this slice's assigned files — I did not read that file in full, so I cannot independently confirm the PolicyGateway call happens on the fast path rather than just report what conversation.ts calls.

**E2 — no drift found — `docs/UA9_VISION_DPIA.md` "ingen rå bilde-/videobytes / snapshot_ref forbudt" vs `modules/vision`**
Verified enforced at three independent layers: zod `.strict()` input schema (`types.ts:106-118`) has no `snapshot_ref` field at all, `VisionService` never writes one, and `055_vision.sql`'s `CHECK (snapshot_ref IS NULL)` blocks even a raw INSERT — confirmed by `service-rls.test.ts` block B's direct-SQL test against the CHECK constraint.

**E3 — no drift found — `docs/UA8_PERSONAL_TWIN_DPIA.md` health-space isolation vs `modules/health`**
Verified: `051_health.sql`'s `CHECK (memory_space_id = 'health')` plus RESTRICTIVE RLS, both independently proven in `service-rls.test.ts` blocks E ("CHECK avviser en rad med memory_space_id = 'personal'") and F (RLS session scoped to `personal,business` sees zero health rows).

---

## 5-line health summary

The trust boundary (device-proof → grant → `SERVER_VERIFIED`/`CLIENT_ASSERTED` → per-frame `evaluateSpeechRouting()`) is rigorously built and adversarially tested — every audio frame and TTS chunk is gated before reaching an adapter, with zero bypass found. The one real defect is a genuine crash bug: a misconfigured local Piper binary path takes down the entire voice-gateway process (A1, P1), asymmetric with the correctly-guarded Whisper sibling. The WS transport has no frame-size cap, a real (if lower-severity) DoS gap (A2). Health/location/vision retention sweeps, RLS, and DPIA data-minimization promises (no snapshots, health-space lock) are all verified enforced at the DB layer, not just in application code, and are correctly wired into the daily scheduler in `apps/api/src/main.ts`. The local whisper.cpp/piper tier is solid, honestly-disclosed-as-unverified code that is currently dead in the standard Docker deployment path because its five env vars are neither wired into compose nor documented (C1).
