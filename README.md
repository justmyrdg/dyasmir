# JASthinkAboutIT

**JASthinkAboutIT** is a quiz web app for a teacher and three sections (**BCpET3101**, **BCpET3102**, **BCpET3103**). Every section offers **Database Design** and **Embedded Systems (CpET343)**, but each student is enrolled only in the subjects they actually take. A student sees a quiz only if it is assigned to their section **and** they are enrolled in its subject.

- **Frontend:** Angular 22 (standalone components, signals, Tailwind CSS 4) in `frontend/`
- **Backend:** Node.js + Express 5 (TypeScript) REST API in `backend/`
- **Database:** PostgreSQL 17 with Prisma ORM and SQL migrations
- **Auth:** short-lived JWT access tokens (15 min, in memory) + rotating refresh tokens in an httpOnly cookie; bcrypt password hashes

```
quiz/
├── docker-compose.yml          PostgreSQL + API for local development
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       tables, FKs, unique keys
│   │   ├── migrations/         SQL incl. CHECK constraints, triggers, sections, subjects, student_subjects
│   │   └── seed.ts             reference data (idempotent)
│   ├── data/quizzes.sample.json  two 30-point quizzes (20 MC + 10 identification), the import format
│   ├── data/seed/              gitignored: teacher.json + quiz files that bootstrap loads on every deploy
│   ├── scripts/
│   │   ├── create-teacher.ts   CLI: create the teacher account
│   │   ├── seed-quizzes.ts     CLI: load quizzes from a JSON file
│   │   ├── export-quizzes.ts   CLI: write every quiz in the database to data/seed/quizzes.json
│   │   └── bootstrap.ts        CLI: create the teacher and load the quizzes in data/seed/ (run by the deploy)
│   ├── src/
│   │   ├── auth/               login, refresh, logout, lockout, JWT middleware, role guard
│   │   ├── attempts/           student endpoints, start/resume/autosave/submit, grading, auto-submit job
│   │   ├── teacher/            students, quizzes, JSON import, assignments, dashboard, results/export
│   │   ├── lib/                validation (class-validator DTOs), errors, helpers
│   │   ├── app.ts              Express app (helmet, CORS, routes, error handler)
│   │   └── index.ts            server + every-minute auto-submit job
│   └── test/api.test.ts        integration tests (run against a separate test database)
└── frontend/src/app/
    ├── core/                   auth service + interceptor, guards, server clock, Manila time helpers
    ├── pages/login.ts
    ├── student/                dashboard, quiz screen (autosave/offline/timer), result
    ├── teacher/                dashboard, students, quizzes, quiz editor, assign, results, attempt detail
    └── shared/shell.ts         header/navigation layout
```

---

## 1. Run it locally

### Prerequisites

- Node.js 22+
- PostgreSQL 17, either installed locally (port 5432) or from `docker compose` (port 5433)

### 1.1 Start PostgreSQL

**Option A, local PostgreSQL (what this machine uses).** The database `quiz_platform` already exists. To create it elsewhere:

```bash
psql -U postgres -h localhost -c "CREATE DATABASE quiz_platform;"
```

**Option B, Docker.** `docker compose up -d db` starts Postgres on **localhost:5433** with database `quiz_platform`. Set `DATABASE_URL` in `backend/.env` to port 5433.

### 1.2 Configure and migrate the backend

```bash
cd backend
cp .env.example .env          # then edit DATABASE_URL and JWT_ACCESS_SECRET
npm install
npx prisma migrate deploy     # creates all tables, constraints, triggers; seeds sections BCpET3101-3103 + both subjects
npm run db:seed               # optional: re-applies the reference data (safe to run any time)
```

During development, `npx prisma migrate dev` also works. It applies migrations and regenerates the client.

### 1.3 Create the first teacher account

```bash
npm run create-teacher -- --email teacher@school.edu --name "Your Name"
# prompts for the password (min 8 chars). Non-interactive: add --password '...'
```

Run it again with the same email to reset the teacher's password.

### 1.4 Load the quizzes

```bash
npm run seed:quizzes -- data/quizzes.sample.json --strict
# --strict  : each quiz must be 20 multiple choice + 10 identification = 30 points
# --replace : overwrite same-titled quizzes that haven't been assigned yet
```

To load your own file, replace `data/quizzes.sample.json` with your path. The format is in [Quiz JSON format](#quiz-json-format). Quizzes can also be imported from the teacher UI (**Quizzes → Import quiz JSON**).

**Seed data for deploys.** `backend/data/seed/` is gitignored, so answer keys and the password never reach the repository, but it goes to the server with the project folder. The deploy runs `bootstrap`, which loads it:

```bash
npm run export:quizzes   # every quiz in this database -> data/seed/quizzes.json (answer keys included)
npm run bootstrap        # data/seed/teacher.json {"email","name","password"}: create that teacher if missing
                         # every other data/seed/*.json: load its quizzes, skipping titles already in the subject
```

Running `bootstrap` again changes nothing. It never changes an existing account's password (use `create-teacher` for that) and never overwrites an existing quiz. To update a quiz that's already on the server, edit it in the teacher UI there.

### 1.5 Run the backend and frontend

```bash
# terminal 1
cd backend
npm run dev                   # http://localhost:3000  (auto-reload)

# terminal 2
cd frontend
npm install
npm start                     # http://localhost:4200  (proxies /api to :3000)
```

Open http://localhost:4200, choose **Teacher**, and sign in with the account from step 1.3. Then:

1. **Students → Add student**, or **Import from Excel** (download the template first). For each subject choose the section the student takes it in. Change it later from the dropdowns in the table.
2. **Quizzes → Assign**: tick one or more sections and set start/due times per section. Only students of those sections who are enrolled in the quiz's subject see it.
3. Students sign in on the **Student** tab with their SR code (`NN-NNNNN`) and password.

### 1.6 Docker for PostgreSQL and the API

```bash
docker compose up -d --build                 # db on :5433, API on :3000 (runs migrations on start)
docker compose exec backend node dist/scripts/create-teacher.js --email teacher@school.edu --name "Your Name" --password 'ChangeMe123'
docker compose exec backend node dist/scripts/seed-quizzes.js data/quizzes.sample.json
cd frontend && npm install && npm start
```

---

## 2. Formats

### Importing students (Excel template)

**Students → Import from Excel → Download Excel template.** The template is generated from the database, so it always lists the current sections and subjects. It has:

| SR code | Name | Password | Database Design | Embedded Systems (CpET343) |
|---|---|---|---|---|
| 23-12345 | Dela Cruz, Juan | juan2026 | BCpET3101 | BCpET3101 |
| 23-12346 | Santos, Maria | maria2026 | BCpET3102 | *(blank)* |
| 23-12347 | Rizal, Jose | jose2026 | BCpET3101 | BCpET3103 |

- Each subject column has a dropdown of sections. Pick the section the student takes that subject in, or leave it blank if they don't take it.
- **Irregular students** (row 3) pick a different section per subject in the same row. **One account (SR code) per student**, used for every subject.
- The student's own section is the first section in their row.
- SR code and Password cells are text cells with input checks (`NN-NNNNN`, 6-72 characters). An *Instructions* sheet explains everything.
- Upload the saved `.xlsx` with **Upload filled template**.
- The import is all-or-nothing. If any row is invalid (bad SR code, unknown section, no subject chosen, short password, duplicate in the file), nothing is imported and every problem row is listed.
- SR codes that already exist are skipped and reported. Change their subjects on the Students page instead.

**CSV also works**, with the same columns as the template. An older format is accepted too: `srCode,name,section,password,subjects`, where `subjects` is separated by `;` and blank means both subjects. `section` can be `BCpET3101` or just `3101`.

### Quiz JSON format

```json
{
  "quizzes": [
    {
      "subject": "Database Design",
      "title": "Quiz 1",
      "timeLimitMinutes": 45,
      "shuffleQuestions": true,
      "shuffleChoices": true,
      "showResultsToStudents": false,
      "itemsPerStudent": 30,
      "questions": [
        { "type": "multiple_choice", "text": "Which key uniquely identifies a row?", "points": 1,
          "choices": ["Foreign key", "Primary key", "Index", "View"], "answer": 1 },
        { "type": "identification", "text": "SQL keyword that removes duplicate rows?", "points": 1,
          "acceptedAnswers": ["DISTINCT"] }
      ]
    }
  ]
}
```

- `subject` must be `Database Design` or `Embedded Systems (CpET343)`.
- Multiple choice needs exactly 4 choices and exactly one correct. `answer` can be the 0-based index (`1`), the letter (`"B"`) or the exact choice text. Choices may also be objects: `{ "text": "...", "isCorrect": true }`.
- Identification: `acceptedAnswers` is a list. Matching ignores case and extra spaces.
- `points` defaults to 1. The file may also be a single quiz object or a bare array of quizzes.
- `itemsPerStudent` is optional. With 45 questions and `"itemsPerStudent": 30`, each student gets their own random 30 of the 45. Leave it out (or `null`) to give everyone every question. It can't be more than the number of questions.
- In the quiz editor, **Import questions (JSON)** accepts `{ "questions": [...] }`, a bare array, or a whole quiz file, and appends those questions to the quiz being edited.

---

## 3. How the important parts work

| Requirement | Where / how |
|---|---|
| One attempt per student per assignment | `UNIQUE (assignment_id, student_id)`. `POST /api/attempts/start` runs in a transaction with `INSERT … ON CONFLICT DO NOTHING`, so a double click or two devices still produce one attempt |
| Shuffle once, never again | Question and choice order are generated at first start and stored in `attempts.question_order` / `choice_order` (JSONB). Every later load reads them back |
| Random items per student | Per-quiz **Items per student** (`quizzes.items_per_student`, blank = all). At first start the server picks that many questions at random for this student only and stores them as `question_order`, so resume, grading, re-check and reopen all use the same pick. Each student is scored out of the points of the items they got (`TOTAL_POINTS_SQL`). The number locks once anyone has started |
| Server time only | `started_at = now()` in SQL. Opening, closing and deadlines are compared with PostgreSQL `now()`. Every response carries `serverNow`, and the browser counts down from it, not from its own clock |
| Deadline | `LEAST(started_at + time_limit, due_at)`, computed in SQL each time, so extending a section's due time also helps students who already started |
| Autosave | Answers are sent about 1 s after the last change. The current question is saved on every navigation. Both are upserted into `attempt_answers`, and the indicator shows Saving… / Saved / Offline |
| Offline | Unsent changes are queued in `localStorage` and sent when the browser is back online, or on the next load on that device. A best-effort `keepalive` request also goes out when the tab closes |
| Resume | Reload, another tab, or another device returns the same order, saved answers and current question |
| Auto-submit | The browser submits at 0:00. A job inside the API runs every minute and grades any in-progress attempt past its deadline. Reads of an expired attempt also grade it first |
| Grading | On the server, in one transaction with a row lock: marks every answer, sums the score, sets `status='submitted'` and `submitted_at=now()` |
| Teacher re-check | **Results → Review / re-check**. For any item of a submitted attempt (any question type, answered or blank), choose **Correct** (the question's full points), **Wrong** (0) or **Auto** (back to the automatic check). The score updates at once. The decision is stored in `attempt_answers.override_correct`, next to the automatic result in `auto_correct`, and is kept on every later re-grade. Students see the final result |
| Exam security | Per-quiz setting, on by default. The exam runs in full screen. Copy, paste, right-click and printing are blocked. Leaving the exam (tab or app switch, Alt+Tab, minimizing, leaving full screen) and screenshot or print keys are recorded in `attempt_events` with server time, and the student sees a warning. Reloading or closing the page asks "Leave site?" first. Every time the exam page is opened again after the first time (reload, closed tab, another device, back from another page), the server records one more "left the exam". The first open after a teacher reopens the attempt is free. The exam is **submitted automatically after leaving it 5 times** (change per quiz; 0 = only record). Teachers see "⚠ Left exam ×N" in Results and a timed activity log per attempt. A browser cannot see phone cameras, second devices or every OS screenshot tool, so this is a deterrent, not a lockdown |
| Devices | Every quiz request (start, resume, autosave, events) records the device in `attempt_devices` while the attempt is in progress: device type, OS, browser, phone model (Chromium), screen size, touch and IP. The browser and OS come from the User-Agent; the quiz screen adds an `X-Device` header ([device.ts](frontend/src/app/core/device.ts)) with a random id kept in `localStorage`, so each browser is one row. More than one row means the student switched devices ("📱 N devices" in Results). The attempt page also warns when another student's attempt at the same quiz came from the same browser. All of it can be faked, so it is a clue, not proof. A web page can never see which other tab or app the student switched to |
| Reopen for revision | Results → Review → **Reopen for revision**: a submitted student continues with the same questions and their saved answers, either until the attempt's end time (no time added; the clock kept running while it was submitted) or for N more minutes (`attempts.extended_until`). The leave counter restarts (`reopened_at`), the score is recalculated on the next submit, and a re-check on an answer the student changes is dropped |
| Reopen on request | A student whose exam was submitted for leaving it too many times sees **Request to reopen** on the result page, with an optional message (`reopen_requests`, one per lockout). Nothing is recorded while the exam is locked, so they can leave the page to message the teacher. The teacher answers on **Reopen requests** (count in the menu) or on the attempt's Review page. Approving reopens it with the end time unchanged, and is refused once that time has passed (give extra minutes instead). The student's page checks every 10 s and goes back into the exam once it is reopened |
| Answer keys never reach students | Student endpoints only select choice ids/text and question text. `is_correct` and `accepted_answers` are never selected. A test checks this. Result feedback (when enabled) says correct/incorrect per item but does not reveal the right answer, since other sections may take the same quiz later |
| Subject enrollment | `student_subjects (student_id, subject_id, section_id)`: the subjects each student takes, and the section they take each one in. A composite foreign key to `section_subjects` guarantees the section offers the subject. An irregular student uses **one account** and sees each subject's quizzes from the section they take it in. The student dashboard, starting a quiz, results, dashboard counts and the Assign screen's "x / y submitted" all follow this. A trigger allows enrollments only for students. If a student is removed from a subject, attempts they already made stay in Results |
| Students touch only their own data | Every student query filters by the logged-in user and their section. Another student's attempt id returns 404. The save body may contain only `answers` and `currentIndex` (`forbidNonWhitelisted`). Saves after the deadline or after submission get 409 |
| Login protection | Rate limits per IP+account (10/min) and per IP (300/min, because a whole class may share one school IP). 5 wrong passwords lock the account for 5 minutes |
| Deactivate / reset password | Revokes all refresh tokens, back-dated past the 30-second grace for concurrent refreshes, so no old session can get a new access token. The user is reloaded from the DB on every request, so a deactivated account loses access immediately |
| Students choose their own password | Adding, importing or resetting a student sets `must_change_password`. Until they change it at `POST /api/account/password`, `requireRole` answers every student endpoint with 403 `PASSWORD_CHANGE_REQUIRED`, and the app shows the change-password page. The new password is not stored readable, so the accounts export leaves it blank until the teacher resets it. Changing it ends every other session |
| Who is online | `requireAuth` writes `users.last_seen_at` (database clock, at most every 30 s), and student pages ping `POST /api/account/ping` every minute. **Online now** (`GET /api/teacher/online`) lists students seen in the last 150 s who still have an active session, so signing out removes them at once |
| Editing a quiz after students started | Question and choice ids are locked (attempts reference them). Wording, points, the correct choice and accepted answers can still change, and submitted attempts are re-graded in the same transaction |
| DB constraints | CHECKs on role, SR code format, statuses, `due_at > start_at`, positive time limit/points, submitted ⇔ score. A deferred trigger enforces exactly 4 choices with exactly 1 correct per multiple-choice question |

Times are stored as `TIMESTAMPTZ` and shown in **Asia/Manila**. The schedule form takes Manila wall-clock time and sends it with an explicit `+08:00` offset.

---

## 4. Tests

```bash
cd backend
psql -U postgres -h localhost -c "CREATE DATABASE quiz_platform_test;"   # once
DATABASE_URL=postgresql://postgres:dyasmir@localhost:5432/quiz_platform_test npx prisma migrate deploy
npm test        # 43 integration tests; they wipe quiz_platform_test, never the main DB
```

Override the test database with `TEST_DATABASE_URL`.

---

## 5. Deploying

Serve the frontend and the API from **one origin over HTTPS**. The refresh cookie is `SameSite=Strict` and scoped to `/api/auth`, so this needs no CORS tricks.

### 5.1 Amazon Linux 2023 on EC2 (one command)

[`deploy/setup-ec2.sh`](deploy/setup-ec2.sh) sets up everything except `backend/.env`:
- Node.js, plus PostgreSQL when `DATABASE_URL` points at `localhost`. It creates the database user and database from that URL.
- The app, built in `/opt/jasthinkaboutit` and run as a systemd service.
- Caddy, with a free HTTPS certificate.
- Swap for the build.
- A nightly database backup (2:00 AM Manila time, kept 14 days).

1. **Instance.** Launch Amazon Linux 2023. Give it an Elastic IP so the address doesn't change. In the security group, open **22** (your IP only), **80** and **443**. Do **not** open 3000.
2. **Domain.** Point an `A` record (for example `quiz.yourschool.edu`) at the Elastic IP.
3. **Copy the project** without `node_modules` (the server builds its own). From the folder that contains `quiz/`, in PowerShell:
   ```powershell
   tar --exclude=node_modules --exclude=dist --exclude=.angular -czf quiz.tgz quiz
   scp -i your-key.pem quiz.tgz ec2-user@YOUR-ELASTIC-IP:~
   ```
   Then on the server: `tar -xzf quiz.tgz && cd quiz`
4. **Fill in the environment**: `cp backend/.env.production.example backend/.env`, then edit it (`vi backend/.env`). The comments say what each value is.
5. **Run the setup**:
   ```bash
   sudo bash deploy/setup-ec2.sh quiz.yourschool.edu
   ```
   It also runs `bootstrap`, so the teacher account and quizzes in `backend/data/seed/` are there on the first deploy (see [1.4](#14-load-the-quizzes)). Without `data/seed/teacher.json`, create the teacher with the command it prints at the end.

**Updating:** copy the new code over the same folder and run the same command again. It rebuilds, applies new migrations and restarts. The site is down for a moment while it restarts, so don't update during an exam.

**Backups:** stored in `/var/backups/jasthinkaboutit` on the same server. Copy them somewhere else now and then. To restore one: `gunzip -c FILE.sql.gz | sudo -u postgres psql quiz_platform`.

### 5.2 Other servers

1. **Database:** a managed PostgreSQL (or your own). Create the database, then run migrations on each release:
   ```bash
   cd backend && npx prisma migrate deploy
   ```
2. **Backend environment** (see `backend/.env.example`):
   - `NODE_ENV=production` (makes the refresh cookie `Secure`)
   - `DATABASE_URL=...`
   - `JWT_ACCESS_SECRET=<64+ random chars>`. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `FRONTEND_URL=https://quiz.yourschool.edu` (the only origin CORS allows)
   - `TRUST_PROXY=1` when behind Nginx / a load balancer, so rate limits see the real client IP
3. **Build:**
   ```bash
   cd frontend && npm ci && npm run build        # -> frontend/dist/frontend/browser
   cd ../backend && npm ci && npm run build      # -> backend/dist
   ```
4. **Serve.** Pick one:
   - **Simplest:** let Express serve the Angular build. Set `FRONTEND_DIST_DIR=/path/to/frontend/dist/frontend/browser` and run `node dist/src/index.js` (e.g. under `pm2` or systemd) behind an HTTPS reverse proxy.
   - **Nginx:** serve `frontend/dist/frontend/browser` as static files with `try_files $uri /index.html;` and proxy `/api/` to `http://127.0.0.1:3000`.
   - **Docker:** `backend/Dockerfile` builds the API image and runs `prisma migrate deploy` on start.
5. **First run:** `node dist/scripts/create-teacher.js --email ... --name ...`, then load quizzes with `node dist/scripts/seed-quizzes.js your-quizzes.json`.

   **No shell on the host (Render)?** Set `TEACHER_EMAIL`, `TEACHER_NAME` and `TEACHER_PASSWORD` in the service's environment variables. Each time the server starts, it creates that teacher account if it's missing. To reset the password, change `TEACHER_PASSWORD` and redeploy. Then sign in and load the quizzes with **Quizzes → Import quiz JSON**, choosing `backend/data/seed/quizzes.json` from `npm run export:quizzes`. Import a file only once: importing it again adds a second copy of each quiz. The start command must still run `npx prisma migrate deploy` first (the Dockerfile's does).

**Notes**
- Several API instances are safe. The auto-submit job locks each attempt row and re-checks its status, so an attempt is never graded twice.
- Back up the database regularly (`pg_dump quiz_platform > backup.sql`), especially before exams.
- The server's own clock and time zone don't matter. All time logic uses PostgreSQL `now()` and `TIMESTAMPTZ`.

---

## 6. API overview

All endpoints are under `/api`. Every request body is validated with class-validator DTOs, and unknown fields are rejected.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /auth/login` | anyone | `{ srCode, password }` (student) or `{ email, password }` (teacher) |
| `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | session | rotate cookie / end session / current user |
| `POST /account/password` | student | `{ currentPassword, newPassword }`: choose their own password (8+ characters, no SR code); returns a new session and ends the others |
| `POST /account/ping` | signed in | "still here", for Online now (pages call it every minute) |
| `GET /student/assignments` | student | own section's quizzes with status and server time |
| `POST /attempts/start` | student | `{ assignmentId }`: create or resume |
| `GET /attempts/:id` | student (owner) | questions in saved order (no keys), saved answers, current index, deadline, server time |
| `POST /attempts/:id/save` | student (owner) | `{ answers?: [{questionId, answer}], currentIndex? }` |
| `POST /attempts/:id/submit`, `GET /attempts/:id/result` | student (owner) | submit / score (+ feedback if enabled) |
| `GET/POST /attempts/:id/reopen-request` | student (owner) | submitted for leaving the exam: request state / ask the teacher to reopen it `{ message? }` |
| `GET /teacher/dashboard` | teacher | per section × subject stats, upcoming/open quizzes |
| `GET /teacher/online` | teacher | students online now (per section counts, last active, the quiz each is taking) |
| `GET /teacher/results[/export?format=csv\|xlsx]` | teacher | filter by `sectionId`, `subjectId`, `quizId` |
| `GET /teacher/attempts/:id`, `DELETE /teacher/attempts/:id` | teacher | answers with key / reset an attempt |
| `PUT /teacher/attempts/:id/items/:questionId` | teacher | re-check one item: `{ correct: true \| false \| null }` |
| `POST /teacher/attempts/:id/reopen` | teacher | `{ minutes }` from now, or `{}` to keep the end time |
| `GET /teacher/reopen-requests`, `POST /teacher/reopen-requests/:id/approve\|decline` | teacher | pending requests from locked-out students; approve reopens with the end time unchanged |
| `GET /teacher/students/template` | teacher | download the Excel import template |
| `GET/POST /teacher/students`, `POST /teacher/students/import` (`{ xlsxBase64 }` or `{ csv }`), `PATCH /teacher/students/:id`, `POST /teacher/students/:id/reset-password` | teacher | student management |
| `GET/POST /teacher/quizzes`, `GET/PUT/DELETE /teacher/quizzes/:id`, `POST /teacher/quizzes/import`, `POST /teacher/quizzes/parse-questions` | teacher | quiz CRUD and JSON import |
| `GET/PUT /teacher/quizzes/:id/assignments`, `PATCH/DELETE /teacher/assignments/:id` | teacher | per-section schedules |
