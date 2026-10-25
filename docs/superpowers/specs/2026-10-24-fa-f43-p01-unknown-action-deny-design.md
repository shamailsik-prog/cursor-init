# FA-F43-R1-P01: the P5 decision table refuses an action it does not know

Date: 2026-10-24 (built 2026-10-25). Finding: FA-F43-R1-P01, MEDIUM, pre-existing P5 (issue #30). Branch:
`claude/remediate-fa-f43-p01` from main 5840d3d. Owner ruling (standing): autonomous; every ruling below is recorded with
its reason and was not put to the owner.

## 1. Observe: main 5840d3d

`platform/p5/permissionDecision.ts` `decide()` is the one table both runtimes evaluate (I-3 / U-2):

- Next.js: `platform/p5/checkPermission.ts` `checkPermission(store, userId, action, matterId?, extra?)` reads the in-memory
  store, calls `decide`, and appends one `permission_check` row (`allow|deny:<action>:<reason>`).
- Cloud Functions: `functions/src/p5/permission.ts` `checkPermission(caller, action, matterId?, extra?)` reads Firestore
  (matter, tombstone, membership), calls `decide`, and appends one `audit_log` row. `requirePermission` wraps it and maps a
  deny to 403. Three Functions sites call `decide` directly (`functions/src/d1/matter/ops.ts` twice, `functions/src/p2/ops.ts`
  once) for a row-level filter, and `functions/src/d4/drafts.ts` `requireStillPermitted` calls it inside a transaction.
- Functions bundles the same file through the `@/` alias, so there is one table, not two. Neither stack has a default
  allow of its own: each returns exactly what `decide` returns (or a fail-closed deny: `invalid-matter-id`,
  `store-unavailable`, `audit_unavailable`).

The last line of `decide` is `return allow("ok")`. Every action no row returns for reaches it, after one generic matter gate
(`cross-firm`, `matter-deleted`, `not-member`, `clearance`) when a matter is named.

### 1.1 Inventory: every action that reaches `decide` (main 5840d3d)

Counted from the call sites (the new gate's `--print-inventory` lists each one with file and line).

| Action | Callers | Covered by a row on main? | What main allows |
|---|---|---|---|
| `research` | 134 Next sites: `app/api/d2/ops-reporting/route.ts` (132), `services/d2-2/courtOps.ts` (1, matter-level), `services/d2-1/whatsapp.ts` (1, no matter) | Partly. Rows deny an intern (`intern-channel-denied`) and a client or `own_matters` scope (`client-channel-denied`). **The allow is the fall-through.** | partner, associate, clerk (after the matter gate when a matter is named) |
| `draft` | 63 Next sites: `app/api/d4/filings/route.ts` (57), `app/api/d4/drafts/route.ts` (1), `services/d4-1/drafts.ts` (1), `services/d4-3/closureVisibility.ts` (1), `services/d4-3/filingPackage.ts` (3) | Partly, as `research`. **The allow is the fall-through.** | partner, associate, clerk |
| `list_matters` | 2 Next sites: `app/api/d1/matters/route.ts`, `services/d2-1/whatsapp.ts` | Yes: an explicit `allow` row (client or `own_matters`: `client-own-matters`) | partner, associate, clerk, intern, client |
| `normalise_case_number` | 1 Next site: `app/api/g0/normalise/route.ts` | Partly: `STAFF_ONLY_ACTIONS` denies a client or `own_matters` (`staff-only`). **The allow is the fall-through.** | partner, associate, clerk, intern |
| `committee_brain` | 1 Next site: `platform/p5/committeeScope.ts` `canAccessMatter`, default parameter value, from `resolveCommitteeScope` (POST `/api/p1/committee-brain`) | **No row.** Fall-through after the generic matter gate. | partner, associate, clerk, intern, client (a member, cleared) |
| `committee_brain_read` | the same `canAccessMatter`, passed by GET `/api/p1/committee-brain` | **No row.** Fall-through after the generic matter gate. | partner, associate, clerk, intern, client (a member, cleared) |
| `intimation_register`, `record_accounts_entry` | no call site | Accounts only (`accounts-register`); any other role **falls through** | every non-accounts role |
| 5 firm-administration, 5 retention, 16 D1, 4 job, 2 alert, 4 AI, 6 draft, `doctype.read` | Functions only: 35 literal sites plus 3 direct `decide` literals, and typed forwards (`gateMatter`, entity `gate`, `requireMatterAction`, `requireStillPermitted`, `requirePartner`, `requirePermission`) | Yes, each by its family's role table | as the table rules |
| any other string | no production call site; tests pass `read`, `read_matter`, `read_firm` | **No row.** Fall-through. | every role except accounts (`accounts-register-only`); with a matter named, every member who is cleared |

`alert.read` and `alert.ack`: the finding records that on an earlier main they fell through for associates, clerks, interns
and clients. PR #120 (F43, 0d9af65) added `ALERT_ACTIONS` (partner only), so on 5840d3d they are decided by a row and the
fall-through no longer reaches them. They stay GREEN on both main and the branch; they are not a RED case.

No HTTP route on main passes a caller-chosen action: every route passes a literal or a typed parameter. The unknown-action
hole is therefore reached at the P5 entry points (a new caller, a typo, a refactor), not through a route a caller can steer
today. That is why the finding is MEDIUM, and why the RED cases below are at the two P5 entry points with their audit rows,
while the real routes are regression guards that stay GREEN on both.

## 2. Orient: the spec

- L18 §4.5 (`docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` lines 8161-8164): `checkPermission(userId, action,
  matterId?)` "returns allow/deny with reason"; it is "the single authority"; a channel "may pass additional restrictions
  to it ... but may never pass elevations". An unknown action is not a restriction; allowing it is an elevation by default.
- L18 §8 (lines 8438-8440): every WhatsApp command calls checkPermission first; "the client sees only own matters and
  hearings and cannot invoke /research or /drafts".
- L19.10 (line 9623): `/research` is "P5.checkPermission then D5-1; client-scope numbers denied".
- L19 residuals (line 9710): "whether interns may see the research shelf at all (default: read-only on notes of their
  matters)" is left to the firm. The table has denied interns `research` since Phase 1 (`intern-channel-denied`).
- L17.6 #40, #41 (lines 7109-7110): the intimation register is "visible on the matter and in the dashboard (L4.8)"; "the
  accounts role ... with read access to the intimation register only".
- L4.7 (lines 3506-3523): roles and granular permissions are an administrator console ("e.g. clerk = upload + dispatch;
  partner = all"). The console is not built; the table is the rule today.
- P3-70 (`docs/superpowers/specs/2026-10-11-phase3d-p1-ai-layer-design.md` line 44): `ai.call`, the Functions twin of the
  committee call, is "matter-level (same firm, member, cleared), roles partner, associate and clerk (the Next.js route
  excludes client, intern and accounts)".
- P4-10 (`docs/superpowers/specs/2026-10-11-phase4a-gated-draft-design.md` line 42): `draft.create`, `draft.edit`,
  `draft.gate`, `draft.read`: partner, associate, clerk; "Interns stay denied, as today (`intern-channel-denied`)".
- Re-audit N-2 (commit c815aa1, `app/api/g0/normalise/route.ts` lines 34-35): `/api/g0/normalise` is "a staff tool
  (partner, associate, clerk, intern), never a client".

## 3. Decide: rulings

**R1. The table ends in `deny("unknown-action")`.** The last line of `decide` becomes `return deny("unknown-action")`, after
every row. *Why at the end and not right after `no-user`:* the brief says so, and it keeps every existing reason for every
existing row (an accounts caller still gets `accounts-register-only` for anything off its register, as today). *Steelman
for checking first:* one uniform reason for every unknown action, accounts included. *Answer:* accounts are already refused
everything off the register by the row before; the reason there is the more informative one, and the audit history keeps
its meaning. Both stacks get it at once, because both call this function.

**R2. One explicit table for the Next routes' actions, `NEXT_ROUTE_ACTIONS`, with roles from the spec or the route.** No
blanket legacy allow.

| Action | Roles | Matter | Source |
|---|---|---|---|
| `list_matters` | partner, associate, clerk, intern; a client or the `own_matters` scope get `client-own-matters` | never gated (a listing, scoped later by membership) | the existing explicit row, unchanged; L18 §8 `/matters` (line 8429) |
| `research` | partner, associate, clerk | gated when a matter is named; firm-level otherwise (WhatsApp `/research <query>`) | L18 §8, L19.10 (client denied); the Phase 1 intern row; the routes: `app/api/d2/ops-reporting/route.ts` line 12535 and `services/d2-2/courtOps.ts` `requireOpsActor` refuse client, intern and accounts |
| `draft` | partner, associate, clerk | gated when a matter is named | P4-10 (the same roles for the D4 draft actions; interns denied as the legacy `draft`); L18 §8 (client denied) |
| `normalise_case_number` | partner, associate, clerk, intern | gated when a matter is named (no caller names one) | re-audit N-2, c815aa1 |
| `committee_brain` | partner, associate, clerk | **must** name a matter (none: `cross-firm`, fail closed) | P3-70 (`ai.call`); the route's `requireActor` refuses client, intern and accounts |
| `committee_brain_read` | partner, associate, clerk | **must** name a matter | the GET route's `requireActor` (the same guard) |

Every role these rows refuse is a role the route already refused before P5 was consulted, so no permitted caller of a real
route loses access (section 4).

**R3. The existing reason codes stay.** An intern's `research` or `draft` is `intern-channel-denied`; a client's (or the
`own_matters` scope's) is `client-channel-denied`; a client's `normalise_case_number` is `staff-only`; a client's
`list_matters` is `client-own-matters`. The two committee actions, which had no row, follow the AI family's codes (their
Functions twin `ai.call`): a client or `own_matters` scope is `client-denied`, and an intern `role-not-permitted`. *Why:*
the reasons are an interface (the audit rows, the 403 bodies `permission denied: <reason>`, and the tests); changing them is
not needed to close the finding.

**R4. The committee actions are matter-level.** `canAccessMatter` always passes a matter, and `ai.call` must name one. A
committee decision with no matter now fails closed (`cross-firm`) instead of reaching the default.

**R5. Accounts register actions keep their row; every other role is refused `role-not-permitted`.** No route serves the
register to staff today. L17.6 #40 says the register is "visible on the matter and in the dashboard"; when that route is
built its roles are ruled then (follow-up 1). Until then refusing is the fail-closed reading, and naming the reason
(`role-not-permitted`, not `unknown-action`) records that the action is known.

**R6. The unreachable `client-research-denied` row is removed.** A client's `research` returns `client-channel-denied`
two rows earlier, on main as on the branch, so the row could never decide anything.

**R7. `DECIDE_ACTIONS` is the one list of every action the table decides.** It is the spread of the family lists
(`FIRM_ADMIN_ACTIONS`, `RETENTION_ACTIONS`, `ACCOUNTS_ACTIONS`, `D1_ACTIONS`, `JOB_ACTIONS`, `ALERT_ACTIONS`, `AI_ACTIONS`,
`DRAFT_ACTIONS`, `DOCTYPE_ACTIONS`, `NEXT_ROUTE_ACTIONS`), exported with `isKnownAction`. A unit test proves the list and
the function agree: every listed action gets a row's decision (never `unknown-action`) for every role, and any other
string gets `unknown-action` for every role but accounts. The gate (R9) reads the same list.

**R8. `canAccessMatter`'s action parameter is typed `CommitteeBrainAction`** (`"committee_brain" | "committee_brain_read"`).
A type change only: the gate can then resolve the forwarded action statically, and TypeScript holds every caller of
`canAccessMatter` to those two values.

**R9. A parity gate, G-0 check [23]: `ci_gates/check_permission_actions.py`.** No open branch or PR had claimed [23] when
this was built (checked 2026-10-25 against every `claude/*`, `cursor/*` and `antigravity/*` head and the open PRs #35,
#108, #130, #131).

- *Why Python:* G-0 runs before `node_modules` exists (the gates job's "Gate G-0 static" step), as every other G-0 check.
- *Scope:* every JS/TS file the G-0 walker yields (`g0_guard_common.iter_scan_files`: root `tests/` and `ci_gates/` are
  skipped), minus `functions/test/` and `functions/lib/`. Tests pass unknown actions on purpose.
- *Entry points:* `checkPermission` from `platform/p5/checkPermission` (action = argument 3), `decide` from
  `platform/p5/permissionDecision` (argument 2), `checkPermission` and `requirePermission` from `functions/src/p5/permission`
  (argument 2). Imports are resolved by path (`@/`, relative, with or without an extension or `/index`), `as` aliases
  included; the defining module's own calls count.
- *Resolution:* a plain string literal is checked against `DECIDE_ACTIONS`. An identifier is resolved through its nearest
  preceding declaration in the file: a parameter or variable whose type annotation is a union of string literals or of the
  table's action types (`D1Action`, `DraftAction`, `FirmAdminAction`, `CommitteeBrainAction`, ...), each member checked.
- *Failures:* an action not in the table (`unknown_action`); a template literal (`template_action`); an identifier with no
  resolvable annotation, a member expression, a call, a conditional, a concatenation or a spread (`computed_action`); a
  missing argument (`missing_action`); a namespace or default import, `export *`, a re-export, `import()` or `require()` of an
  entry module (`untracked_binding`); an entry name used other than as a call (`escaped_reference`); a listed computed site
  that no longer exists (`stale_listing`).
- *Explicit listing:* two computed sites are listed, each the P5 entry point forwarding its own caller's action:
  `platform/p5/checkPermission.ts` (`decideFromTable(user, action, ...)`) and `functions/src/p5/permission.ts` (`decide(caller,
  action, ...)` in `evaluate`). Every call into those entry points is itself checked.
- *Flags:* `--print-known` (the parsed `DECIDE_ACTIONS`, read by the unit test that compares it with the TypeScript list) and
  `--print-inventory` (every call site and its resolved actions, for the PR's inventory).
- *Fixtures:* `ci_gates/test_check_permission_actions.py` builds small trees and requires a failure for an unlisted literal,
  an action from an untyped variable, a template string, and each other failure kind; G-0 [23] runs it as [22] runs its own.

**R10. The Functions twin.** `functions/src/p5/permission.ts` has no table and no default of its own; it inherits R1. Its
`requirePermission` already maps any deny reason to a 403 code (`unknown-action` becomes `unknown_action`). Only its doc
comment changes. No Functions route changes behaviour: every Functions call site passes an action a row decides.

**R11. The entry points keep `action: string`.** Narrowing `checkPermission`'s parameter to the table's action type would make
TypeScript do part of the gate's work, but it touches about 240 call sites and every test that passes an unknown action on
purpose. Deferred (follow-up 2); the gate and the default deny close the finding without it.

**R12. Tests.** Test first; each RED case is shown failing against main's three production files, then passing.

- RED (P5 entry points): an unknown action is refused `unknown-action` for partner, associate, clerk, intern and client, with
  the audit row each stack writes (Next `permission_check` row; Functions `audit_log` row on the Firestore emulator).
- RED (decision matrix): each fall-through action keeps exactly its ruled roles (on main the committee actions are allowed
  to an intern and a client; the accounts register actions to every staff role).
- GREEN (real routes, Auth + Firestore emulators, production persistence, Firebase sessions): POST `/api/g0/normalise`
  (`normalise_case_number`), POST and GET `/api/p1/committee-brain` (`committee_brain`, `committee_brain_read`), GET
  `/api/d1/matters` (`list_matters`), GET `/api/d2/court-ops` (`research`, matter-level), GET `/api/d4/drafts` (`draft`), each
  for its permitted roles and refused for the others as before. Lean: one firm, created in `beforeAll`, removed in `afterAll`.
- The gate's fixtures; the gate run against main's tree (it fails: no `DECIDE_ACTIONS`, an untyped forward).
- Mutation: at least 10 mutants over the default deny, each new row and the gate's walker.

**R13. Changed test expectations.** The suites that used an unknown action (`read`, `read_matter`, `read_firm`) as a stand-in
for "a matter-level action" now use a real one (`matter.read` or `research`), so the matter gate is still pinned. The cases
that asserted the fall-through itself (a client "may read" a member matter with `read_matter`; a firm-level `read_firm` is
allowed; an intern's `committee_brain` is allowed) now assert the refusal. Each is listed in the PR body.

## 4. Consumer impact

| Who | Before | After | Reaches a user? |
|---|---|---|---|
| intern, `committee_brain` / `committee_brain_read` | P5 allow (member, cleared) | `role-not-permitted` | No: the route's `requireActor` refuses an intern first (P3-70: "the Next.js route excludes client, intern and accounts") |
| client, `committee_brain` / `committee_brain_read` | P5 allow (member, cleared) | `client-denied` | No: the same `requireActor` |
| any staff role, `intimation_register` / `record_accounts_entry` | P5 allow | `role-not-permitted` | No: no call site |
| any caller, an action no row knows | allow `ok` | `unknown-action` | No production call site passes one (the gate now fails the build if one appears) |
| everyone else, every action in section 1.1 | unchanged | unchanged | - |

## 5. Residuals

1. The gate resolves an identifier from its nearest preceding declaration in the same file; a shadowing declaration in a
   nested scope between the two is not modelled. A wrong resolution can only make the gate stricter or looser on a
   build-time check: at run time the default deny refuses any action no row knows.
2. A cast at a typed wrapper's call site (`x as DraftAction`) passes TypeScript and the gate; `decide` still refuses the
   value if no row knows it.
3. A dynamic `import()` with a computed specifier of an entry module is not resolvable; F34's check [21] already refuses a
   computed loader under `functions/src`, `platform/` and `services/`.

## 6. Follow-ups

1. Rule the staff roles for `intimation_register` when its route (L17.6 `getIntimationRegister`) is built.
2. Narrow the entry points' `action` parameter to the table's action type (R11).
3. L4.7's per-firm role editor, when built, replaces fixed role lists; the rows here are the defaults it would start from.
