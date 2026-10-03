# NEXT.md — Day 2 and after (from STEP 10, 2026-10-03)

Day-1 board: `npm run verify` **23/23 PASS** (fake). Live: 12 pass · 1 fail · 10 skip
(`npm run verify:live`; the fail is OmniRoute down, the skips need a sheet).

## Before anything else (unblocks live proof)
1. **Google Sheet**: service-account JSON → `./secrets/service-account.json`,
   share a sheet as Editor, set `GOOGLE_SHEET_ID` (`npm run setup` walks it).
   Unlocks: first sheet-backed `run:once`, rerun-≈0-rows proof, F15–F20 live,
   the wrong-Jev-key fallback run, and real topics on Today.
2. **OmniRoute**: start the gateway on `http://localhost:20128/v1`
   (F32 live currently FAILs: not reachable; extraction + fallback ride it).

## Day 2 — hardening + packaging (docs/12 §9)
- **P3b** Scrapling sidecar: recipes, adaptive healing (S01–S06 are stubs).
- **P6 rest**: kill-resume drills, chaos (collector down mid-run, sheet 429 storm).
- **P7 rest**: remaining API rows (retry/resort detail, export filters parity).
- **P8 rest**: STY-03 contrast computation (cut Day-1), remaining UI states.
- **P9** Packaging: single-command prod (`build` + `start` smoke), `.env.example` audit.
- **P10** Hardening + MVP release: 3-day soak, SEC-05/07–10, tag `phase-10`.

## Day 3 — creator loop
- **P11** Profile + feedback, **P12** generator + angles, **P13** ideas board.

## Day 4 — push + v1.1 + Decode start
- **P14** Push digest, **P15** v1.1 hardening, **P16** Decode library + runs.

## Day 5 — Decode
- **P17** analytics/storage/API, **P18** Decode UI, **P19** extras + v1.2 hardening.
