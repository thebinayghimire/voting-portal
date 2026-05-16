# Elite Grand School Voting Portal

Hardened Node/Express voting portal for a supervised school election.

This is still not a replacement for real election operations. The biggest practical risk is password sharing, so run voting in a supervised room where a teacher checks each student before they sit down.

## What This Build Includes

- Election window enforcement through `ELECTION_OPEN_AT` and `ELECTION_CLOSE_AT`.
- Server-side grade binding. Students can only see and vote for candidates in the grade stored in `students.json`.
- Anonymous ballot storage. The voter ledger keeps `student_id`; ballot rows do not store `student_id` and no longer share a per-voter timestamp with the voter ledger.
- Double-vote prevention through the `voters.student_id` primary key.
- Admin results lock until `RESULTS_VISIBLE_AFTER` or election close.
- Optional second-person results reveal code with `RESULTS_ACCESS_CODE_HASH`.
- Optional admin API IP allowlist with `ADMIN_ALLOWED_IPS`.
- Strict CSP and no user-data `innerHTML` rendering in the frontend.
- Persistent sessions using a small `better-sqlite3` session store.
- Runtime data outside the repo through `DATA_DIR`.
- Local SQLite backups after each vote and on a 5-minute interval.
- Optional Backblaze B2 cloud uploads for every local backup.
- Credential rotation tool that generates fresh passwords and printable slips.
- CLI roster editor for adding, updating, and removing students.
- Regression tests for grade spoofing, anonymized ballot timestamps, and second-person results reveal.

## File Layout

```text
.
|-- .env.example
|-- candidates.json
|-- gen-hash.js
|-- package.json
|-- server.js
|-- students.json
|-- scripts/
|   |-- generate-credentials.js
|   `-- manage-students.js
|-- test/
|   `-- security.test.js
`-- public/
    |-- index.html
    |-- login.html
    |-- vote.html
    |-- admin.html
    |-- css/
    |-- js/
    `-- photos/
```

Runtime files are created under `DATA_DIR` when set, otherwise in the project directory:

```text
votes.db
sessions/sessions.db
backups/votes-*.db
```

For deployment, set `DATA_DIR` to a persistent disk path such as `/var/data`.

## Setup

```bash
npm install
cp .env.example .env
node gen-hash.js YourStrongAdminPasswordHere
npm start
```

Required `.env` values:

```env
SESSION_SECRET=long_random_secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=bcrypt_hash_from_gen_hash
ELECTION_OPEN_AT=2026-05-15T09:00:00+05:45
ELECTION_CLOSE_AT=2026-05-15T15:00:00+05:45
```

Recommended production values:

```env
NODE_ENV=production
DATA_DIR=/var/data
RESULTS_VISIBLE_AFTER=2026-05-15T15:00:00+05:45
RESULTS_ACCESS_CODE_HASH=bcrypt_hash_for_second_person_code
ADMIN_ALLOWED_IPS=203.0.113.10
BACKUP_RETAIN=100
```

Optional Backblaze B2 cloud backup:

```env
B2_KEY_ID=...
B2_APPLICATION_KEY=...
B2_BUCKET_ID=...
B2_PREFIX=voting-portal-backups
```

When those B2 values are set, each local `votes.db` backup is also uploaded to Backblaze B2.

## Student Roster

Each student must have:

```json
{
  "student_id": "STU001",
  "password": "$2b$10$...",
  "grade": "Grade 1"
}
```

Valid grades are `Grade 1` through `Grade 10`.

Rotate all student passwords before a real election:

```bash
npm run credentials:rotate
```

That creates:

- `credentials-out/students.rotated.json`
- `credentials-out/credential-slips.csv`
- `credentials-out/credential-slips.html`

After reviewing the output, apply rotation directly with:

```bash
node scripts/generate-credentials.js --apply
```

Manage the roster:

```bash
npm run students -- list
npm run students -- add STU101 "Grade 10" TempPass123
npm run students -- update STU101 --grade "Grade 9" --password NewPass123
npm run students -- remove STU101
```

The roster editor creates a timestamped backup before writing.

## Admin Hardening

To restrict admin APIs to known IP addresses:

```env
ADMIN_ALLOWED_IPS=203.0.113.10,127.0.0.1
```

To require a second person before viewing results:

```bash
node gen-hash.js ResultsRevealCode
```

Put the hash in:

```env
RESULTS_ACCESS_CODE_HASH=...
```

The admin dashboard prompts for that code when `/admin/results` is requested.

## Deployment Notes

On Render:

1. Create a Web Service.
2. Add a persistent disk.
3. Mount it at `/var/data`.
4. Set `DATA_DIR=/var/data`.
5. Set `NODE_ENV=production`.
6. Do not set `PORT`; Render provides it.

Before going live, verify:

```text
/server.js       -> 404
/.env            -> 404
/students.json   -> 404
/election/status -> correct dates
HTTP URL         -> redirects to HTTPS in production
```

## Election Day Checklist

One week before:

- Run a dry run with fake students and fake candidates.
- Verify login, voting, success screen, admin login, audit log, and backups.
- Run `npm test`.
- Run `npm run audit:deps`.

Three days before:

- Load the real roster.
- Rotate credentials and print slips.
- Confirm admin password and results reveal code are held by different people.
- Confirm `DATA_DIR` is on persistent storage.

Election day:

- Confirm `/election/status`.
- Keep the admin Audit Log tab open.
- Watch for rate-limit hits and unusual login patterns.
- Keep voting supervised.

At close:

- Confirm voting rejects after `ELECTION_CLOSE_AT`.
- Download `votes.db` and the latest backup.
- Check that `COUNT(votes) = 2 * COUNT(voters)`.
- Reveal and publish results only after the configured results time.

After:

- Archive `votes.db`, audit log, final roster, and expired credential list.

## Development Commands

```bash
npm run check
npm test
npm run audit:deps
npm start
```

## Remaining Operational Limits

- A student who has another student's valid credential can still vote as that student. Supervision is the mitigation.
- If only one student in a grade votes, grade-level results can still reveal that student's choices. That is an election-design issue, not something code can fully hide.
- Admin IP allowlisting depends on stable public IPs. If the school network IP changes, update `ADMIN_ALLOWED_IPS`.
- Cloud backup requires correct B2 credentials and bucket permissions.
