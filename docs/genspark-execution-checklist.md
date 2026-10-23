# Genspark Execution Checklist

## Before starting
- [ ] Open Genspark and start a project/Super Agent task with repository access.
- [ ] Paste the master prompt from `docs/master-system-prompt-genspark.md`.
- [ ] Attach/link the repository and supporting documents.
- [ ] Ask Genspark to audit before changing files.
- [ ] Confirm it can actually access the repository; if not, stop and report the access error.

## Safe execution rules
- [ ] Do not paste passwords, cookies, OTPs, or API tokens into the prompt.
- [ ] Do not authorize production deployment, public publishing, paid spend, account connection, or destructive changes by default.
- [ ] Require small commits or patch-sized changes.
- [ ] Require tests and exact command results.
- [ ] Require a report of changed files, commit references, preview links, blockers, and remaining work.
- [ ] Treat generated code as unverified until tests and review are completed.

## After each task
- [ ] Confirm the returned repository/branch/commit matches the intended project.
- [ ] Review the diff and check that no secrets or unrelated changes were introduced.
- [ ] Verify tests/build and check the actual preview/deployment separately.
- [ ] Check mobile UI and core data workflows.
- [ ] Update the implementation backlog only for verified work.
- [ ] Record blockers rather than inventing a success status.

## Connection status
A copy-ready prompt is a handoff artifact, not proof that Genspark has been connected to ChatGPT or that a task was submitted. Only label a task submitted/running/completed when Genspark returns verifiable task evidence.
