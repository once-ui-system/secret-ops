# secret-ops

Rotates the secrets our Vercel projects use without anyone copying values by hand. Each run waits for Lorant's approval in GitHub. New values go straight from the provider to Vercel, and no person or chat ever sees them.

## What it does

| Workflow | What it changes | Approval |
|---|---|---|
| **Inventory** (`discover.yml`) | Nothing. It lists the Supabase projects and their key names, every Vercel project variable, and the team shared variables, and flags secrets that are readable or that reach Development. | yes |
| **Rotate secret** (`rotate.yml`) | Gets a new value, puts it on Preview, redeploys and smoke-tests Preview, and only then moves Production and redeploys it. Projects that build only `main` (no preview deployments) skip the preview check. Defaults to a dry run. | yes |
| **Revoke old key** (`revoke.yml`) | Deletes old Supabase secret keys by id. It refuses to delete the newest one. It always runs separately, after a rotation has been checked. | yes |
| **Test** (`test.yml`) | Unit tests and the `targets.json` check, on every push. | no |

Where each target's new value comes from (`targets.json`):

- **supabase**: a new `sb_secret_` key created over the Management API.
- **generated**: 32 random bytes, used for cron and bridge secrets.
- **manual**: Stripe, Resend, Upstash and the other dashboard-only keys. You roll the key in the provider dashboard and paste it once into the `INCOMING_SECRET` environment secret. The run checks the prefix (for example `sk_live_`), so a key pasted for the wrong target is refused.

Targets marked `hold` refuse to run. Each one says why, for example "stored data is encrypted with it".

## Safeguards

- Secrets live only in the `rotation` environment. That environment accepts runs from `main` only and needs a required reviewer, so a pushed branch can't read them.
- Every Vercel value is written as **sensitive**, which nobody can read back, and never to Development.
- Production changes only after every Preview passes its smoke test. If a run fails partway, Production still has the old value.
- Values are masked in the logs. The job summary lists variable names, entry ids and Supabase key ids, never values.
- Revoking is irreversible, so it is its own approved run, and it never deletes the newest key.

## One-time setup (Lorant)

1. **Environment.** Go to Settings > Environments > New environment and name it `rotation`.
   - Required reviewers: yourself.
   - Deployment branches: Selected branches, `main` only.
   - Prevent self-review: leave it off, since you're the only reviewer.
   - Required reviewers on a private repo need GitHub Team. If the option isn't there, either make the repo public (it holds no secrets, only names and ids) or skip the reviewer and dispatch every real run yourself.
2. **Environment secrets** (in `rotation`):
   - `VERCEL_TOKEN`: a Vercel token scoped to the Dopler team (Account settings > Tokens).
   - `SUPABASE_ACCESS_TOKEN`: a Supabase personal access token (supabase.com/dashboard/account/tokens).
   - `INCOMING_SECRET`: leave it empty until a manual rotation needs it.
   - Optional `VERCEL_BYPASS_<PROJECT>` (for example `VERCEL_BYPASS_AVEIRO`): the project's Protection Bypass for Automation secret. With it, smoke tests can make HTTP requests against protected Preview deployments. Without it, a run checks only that the deployment reached READY.
3. **Environment variable:** `VERCEL_TEAM_ID` = `team_HUNHgDTpMYSXGuZj9EB97DzI`.
4. **Protect `main`:** Settings > Branches > add a rule for `main` that requires a pull request.

## Running a rotation

1. Actions > **Rotate secret** > Run workflow. Enter the target (for example `aveiro/cron`) and leave **dry run** ticked.
2. Approve the run and read its summary. It lists which Vercel entries would change.
3. Run it again with dry run unticked, and approve.
4. For a **manual** target, first roll the key in the dashboard named in `targets.json` and paste the new value into `INCOMING_SECRET`. Once the run is green, expire the old key in that dashboard, then overwrite `INCOMING_SECRET` with any placeholder.
5. For a **supabase** target, the summary lists the old key ids. Once the apps look healthy, run **Revoke old key** with those ids.

## Adding a target

Add an entry to `targets.json` with a source and destinations, plus smoke checks if the project has them. Names and ids only, never values. `npm test` checks the file and refuses anything that looks like a secret value.

## Local

```
npm test
node scripts/rotate.mjs aveiro/cron --dry-run   # needs VERCEL_TOKEN and VERCEL_TEAM_ID
```
