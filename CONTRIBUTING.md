# Contributing to TrendPulse

## Setup

```bash
npm install
npm run setup   # writes .env (needs a terminal)
npm run dev     # API :4317 + dashboard :5173 (proxied /api)
```

`npm run doctor` checks every connection. No credentials? Most suites run on
fakes — only live-collect and live-sort need real backends.

## Checks (CI runs all of these)

```bash
npm run lint        # eslint, server + web
npm run build       # tsc + vite (catches type errors the tests skip)
npm test            # server vitest (collectors → pipeline → API)
npm run test:web    # web vitest (logic + components)
npm run test:e2e    # Playwright (fake HTTP backends, needs browsers once:
                    #   npx playwright install chromium --with-deps)
```

## Conventions

- **Commits:** Conventional Commits (`feat/fix/docs/test/refactor`), scoped by
  area (`phase-N`, `collectors`, `sorting`, `api`, `web`). One logical change
  per commit; never `git add .`.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. No `any`; zod at every boundary.
- **Tests:** deterministic (no wall-clock or network without fakes), one
  behavior per test. Server: fixture/fake per external. Web: stub `fetch`,
  intercept HTTP in e2e.
- **Docs:** `README.md` API table stays in sync with `server/src/app.ts`;
  every behavior change logs a `DECISIONS.md` entry (Decision + Reason);
  spec priority `05_BACKEND_SCHEMA.md` > `02_TRD.md` > others.
- **Privacy:** secrets in env/files only, redacted in logs, masked in API.
  Never commit `.env`, `secrets/`, or `data/`.

## Adding a source (TRD §4)

1. `server/src/collectors/<key>.ts` implementing `Collector` (+ `ping`).
2. Recorded fixture in `server/test/fixtures/` + contract test (tolerant
   parser — endpoints change).
3. Register in `COLLECTORS`, add the `SourceKey` row default, doctor ping.
4. Confirm politeness: UA, per-domain gap, robots gate for content URLs.
5. Dashboard icon/label follow automatically from `/api/sources`.
