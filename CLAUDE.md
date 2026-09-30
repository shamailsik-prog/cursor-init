@AGENTS.md

## gstack (REQUIRED for Claude Code; global install)

Applies to Claude Code sessions only. Cursor agents (cloud or IDE) are exempt and must not stop for a missing gstack.

Check (same paths as `.claude/hooks/check-gstack.sh`):

```bash
_GSTACK_ROOT=""
for _D in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  [ -z "$_GSTACK_ROOT" ] && [ -n "$_D" ] && [ -d "$_D/bin" ] && _GSTACK_ROOT="$_D"
done
if [ -n "$_GSTACK_ROOT" ]; then echo GSTACK_OK; else echo GSTACK_MISSING; fi
```

**Claude Code only — if `GSTACK_MISSING`:** stop immediately and show:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Then restart Claude Code. Do not continue repo work until gstack is installed.

After install, skills such as `/qa`, `/ship`, `/review`, `/investigate`, and `/browse` are available (default install path `~/.claude/skills/gstack`).

The PreToolUse hook in `.claude/settings.json` enforces gstack only when Claude Code invokes the **Skill** tool; it does not run for Cursor agents.

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
