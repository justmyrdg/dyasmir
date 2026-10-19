# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

JASthinkAboutIT: a quiz platform for one teacher and three sections (BCpET3101-3103) taking two subjects. Angular 22 frontend in `frontend/`, Express 5 + Prisma + PostgreSQL 17 API in `backend/`. [README.md](README.md) has full setup, the student/quiz import formats, the API table, and a "How the important parts work" table that maps each requirement to its implementation. Read it before changing exam, grading, or enrollment behavior.

## Commands

Backend (run in `backend/`):

```bash
npm run dev                  # tsx watch, http://localhost:3000
npm run typecheck            # tsc --noEmit (includes test/)
npm run build                # -> dist/src/index.js, dist/scripts/*.js (rootDir is ".")
npm test                     # vitest integration tests against quiz_platform_test
npx vitest run -t "subject enrollment"   # one describe block (see caveat below)
npx prisma migrate dev --name <name>     # new migration + regenerate client
npm run create-teacher -- --email t@school.edu --name "Name" --password 'secret123'
npm run seed:quizzes -- data/quizzes.sample.json --strict   # --replace overwrites unassigned same-titled quizzes
npm run export:quizzes       # all quizzes in the DB -> data/seed/quizzes.json
npm run bootstrap            # teacher from data/seed/teacher.json + quizzes from data/seed/*.json; idempotent, run by setup-ec2.sh
```

`backend/data/seed/` is gitignored on purpose: the repo is public, and that folder holds answer keys and the teacher's plaintext password. Never commit it, and never move its contents into tracked files.

Test database: create `quiz_platform_test` once, then apply migrations to it. Do this again after every new migration, or the tests fail:

```bash
DATABASE_URL=postgresql://postgres:dyasmir@localhost:5432/quiz_platform_test npx prisma migrate deploy
```

That `VAR=x cmd` form works in Bash only. In PowerShell, set `$env:DATABASE_URL` first. The tests read `TEST_DATABASE_URL` (default in [vitest.config.ts](backend/vitest.config.ts)). `JWT_ACCESS_SECRET` comes from `backend/.env`, which `config.ts` loads with `process.loadEnvFile` (no dotenv). Startup throws if it is missing or shorter than 32 characters, and that includes tests and scripts.

Frontend (run in `frontend/`):

```bash
npm start        # ng serve on :4200, proxies /api to :3000 (proxy.conf.json)
npm run build    # -> dist/frontend/browser; this is also the type check for templates
```

The frontend has no test runner: `angular.json` has no `test` target and there are no spec files, so `npm test` fails. Prettier config is in `frontend/.prettierrc` (printWidth 100, single quotes).

Production runs on Amazon Linux 2023 EC2 via `sudo bash deploy/setup-ec2.sh <domain>`, which is safe to re-run and is also how updates are deployed. It reads `backend/.env` (template: `backend/.env.production.example`) and sets `FRONTEND_DIST_DIR`/`TRUST_PROXY` in the systemd unit. If you add a required env var, add it to both `.env` examples.

Local PostgreSQL runs on 5432. `docker compose up -d db` runs it on **5433** instead, so change `DATABASE_URL` to match. On Windows, `prisma generate` / `migrate dev` can fail with EPERM while `npm run dev` holds the query-engine DLL. Stop the dev server first.

## Backend architecture

- **Layering.** `*.routes.ts` routers apply `requireAuth, requireRole(...)` at router level and call `*.service.ts` functions, which hold the logic and the Prisma/SQL. Request bodies go through `body(SomeDto)` from [validate.ts](backend/src/lib/validate.ts). The DTOs are class-validator classes in `*.dto.ts`, validated with `whitelist + forbidNonWhitelisted`. A new request field must be added to the DTO, or the request gets a 400.
- **Errors.** Express 5 forwards rejected async handlers, so code throws the helpers from [http-error.ts](backend/src/lib/http-error.ts) (`badRequest`, `notFound`, `conflict(msg, code)`, ...). There are no try/catch blocks in routes. The `errorHandler` in [app.ts](backend/src/app.ts) maps `HttpError`, Prisma P2002/P2003/P2025, and PostgreSQL CHECK/trigger failures to `{ message, code, details }`. It recognizes the CHECK/trigger failures with a regex on the error message text. **A new trigger `RAISE` message must be added to that regex, or it surfaces as a 500.** The frontend reads these fields with [errors.ts](frontend/src/app/core/errors.ts).
- **The database clock is the only clock.** For schedule and deadline decisions use SQL `now()` or `dbNow()` ([db.ts](backend/src/db.ts)), never `new Date()`. An attempt's deadline is the `DEADLINE_SQL` fragment in [grading.ts](backend/src/attempts/grading.ts) (`COALESCE(extended_until, LEAST(started_at + limit, due_at))`); reuse it, don't recompute it. The same goes for `TOTAL_POINTS_SQL`, what a student's quiz is out of. With items per student set, each attempt has its own random pick (stored in `question_order`), so never use `quizzes.total_points` as an attempt's total. Responses carry `serverNow`, and the frontend's `ServerClock.sync()` anchors countdowns to it. Times display in Asia/Manila, and the frontend sends ISO strings with an explicit `+08:00` ([time.ts](frontend/src/app/core/time.ts)).
- **Transactions and locking.** Attempt and grading paths use `$queryRaw` with `FOR UPDATE OF at` inside `prisma.$transaction`. These queries use snake_case column names, while the Prisma models are camelCase via `@map`. Functions that take a `Tx`/`Db` compose into the caller's transaction. For example, editing a quiz calls `regradeQuiz(tx, ...)` in the same transaction.
- **One grading path.** `gradeAttempt` handles student submit, the every-minute cron job ([auto-submit.job.ts](backend/src/attempts/auto-submit.job.ts), started from `index.ts`, not `app.ts`), the lazy `autoSubmitExpired()` called before reading attempt state, and re-grades. A teacher re-check (`override_correct`) always wins over `auto_correct`. `DISABLE_AUTO_SUBMIT_JOB=true` turns the cron off; the tests do this and call `autoSubmitExpired()` directly.
- **Constraints live in two places.** `schema.prisma` holds tables, FKs and unique keys. CHECK constraints and triggers are hand-written SQL appended to migrations; use `prisma migrate dev --create-only`, then edit the file. Those triggers enforce: exactly 4 choices with exactly 1 correct (a deferred constraint trigger), accepted answers only on identification questions, and enrollments only for students, in a section that offers the subject. Some value lists exist in both TypeScript and a CHECK constraint: attempt event types (`EVENT_TYPES` in [security.ts](backend/src/attempts/security.ts) and `attempt_events_type_check`), question types, attempt statuses and roles. Changing one needs a migration that drops and re-adds the constraint. See `20261018022431_reopen_and_limit_5` for an example.
- **Visibility.** A student sees a quiz only when the assignment's section equals the section in `student_subjects` for that quiz's subject. Irregular students take different subjects in different sections, so never use `users.section_id` for this; it is only the student's "home" section. Another student's attempt returns 404, not 403.
- **Answer keys never reach students.** Student-facing queries in [attempts.service.ts](backend/src/attempts/attempts.service.ts) must not select `is_correct` or `accepted_answers`, and a test checks for those strings in responses. Result feedback says correct/incorrect but never what the right answer was.
- **Quiz lock.** Once any attempt exists, question and choice ids are frozen (adding, removing or retyping them returns 409 `QUIZ_LOCKED`). Wording, points and keys can still change, and submitted attempts are re-graded.
- **Auth.** The access JWT lives in frontend memory. The refresh token is a rotating httpOnly cookie scoped to `/api/auth`. `requireAuth` reloads the user from the DB on every request, so deactivating an account takes effect immediately. It also writes `last_seen_at` (for the teacher's Online now page).
- **Temporary student passwords.** Every place the teacher sets a student's password (create, import, reset, the account email's new password) must also set `mustChangePassword: true`. `requireRole` then returns 403 `PASSWORD_CHANGE_REQUIRED` until the student changes it at `/api/account/password`. Only `/api/account` skips `requireRole`. It isn't under `/api/auth` because the frontend interceptor sends no Bearer token there. Student-chosen passwords set `passwordEncrypted` to null, so the teacher can't read them. Tests that log in as API-created students must clear the flag (see `studentToken24`). The app has no teacher password screen. On hosts with no shell (Render), `index.ts` calls `ensureTeacherFromEnv()` ([teacher-account.ts](backend/src/auth/teacher-account.ts)) before listening: `TEACHER_EMAIL`/`TEACHER_NAME`/`TEACHER_PASSWORD` create the teacher or reset its password, and a bad value stops startup.

### Tests

There is one file, [test/api.test.ts](backend/test/api.test.ts). It runs supertest against `createApp()` (no listening server), sequentially (`fileParallelism: false`). `beforeAll` TRUNCATEs the data tables but keeps the sections and subjects that the migrations insert. **Later describe blocks reuse state from earlier ones.** For example, the re-check block uses Ben's attempt, which the deadlines block auto-submitted. So `-t` filtering can fail for no real reason; run the whole file before trusting a failure. Time-dependent cases move rows in the DB (e.g. `started_at = now() - interval ...`) and build schedules with the `dbIso()` helper.

## Frontend architecture

- Standalone components with **inline templates** (no per-component `.html`/`.css`) and signals. Routes in [app.routes.ts](frontend/src/app/app.routes.ts) are lazy-loaded under two `Shell`-wrapped areas, `/student` and `/teacher`, each with `roleGuard`. `withComponentInputBinding()` delivers route params as `input()`s.
- `authInterceptor` adds the Bearer token to `/api/*` (but not `/api/auth/*`) and refreshes once on a 401. `AuthService.init()` runs as an app initializer to restore the session from the cookie.
- Teacher pages call the API through `TeacherApi` ([teacher-api.ts](frontend/src/app/teacher/teacher-api.ts)): promise wrappers, cached sections/subjects from `/api/teacher/meta`, and file downloads. Student pages use `HttpClient` directly.
- [models.ts](frontend/src/app/core/models.ts) is a hand-written copy of the backend response shapes. Update it together with the backend.
- [quiz-take.ts](frontend/src/app/student/quiz-take.ts) is the exam screen:
  - It autosaves 1 s after the last change.
  - Unsent answers and security events are queued in `localStorage`.
  - Each event carries a random `clientId`; `attempt_events` has `UNIQUE (attempt_id, client_id)`, so resending is safe.
  - On tab close it sends a `keepalive` request.
  - [exam-guard.ts](frontend/src/app/student/exam-guard.ts) detects leaving the page, exiting full screen, and blocked actions.
- Styling: Tailwind 4. [styles.css](frontend/src/styles.css) remaps the palette names to an AWS-console look (`indigo` = link/selection blue, `emerald` = success, `rose` = error, `amber` = warning, `slate` = greys). It also defines shared component classes: `card`, `btn-primary|secondary|danger|ghost`, `btn-sm`, `input`, `label`, `badge`, `table`, `alert-*`, `link`. Use these instead of one-off styles.
