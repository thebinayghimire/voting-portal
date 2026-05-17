# Election Day Operations Guide
**Elite Grand School — School Prefect Election 2082**

---

## DAY BEFORE — Preparation

- [ ] Print `credentials-out/credential-slips.html` — open in browser, Ctrl+P
- [ ] Sort printed slips by class (Grade 9 CT, Grade 9 CE, Grade 10 DT 1, Grade 10 DT 2, Teachers)
- [ ] Bring laptop charger — keep plugged in all day
- [ ] Copy `votes.db` to a USB drive as pre-election backup (it's empty but keeps the structure safe)
- [ ] Do a dry run: start server, login as one student, cast a test vote, then **reset DB again**

### Reset DB before election day
```
node -e "
const db = require('better-sqlite3')('votes.db');
db.prepare('DELETE FROM voters').run();
db.prepare('DELETE FROM votes').run();
db.prepare('DELETE FROM settings').run();
db.prepare('DELETE FROM audit_log').run();
db.prepare('DELETE FROM sqlite_sequence').run();
db.close();
console.log('Clean.');
"
```

---

## ELECTION MORNING — Setup (Before Students Arrive)

1. **Plug in laptop**
2. **Start server** — open terminal in project folder and run:
   ```
   node server.js
   ```
   You should see: `Listening on: http://127.0.0.1:3000`

3. **Open Microsoft Edge** → go to `127.0.0.1:3000/admin.html`
   - Login with admin credentials
   - You should see green **"Start Election"** button
   - **Keep Edge open all day — this is your control panel**

4. **Open Chrome/Brave** → go to `127.0.0.1:3000`
   - You should see the student login page
   - **This is the browser students will use**

> ⚠ Never mix browsers. Edge = admin only. Chrome = students only.

---

## STARTING THE ELECTION

When you are ready and all setup is done:

1. In **Edge** (admin), click **▶ Start Election**
2. Confirm the prompt
3. Button should change to red **⏹ End Election**
4. Students can now log in and vote

---

## DURING VOTING — Class by Class

For each student:

1. Hand them their credential slip
2. They type their **Email (Login ID)** and **Password** in Chrome
3. They cast their vote
4. After submitting — browser returns to login screen automatically
5. Next student steps up

**Monitor progress** in Edge → Live tab — vote count updates every 10 seconds.

### What to do if something goes wrong mid-session

| Problem | Fix |
|---------|-----|
| Server crashes / terminal closes | Re-run `node server.js` — votes are safe in DB |
| Student types wrong password | Check their slip carefully — passwords are case-sensitive |
| Student says "already voted" error | They already voted — this is correct, move on |
| Chrome closes accidentally | Just reopen `127.0.0.1:3000` |
| Admin session expires in Edge | Re-login to admin.html — does NOT affect votes or DB |
| Laptop restarts | Start server again, re-login to admin — all votes preserved |

---

## ENDING THE ELECTION

When every student has voted:

1. Check Live tab — confirm vote count matches expected turnout
2. In **Edge** (admin), click **⏹ End Election**
3. Confirm the prompt — **this cannot be undone**
4. Printable results overlay appears
5. Click **🖨 Print Results**
6. Collect signatures from officials on printed sheet
7. **Done**

---

## AFTER ELECTION — Data Safety

Immediately after ending election, back up the database:

```powershell
# In PowerShell — run from project folder
Copy-Item votes.db "votes-backup-$(Get-Date -Format 'yyyyMMdd-HHmm').db"
```

Also export to CSV for a readable copy:

```
node -e "
const db = require('better-sqlite3')('votes.db');
const fs = require('fs');
const votes = db.prepare('SELECT candidate_id, category, COUNT(*) as votes FROM votes GROUP BY candidate_id, category ORDER BY category').all();
fs.writeFileSync('final-votes.csv', 'candidate_id,category,votes\n' + votes.map(r=>Object.values(r).join(',')).join('\n'));
console.log('Exported final-votes.csv');
db.close();
"
```

---

## EMERGENCY DATA RECOVERY

If the server crashes and results are lost from screen — the DB still has everything:

```
node -e "
const db = require('better-sqlite3')('votes.db');
console.log('VOTERS:', db.prepare('SELECT COUNT(*) as c FROM voters').get().c);
console.log('BALLOTS:', db.prepare('SELECT COUNT(*) as c FROM votes').get().c);
console.log('\nVOTE COUNTS:');
db.prepare('SELECT candidate_id, category, COUNT(*) as votes FROM votes GROUP BY candidate_id ORDER BY category, votes DESC').all().forEach(r => console.log(r.category, '|', r.candidate_id, '|', r.votes, 'votes'));
db.close();
"
```

---

## Quick Reference

| What | Where |
|------|-------|
| Start server | `node server.js` in terminal |
| Admin panel | `127.0.0.1:3000/admin.html` — open in **Edge** |
| Student voting | `127.0.0.1:3000` — open in **Chrome** |
| Credential slips | `credentials-out/credential-slips.html` |
| Database file | `votes.db` — back this up |
| Server logs | Terminal window where you ran `node server.js` |

---

*Generated for Elite Grand School Election 2082*
