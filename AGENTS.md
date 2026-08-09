# Boarding planner — project notes

> **This file is deliberately NOT committed.** The repo is public (see below) and this
> file carries internal infrastructure detail. It lives in OneDrive, so it syncs between
> machines without ever being published. `.gitignore` enforces this — do not "helpfully"
> `git add` it.

---

## 🔴 SECURITY — this repo is PUBLIC

`github.com/Fairytails123/Boardingplan` is a **public** repository (verified 2026-07-18).
Everything committed here is world-readable, including full git history.

**Before committing anything, assume it will be read by strangers.**

### Credential exposure — FIXED 2026-08-09/10 (rotation + Script Properties extraction)

The API keys that used to be hardcoded in `src/supersetplanner-feed.gs` were rotated
(old values revoked) and the script now reads `ACUITY_USER_ID` / `ACUITY_API_KEY` /
`JOTFORM_API_KEY` from **Script Properties**, lazily inside `getCreds_()` — never at
global scope (global-scope PropertiesService reads count against the 50k/day quota on
every `/exec` request). The committed source carries no secrets; the revoked values in
git history are harmless. **Never reintroduce a credential literal into this file** —
on rotation only the Script Properties values change, no code change and no deploy.

⚠️ Do NOT edit this project's Script Properties via the IDE settings page: its whole-set
save silently fails against the large runtime property blobs (dogNameCache, lastGood*,
checkinoutSnapshot). Rotate via a temporary self-seed block in `getCreds_()` pushed with
clasp, trigger one request, then remove the block and push clean.

### What is NOT a secret

`API_TOKEN` / `BOARDING_API_TOKEN` (`ft-k9-board-2024-sec`) is **public by design** — it
already ships client-side in `index.html:548` on GitHub Pages. It is an abuse
rate-limiter, not an access control. The `/exec` endpoint is `ANYONE_ANONYMOUS`. Do not
treat this token as protecting anything.

`GAS_SCRIPT_ID` and `GAS_DEPLOYMENT_ID` are not secrets and appear in the workflow file.

---

## What this project is

A boarding calendar / feeding board for Fairy Tails K9 Centre, displayed on a TV.

```
Acuity Scheduling ─┐
                   ├─→ Google Apps Script web app ──→ JSON ──→ GitHub Pages frontend
JotForm ───────────┘   (src/supersetplanner-feed.gs)          (index.html, on the TV)
```

- **Backend** — `src/supersetplanner-feed.gs`, a GAS web app. `doGet` serves JSON from a
  pinned `/exec` deployment. Modes: `boarding` (default), `feeding`, `checkinout`.
- **Frontend** — `src/index.html`, mirrored to root `index.html` by CI for GitHub Pages.
  The root copy is generated; **edit `src/index.html`, never the root copy** (CI
  overwrites it and a direct root edit does not trigger the workflow).
- **Quota hardening** — the backend caches aggressively (5h full-response cache, 6h
  appointment-type cache, permanent dog-name cache in `PropertiesService`) because Acuity
  bandwidth quota was being exhausted. The TV polls 3×/day (07:00/13:00/18:00).
- **Timezone** — the script and the TV browser must both be `Europe/London`, or stays
  appear/disappear incorrectly around midnight.

---

## Deploying

**CI is the deploy path.** Push to `main` touching `src/**`, `.clasp.json`, `.claspignore`
or the workflow, and `.github/workflows/push-gas.yml` deploys. It first succeeded on
2026-07-18 (run `29661942070`) after having never passed since 2026-03-23.

### The rule that matters

**Never paste code into the Apps Script editor without committing it.** The pipeline's
drift guard will refuse to deploy — loudly, by design — if the live script matches no
committed state, because `clasp push --force` replaces the whole project and would
destroy editor-only work. If you hit that error, reconcile rather than forcing:

```bash
clasp clone-script <SCRIPT_ID>   # into a scratch dir
# diff against src/, commit the merge, then re-run the workflow
```

### What the pipeline does

1. `sync-index` — mirrors `src/index.html` to root for Pages (rebase + retry on push).
2. Auth preflight — validates the `CLASPRC_JSON` secret is clasp **v3** shape and
   actually authenticates, so a dead token fails with a clear message.
3. **Drift guard** — fingerprints three states: repo, live HEAD, and the version the
   pinned `/exec` deployment actually serves. Deploys only if they disagree; fails if
   live matches no committed state. Fingerprints are whitespace-normalised and
   name-agnostic (Apps Script strips the trailing newline from `appsscript.json`, and the
   live file has been both `Code.js` and `supersetplanner-feed.gs`).
4. `clasp push` → `create-version --json` → `redeploy` → read back the deployment.
5. **Smoke test** — asserts real JSON with a `stays` array **and no `error` field**, with
   retries. The backend returns `{"stays":[], ..., "error":"..."}` on every failure path,
   so shape alone proves nothing.
6. **Rollback** — if anything fails after the redeploy, production is put back on the
   previous version automatically.

`workflow_dispatch` has a `force_deploy` input for when everything already matches.
Deploys are `main`-only and fail loudly on any other ref.

### Toolchain

clasp is pinned to **3.3.0** in CI and `package.json`. The `CLASPRC_JSON` secret is clasp
v3 format (`{"tokens":{"default":{...}}}`) which **clasp 2.x cannot read** — do not
downgrade. Re-secret with `gh secret set CLASPRC_JSON < ~/.clasprc.json`.

---

## Outstanding work

1. **Rotate the Acuity + JotForm keys and move them to Script Properties** (see above).
   Highest priority — live credential exposure. **Kam is doing the rotation himself at the
   start of the next session (agreed 2026-07-18); raise it before other work.** The Script
   Properties migration follows once the new keys exist.
2. **Move `CLASPRC_JSON` to a GitHub Environment secret** restricted to `main`, and add
   `environment: production` to the deploy job. The current `main`-only guard is written
   in the workflow, so it can be deleted on the branch being dispatched; an environment
   policy cannot.
3. **The full deploy path is still unproven.** The first green run legitimately skipped
   (repo, HEAD and deployment all matched). The next real `src/` change will exercise
   push → version → redeploy → smoke for the first time. Watch that run.

Detailed history, root-cause analysis and a troubleshooting runbook: `ci-deploy-handover.md`.

---

<!-- n8n-vps-brief:v1 -->
## ⚠️ n8n platform: self-hosted VPS — NOT n8n Cloud (migration active since 2026-07-04)

The business's n8n is moving from n8n Cloud (`ftmanager.app.n8n.cloud`) to a **self-hosted n8n on a Hostinger VPS**. All future work in this project must assume n8n lives on the VPS.

- **n8n editor / API / webhook base: `https://auto.thefairytails.co.uk`** (webhooks: `https://auto.thefairytails.co.uk/webhook/<path>`; workflow IDs and webhook paths were preserved from cloud).
- **Cutover status (2026-07-05): MIGRATION COMPLETE — all 32 production workflows are live on the VPS; n8n Cloud is fully inactive (0 of 47 active) and its subscription is pending cancellation (Phase F5).** **Never reactivate anything on the cloud instance** — a cloud Telegram-trigger activation would steal the bot webhook from the VPS instantly, and schedule triggers would double-fire.
- **All new and future work targets the VPS.** Build, change, and amend workflows — and any code that calls n8n — against `auto.thefairytails.co.uk`. Do not build anything new against n8n Cloud. When amending a not-yet-flipped workflow, make the change on the VPS copy and flip that workflow as part of the work (per the F4 play card), rather than investing further in the cloud copy.
- **n8n MCP deploys:** before creating/updating workflows via an n8n MCP, verify the MCP targets the VPS instance. If it still points at n8n Cloud, ask Kam to reconnect it to `https://auto.thefairytails.co.uk` first.

**Source of truth for the migration** (VPS specs, SSH access, credential + data-table ID maps, F4 cutover plan, live status): `%OneDrive%\Business\CODING\Hostinger_n8n\n8n-vps-migration-handover.md`

**Self-hosting benefits — design for them:**
- No cloud plan limits: no execution-time caps and no per-execution/active-workflow billing pressure — long-running, heavy, or chatty workflows are fine; split logic into as many workflows as is clean.
- Full server control: SSH (`root@187.124.214.24`, key `~/.ssh/id_ed25519_hostinger_n8n` on the FT Manager machine), `docker exec` n8n CLI (bulk import/export, upserts by workflow ID), container logs, compose + env under `/docker/n8n-d7un/` on the VPS.
- Community nodes can be installed if a task needs them (cloud didn't allow this).
- Static egress IP `187.124.214.24` — usable for third-party API allowlists.

**Caveats:**
- Credential IDs and data-table IDs are DIFFERENT on the VPS vs cloud (maps: `Hostinger_n8n\cloud-export-2026-07-04\cred-id-map-batch*.json`). Data Table nodes reference tables BY ID — never copy cloud IDs into VPS workflows.
- Any external caller (web page, script, form, bot, dashboard) still pointing at `ftmanager.app.n8n.cloud` must be repointed to `https://auto.thefairytails.co.uk` when its workflow flips — and must never be newly written against the cloud URL.

### n8n touchpoints in this project (scanned 2026-07-04)

- No hardcoded n8n URLs found in this project's files as of 2026-07-04 — this project's n8n logic lives in the n8n instance itself (workflows). All future n8n work targets the VPS (see above).


<!-- dualdev-standing-rules-v1 (appended 2026-08-09; canonical copy: _dev-system\templates\AGENTS.md) -->

## Standing rules (non-negotiable - Dual-Model Development System)

1. Master Google Sheet "Jot form Dog Details"
   (ID: 1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU) is permanently
   READ-ONLY. Never write, edit or modify it. Any workflow needing writes
   uses a separate derived sheet.
2. Hosting: GitHub Pages under `fairytails123` is the only permitted
   target for PWAs and web projects. Never Netlify or Vercel.
3. Additive-only edits: never remove functionality without explicit
   confirmation (sole standing exception: authorised removals named in
   the contract's Authorised scope).
4. Timestamped backup before every file edit:
   cp <file> <file>.backup-$(date +%Y%m%d-%H%M%S)
5. Branch before live on any production codebase.
6. British English throughout all code, comments, docs and output.
7. Telegram bot URLs: NO percent-encoded sequences, ever. Use + for
   spaces; strip commas, dots, parentheses and ampersands; never call
   encodeURIComponent on final values. (Telegram iOS double-encodes
   %XX -> %25XX and breaks map deep links. Verified in production
   May 2026.)
8. No secrets in chat, GitHub, worktrees or logs. Reference environment
   values by name only.
9. Transactional email via Resend; website/mailbox on Hostinger;
   IONOS is not in use.