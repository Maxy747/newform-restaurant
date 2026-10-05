# Simultaneous Codex + Claude work

## Separate files, shared Git history

- Codex checkout: `C:/Users/MoeLustHer/Documents/ChatGPT/Max`, branch `max`.
- Claude checkout: `C:/Users/MoeLustHer/Documents/ChatGPT/newform-claude`, branch `codex/claude-work`.
- Deploy repository: `https://github.com/Maxy747/newform-restaurant` (remote `maxy747`, production branch `main`).
- Original upstream remote `origin` is JUUDER's repository, not the deployment destination.
- These are Git worktrees: source files and dependencies are separate; Git objects and refs are shared.
- Never check out, reset, clean, or modify files in the other agent's directory. Never force-push.

## Task ownership

The user should give each agent a distinct task and pass along the other agent's active scope. Prefer separate files/features. If both need the same code, agree on ownership or defer the overlapping edit until integration. Worktrees prevent file overwrites, not semantic merge conflicts. Agents do not automatically see each other's conversation or uncommitted work.

## Claude handoff

1. Inspect `git status --short` and current branch before working.
2. Install dependencies with `npm ci` in your own checkout; use a distinct dev-server port (for example `npm run dev -- --port 5174`).
3. Do not copy private environment files, database exports, or credentials. Ask for an approved test environment when needed. Production browser keys do not make production data safe to modify.
4. Run `npm test`, `npm run build`, and `git diff --check`. Check relevant mobile layouts.
5. Stage only your files, commit on `codex/claude-work`, and give the user/Codex the hashes and a concise handoff. Do not push `main` or deploy Supabase.
6. A feature branch may be pushed to `maxy747` when the user requests remote review. Do not run production mutations for QA.

## Integration and deployment (Codex by default)

Only one agent deploys. Review Claude's completed commit diff, then cherry-pick its explicit commit hashes into `max` after ensuring there are no overlapping uncommitted edits. Resolve conflicts deliberately; never blanket-select one side. Run the full tests/build and relevant UI checks on the combined result before `git push maxy747 max:main`. Verify the matching GitHub Actions deployment succeeds.

After integration, coordinate a clean synchronization point with Claude before merging `max` into its branch. Never reset an actively used branch. To transfer integrator responsibility, tell both agents and stop deployments from the former integrator first.

## Shared backend safety

Supabase production project: `crlivalipmeypovsubca`. Both worktrees would reach the same backend if configured with production credentials. Worktree separation does NOT isolate orders, menu rows, storage, auth, function deployments, or migrations.

Claude should implement/test backend changes locally or against a separately approved development project and hand off migration/function changes. Only the integrator applies production migrations and deploys functions. Use unique migration timestamps; never rewrite applied migrations. Never include secrets or service-role credentials in commits, logs, or handoff documents.

## Current baseline

Application baseline: `25b5117`. Static Vite frontend, Supabase backend. Main files: `index.html`, `styles.css`, `app.js`, `orders.js`; functions in `supabase/functions`, migrations in `supabase/migrations`.

Cart has a scrollable `#cartScroll` and a separate pinned checkout bar. Preserve item visibility. Delivery is free for first 5 road km, then Rs15/km proportionally, capped at 40 km. Place order calculates missing/expired quotes using geolocation. Manual coordinates were removed. Razorpay is hidden and unconfigured; COD remains disabled with the label "Available from Rs799 onwards" (label only; older backend threshold was Rs1000). WhatsApp is selected. Never place real orders/payments as a test.

The primary checkout has unrelated untracked projects and private artifacts: never use `git add .` or broad cleanup commands.
