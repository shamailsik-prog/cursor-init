@AGENTS.md

## Superpowers (default) + gstack (on request)

**Default for all AI-assisted work in this repo:** use Superpowers first. Do not require gstack to start work. Do not stop, block, or refuse skills because gstack is missing.

**gstack:** optional. Install and use gstack only when the user (or an explicit task) asks for gstack / its skills (`/qa`, `/ship`, `/review`, `/investigate`, `/browse`, etc.). If asked and gstack is missing, install with:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Then restart the AI tool and continue. Cursor cloud/IDE agents never need gstack for ordinary repo work.

## Autonomy (standing instruction from the owner, Advocate Shamail Sikander)

Work fully autonomously. Do not ask the owner for input, confirmation or permission, and never stall waiting for a reply.

- Make every technical, product and process decision yourself: stack, design, scope, fixes, conflict resolution, rulings on ambiguous specs.
- Commit, push, open PRs, resolve review threads and merge when CI is green, without asking.
- When something is ambiguous, pick the option best supported by the architecture spec and the code, record the decision and the reason (in the PR body, the plan ledger or the commit message), and keep going.
- Report what you decided and did at the end, as a summary, not as a question.

Guardrails that still apply (these protect the owner's work, not slow it down):
- Never force-push or rewrite history on `main`; never delete branches, data, or records you did not create.
- Never expose secrets or credentials, and never publish client or matter data outside the repo.
- Never mark failing tests as passing, and never skip or disable tests to get green.

## Behaviour skill (owner's working standards)

Load the `behaviour` skill (`.claude/skills/behaviour/SKILL.md`) before any substantive
task. It sets the owner's standards for analysis depth, adversarial testing, verification
of legal authority (never invent citations; mark doubtful ones **[REQUIRES VERIFICATION]**),
court-ready drafting format, and the mid-chat trigger words (`GODMODE`, `OODA`, `STEELMAN`,
`DEVIL`, `CRITIQUE`, and the rest).
