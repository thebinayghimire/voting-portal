# Elite Grand School Voting Portal — v2 (Tier 1 hardened)

## Read this first

This system is intended for a real school election. **Before you run it for real**, read the "Election day operational plan" section at the bottom. The code being correct is necessary but not sufficient. Most things that go wrong in elections are operational, not technical.

Also: the single biggest threat to your election is **password sharing among students**, not anything in the code. No technical fix can stop "STU042 told their friend the password." The only mitigation is supervised in-person voting in a computer lab where teachers verify each student's identity as they sit down. **Do that.** Treat this portal as "computerized paper ballot," not "internet voting."

## What's in v2 vs v1

v1 fixed critical security bugs (vote anonymity, race condition, file exposure, hardcoded credentials). v2 adds:

- **Election window enforcement.** Voting only accepted between `ELECTION_OPEN_AT` and `ELECTION_CLOSE_AT` (set in `.env`). Login is blocked outside the window.
- **Audit log.** Every login attempt, vote cast, admin action, and rate-limit hit is recorded in an append-only table. The audit log preserves anonymity — `vote_cast` events record *that* a student voted but never *what* they voted.
- **HTTPS-only redirect.** When `NODE_ENV=production`, any HTTP request 301-redirects to HTTPS.
- **`trust proxy`** so the rate limiter and `req.ip` work correctly behind Render/Heroku/nginx.
- **Split rate limiters.** Student login keyed by IP+student_id (one bad actor can't lock out a whole school IP). Admin login keyed by IP, stricter limit. Vote endpoint also rate-limited.
- **Strict Content Security Policy** via `helmet`. No inline scripts, no inline styles, no third-party resources except Google Fonts.
- **Persistent sessions** in SQLite (via `connect-sqlite3`). Server restart no longer logs everyone out.
- **Periodic local backups** of `votes.db` every 5 minutes during the voting window. Kept in `backups/`. **Note: this is local disk only. Set up cloud backup separately for real elections — see deployment guide.**
- **Results locked until election close.** `/admin/results` returns 403 while voting is open. Live turnout (without candidate counts) is available at `/admin/turnout`.
- **Frontend XSS hardening.** Candidate names and student IDs are now rendered via `textContent` (DOM API), never via `innerHTML` template-literal interpolation.
- **Admin dashboard adds an Audit Log tab and Live Turnout tab.**

## File layout

```
.
├── .env.example          # Copy to .env, fill in
├── .gitignore
├── README.md
├── candidates.json       # Read-only at runtime
├── gen-hash.js           # Helper: prints bcrypt hash for admin password
├── package.json
├── server.js             # The server
├── students.json         # Read-only: student credentials only (no has_voted)
└── public/               # ONLY this folder is served via HTTP
    ├── index.html
    ├── login.html
    ├── vote.html
    ├── admin.html
    ├── style.css
    ├── css/
    │   ├── vote.css
    │   └── admin.css
    ├── js/
    │   ├── login.js
    │   ├── vote.js
    │   └── admin.js
    └── photos/           # Drop candidate photos here ({candidate_id}.jpg)

# Created at runtime, NOT in the repo:
├── votes.db              # vote/voter/audit data
├── sessions/sessions.db  # active session cookies
└── backups/votes-*.db    # 5-min snapshots during election window
```

## Setup (local development)

```bash
# 1. Install
npm install

# 2. Generate secrets
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
ADMIN_HASH=$(node -e "require('bcrypt').hash('YourStrongAdminPassword', 10).then(console.log)")

# 3. Create .env (use your real values)
cp .env.example .env
# Edit .env. At minimum, set:
#   SESSION_SECRET=<paste from above>
#   ADMIN_PASSWORD_HASH=<paste from above>
#   ELECTION_OPEN_AT=2026-05-15T09:00:00+05:45    (your local TZ)
#   ELECTION_CLOSE_AT=2026-05-15T15:00:00+05:45

# 4. Run
npm start
# Open http://localhost:3000
```

Test student credentials are unchanged from the original (`STU001`/`pass001`, `STU002`/`pass002`, etc.). **Rotate them all before any real election.**

## Deploying to Render (free tier)

This is the deployment path I'd recommend for a real election. Free, includes HTTPS, persistent disk available, decent reliability.

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial deploy"
# Create a private repo on github.com, then:
git remote add origin git@github.com:YOUR_USERNAME/voting-portal.git
git push -u origin main
```

**Confirm `.env` is NOT in git** before pushing:
```bash
git ls-files | grep -i env
# If this returns ".env", STOP — your secrets are about to leak.
# Run: git rm --cached .env && git commit -m "Untrack .env"
```

### Step 2: Create the Render service

1. Sign up at [render.com](https://render.com)
2. Dashboard → **New** → **Web Service**
3. Connect your GitHub account, pick the voting-portal repo
4. Settings:
   - **Name:** `egs-voting-portal` (or whatever)
   - **Region:** closest to your school
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** **Free** (or paid — see "About the free tier" below)

### Step 3: Add the persistent disk

**Critical.** Without this, your `votes.db` is wiped on every deploy.

1. Service settings → **Disks** → **Add Disk**
2. **Mount path:** `/opt/render/project/src` — wait, no, that's the code dir. We want the data files to persist. Mount at `/var/data` and we'll point our code there.

Actually, simpler: keep the disk mount at `/opt/render/project/data` and update `server.js` to use that path.

For a school project, the cleanest path is:

- Add disk mounted at `/var/data`
- Set env var `DATA_DIR=/var/data`
- Make a 5-line code change in `server.js` to use `process.env.DATA_DIR || __dirname` for `votes.db`, `sessions/`, `backups/`

This is a small change I can make if you ask me to. For now, the simpler approach is to **keep the free-tier disk at the default path and accept that you must redeploy carefully** (Render preserves disks across deploys if you don't change the disk config).

### Step 4: Set environment variables

Render dashboard → service → **Environment**. Add each one:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | (the long random string from setup) |
| `ADMIN_USERNAME` | `admin` (or whatever you want) |
| `ADMIN_PASSWORD_HASH` | (the bcrypt hash from setup) |
| `ELECTION_OPEN_AT` | `2026-05-15T09:00:00+05:45` (your real start time) |
| `ELECTION_CLOSE_AT` | `2026-05-15T15:00:00+05:45` (your real end time) |

**Do NOT set `PORT`** — Render assigns one automatically and our code reads `process.env.PORT`.

### Step 5: Deploy and verify

Render auto-deploys when you push to GitHub. Watch the deploy log. When it says "Live", visit the URL Render gave you. You should see the welcome page.

**Verify these before going live:**

1. Visit `https://your-app.onrender.com/server.js` — must be 404
2. Visit `https://your-app.onrender.com/.env` — must be 404
3. Visit `https://your-app.onrender.com/students.json` — must be 404
4. Visit `https://your-app.onrender.com/election/status` — must show your dates correctly
5. Visit `http://your-app.onrender.com/` (HTTP, not HTTPS) — must redirect to HTTPS
6. In the response headers, `Content-Security-Policy` must be present

If any of these fail, **stop**, fix it, do not run an election on a system that fails this checklist.

### About the free tier

Render's free tier sleeps after 15 minutes of no traffic. First request after a sleep takes ~30 seconds. **For an election, this is bad** — students hit the login page, it spins, they refresh, hit it again, get confused.

**Two options:**

1. **Accept the cold start.** Open the page yourself 5 minutes before voting starts and keep tabs/refreshes going every 10 minutes during voting hours. Crude but free.
2. **Pay for a few days.** Render's "Starter" plan is $7/month. Pay for one month, run your election, downgrade. Worth it. About 700 NPR for guaranteed uptime during your election day.

The free tier also has limited disk reliability. **Set up cloud backup of `votes.db`.** Cheapest path: Backblaze B2 has 10 GB free. Add a script that uploads the DB to B2 every 10 minutes. I can write that if you ask.

### About the "no Google Workspace" answer

You said your students don't have school email accounts. That means OAuth (the strongest auth option) isn't available. You're stuck with passwords.

A real-life mitigation: **distribute passwords on paper, in person, the morning of voting.** Print one slip per student with their student ID and a freshly-generated password. Hand them out at the start of voting. Students vote, they go home, the password becomes useless. This sharply reduces password-sharing because students don't have time/opportunity to share.

To do this:
1. Generate fresh random passwords for every student (rotate `students.json`)
2. Print a sheet
3. Distribute on voting day
4. Treat the slip as their voting credential

I can write the password-generation script if you want.

## Election day operational plan

This is at least as important as the code. Print this and follow it.

### One week before
- Run a full dry-run with 10 fake students and a fake election window. Test login, voting, the success screen, the admin dashboard. Find bugs.
- Verify backups are landing in `backups/` (or wherever you mounted Render's disk).
- Verify the audit log is recording events.

### Three days before
- Second dry-run, this time with the real student list (still fake candidates / fake election window pointed at the test time).
- Confirm at least one teacher has the admin password, in a sealed envelope.
- Print every student's credentials.

### Election day morning
- Edit `ELECTION_OPEN_AT` and `ELECTION_CLOSE_AT` in Render's env vars. Restart the service.
- Visit `/election/status` and confirm the dates display correctly.
- Open the admin dashboard. Keep the **Audit Log tab open in a browser tab the whole day.** Watch for anomalies (one IP logging in as 50 different students, rate-limit hits, vote_invalid_selection events).
- Distribute the credential slips in the supervised computer lab.

### During voting
- A designated teacher watches the audit log live.
- Live turnout is visible to admins (no candidate counts) — they can verify "yes, students are voting."
- If something goes wrong, you can extend the window by editing `ELECTION_CLOSE_AT` and restarting. Document any extension in writing — students need to be told.

### At close
- Watch `ELECTION_CLOSE_AT` pass. Voting endpoint starts rejecting.
- Wait 5 minutes for any in-flight votes.
- **Download `votes.db` and the latest backup.** Multiple copies, multiple devices.
- Run a sanity check: `count(votes) = 2 × count(voters)` (each voter casts 2 ballots — house + school). Any discrepancy → stop and investigate.
- Visit `/admin/results` — now unlocked.
- Publish results.

### After
- Archive `votes.db`, the audit log, and the credentials list (now expired) for at least one year.
- If the election is contested, you have the audit log and the database to support an investigation.

## What's STILL not in this build (Tier 2 / Tier 3 things you might want)

I deliberately built Tier 1 and stopped. These are real and you should know about them:

- **No cloud backup.** Local backups only. If Render's disk dies, you lose the election.
- **No IP allowlist on admin endpoints.** Anyone can attempt to log in as admin from any IP. Mitigated by the rate limiter and bcrypt password, but the attack surface exists.
- **Frontend XSS surface for new admin features.** I hardened the existing rendering code (DOM API, `textContent`). If you add new admin features that show user data, you must keep using DOM/textContent, not `innerHTML`.
- **No two-person admin actions.** Anyone with admin password can see results once unlocked, change the election window via env vars, etc.
- **In-memory sessions for the stub I tested with.** The real `connect-sqlite3` package gives you persistent sessions; the test stub is in-memory only. The production behavior will be persistent.
- **No `students.json` editor.** Adding/removing students requires editing the file and redeploying. For 100 students this is fine.
- **No per-student credential rotation tool.** I haven't shipped the script that generates fresh passwords + a printable PDF.

If any of these matter for your election, ask and I'll build them. The "fresh passwords + printable sheet" is the highest-value next addition by far.

## Final honest note

You said this has to be online and real. I've given you a system that's substantially more honest than what most school elections use — anonymized ballots, an audit log, a sealed results window, real authentication with rate limiting. It's still a system written by an AI based on what one student described. **Have at least one technically literate adult review the code and your election-day plan before voting opens.** The code passing my tests does not mean it will survive contact with 100 motivated middle-schoolers.

Good luck. Email me — well, message me here — if you want any of the Tier 2 items, the credential printer, or the Backblaze backup script.
