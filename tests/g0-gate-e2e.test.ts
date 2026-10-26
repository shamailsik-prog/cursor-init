/**
 * FA-CI-001 (re-audit 2026-10-16, defect 5): drive `bash ci_gates/gate_g0.sh` end to end.
 *
 * A minimal tree that clean G-0 accepts is copied into a temporary git repository: the gate
 * scripts, the Phase 0 files the other checks read, the FA-D3C allowlisted corpus_service files,
 * the root Playwright e2e tooling, and a legitimate provider import inside the Cloud Functions P1 boundary. The
 * control run must pass. Each case then plants one violation in a fresh copy and the whole gate
 * must fail and name the planted file in the scraper- or provider-guard report.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
// The gate process is killed before the test times out, so a hang fails with its output.
const GATE_PROCESS_TIMEOUT_MS = 60_000;
const GATE_TIMEOUT_MS = 90_000;

// Every temp directory is registered the moment it exists, so afterAll removes it even when
// populating it throws.
const tempDirs: string[] = [];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function copyFromRepo(dest: string, rel: string): void {
  fs.cpSync(path.join(repoRoot, rel), path.join(dest, rel), {
    recursive: true,
    filter: (src) => path.basename(src) !== "__pycache__",
  });
}

function plant(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

/** Environment for child processes: no inherited git repository overrides. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync(
    "git",
    [
      "-c", "init.defaultBranch=main",
      "-c", "user.name=g0-e2e",
      "-c", "user.email=g0-e2e@example.invalid",
      "-c", "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: childEnv({}) },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
}

function runGate(cwd: string): { status: number | null; out: string } {
  const res = spawnSync("bash", ["ci_gates/gate_g0.sh"], {
    cwd,
    encoding: "utf8",
    env: childEnv({
      BASE: "HEAD",
      HEAD: "HEAD",
      SIKANDER_LIVE: "0",
      SIKANDER_GATE_TOOL_ROOT: repoRoot,
    }),
    timeout: GATE_PROCESS_TIMEOUT_MS,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function buildBaseTree(): string {
  const dir = mkTemp("g0-e2e-base-");
  for (const rel of [
    "ci_gates",
    "data",
    "postgres/ddl",
    "firestore.rules",
    // Root Playwright e2e tooling: the one sanctioned Playwright use (root devDependency,
    // root config, root tests/ specs, and the script that runs them).
    "package.json",
    // Check [18] (audit F39) requires the root manifest's lockfile beside it, matching it, and the install surfaces
    // that ci_gates/lockfile_install_allowlist.json vouches for (an entry without its surface fails as stale), with
    // the directories they install (the root and functions/).
    "package-lock.json",
    ".claude/hooks",
    ".cursor/environment.json",
    "functions/package.json",
    "functions/package-lock.json",
    "playwright.config.ts",
    "tests/e2e",
    "scripts/e2e-console-auth.sh",
    // Check [16] compares the runner, this ledger and the frontend-real test file names.
    "docs/audits/lattice-focused-ops-vitest-bundle.md",
    // Check [17] (audit F17) compares the committee routing, the registry version, the grounding rules and the
    // evaluation set with the evaluation record.
    "functions/src/p1/costTable.ts",
    "platform/p1/constants.ts",
    "platform/p1/systemPolicy.ts",
    "functions/src/p1/grounding.ts",
    "docs/evals",
    // Check [20] (audit F32): deploy manifest, Firebase contract files, Functions sources for exports/alerts/TTL writers.
    "infra",
    "firebase.json",
    "firestore.indexes.json",
    "docs/deploy",
    "functions/src",
    // Check [21] (F34 R29, R32): tsconfig resolution and Gateway key-name grant holder.
    "functions/tsconfig.json",
    "platform/p1/providerKeyGuard.ts",
    "platform/http",
    "scripts/deploy-preflight.sh",
    "app/api/p1/committee-brain/route.ts",
    "app/api/d1/documents/route.ts",
    // Check [22] (audit F42): the data inventory gate finds stores in firestore.rules, Firestore collection literals,
    // object key prefixes and Postgres tables; these three files name the collections, the object prefix and the tables
    // found nowhere in the paths above, so no inventoried store reads as stale in the minimal tree.
    "platform/persistence/firestoreSpineRepositories.ts",
    "platform/documents/documentObjectStore.ts",
    "corpus_service/scraper/models.py",
    // FA-F42-R1-008 (spec R28): a server-only collection must be named in code, not only in firestore.rules; these two
    // files hold the constants (AUDIT_OUTBOX_COLLECTION, MATTER_TOMBSTONES) the copied Functions sources name them by.
    "platform/persistence/auditOutboxContract.ts",
    "platform/retention/tombstone.ts",
    // Check [20] (audit F42): the runbook of the retention.deletion_unacknowledged alert.
    "docs/runbooks/retention-deletion.md",
    // Check [20] next.corpusResearch (audit FA-D5-003): the files the manifest names for the research reader.
    "corpus_service/docker/postgres/provision-roles.sh",
    "services/d5-1/researchCorpus.ts",
    "platform/corpus/pgResearchCorpus.ts",
  ]) {
    copyFromRepo(dir, rel);
  }
  for (const name of fs.readdirSync(path.join(repoRoot, "tests"))) {
    if (/^ops\..*-frontend-real\.test\.ts$/.test(name)) copyFromRepo(dir, `tests/${name}`);
  }
  // The FA-D3C-001/002 allowlisted files must be present, or their entries go stale.
  const allow = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "ci_gates", "g0_guard_allowlist.json"), "utf8"),
  ) as Record<string, string[]>;
  const allowlisted = new Set(Object.values(allow).flat().map((entry) => entry.split(":")[0]));
  for (const rel of allowlisted) copyFromRepo(dir, rel);
  // Legitimate provider SDK imports inside the P1 boundary: Cloud Functions P1 only. Audit F18: platform/p1 is the Next
  // and eve half of P1, which holds no provider path; check [19] fails a provider import there (case below).
  plant(
    dir,
    "functions/src/p1/probe-transport.ts",
    'import Anthropic from "@anthropic-ai/sdk"\nexport const client = Anthropic\n',
  );
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "g0 e2e base tree");
  return dir;
}

function caseTree(base: string): string {
  const dir = mkTemp("g0-e2e-case-");
  fs.cpSync(base, dir, { recursive: true });
  return dir;
}

const PW_IMPORT = 'import { chromium } from "playwright"\nexport const browser = chromium\n';
const OPENAI_IMPORT = 'import OpenAI from "openai"\nexport const client = OpenAI\n';

/** `extra`: further files planted beside `rel` (a case that needs two files, such as the auditor's T4b). */
type GateCase = { name: string; rel: string; body: string; reports: string[]; extra?: Record<string, string> };

const PLANTED: GateCase[] = [
  // Re-audit defect 1: skip-anywhere.
  { name: "D1 playwright in app/ci_gates/", rel: "app/ci_gates/route.ts", body: PW_IMPORT, reports: ["app/ci_gates/route.ts: playwright import"] },
  { name: "D1 openai in lib/_superseded/", rel: "lib/_superseded/x.ts", body: OPENAI_IMPORT, reports: ["lib/_superseded/x.ts: provider SDK (openai)"] },
  { name: "D1 playwright in functions/src/.eve/", rel: "functions/src/.eve/x.ts", body: PW_IMPORT, reports: ["functions/src/.eve/x.ts: playwright import"] },
  // Re-audit defect 2: multi-line import and re-export.
  { name: "D2 multi-line import in lib/", rel: "lib/browser.ts", body: 'import {\n  chromium,\n} from "playwright"\n', reports: ["lib/browser.ts: playwright import"] },
  { name: "D2 multi-line import in services/", rel: "services/d9/browser.ts", body: 'import {\n  chromium\n} from "playwright";\n', reports: ["services/d9/browser.ts: playwright import"] },
  { name: "D2 re-export in lib/", rel: "lib/reexport.ts", body: 'export { chromium } from "playwright"\n', reports: ["lib/reexport.ts: playwright import"] },
  { name: "D2 re-export in services/", rel: "services/reexport.ts", body: "export { chromium } from 'playwright';\n", reports: ["services/reexport.ts: playwright import"] },
  // Re-audit defect 3: Python from-imports, subpaths, backtick dynamic import.
  { name: "D3 from openai import AsyncOpenAI", rel: "services/py/llm.py", body: "from openai import AsyncOpenAI\n", reports: ["services/py/llm.py: provider SDK (openai)"] },
  { name: "D3 from anthropic import AsyncAnthropic", rel: "services/py/claude.py", body: "from anthropic import AsyncAnthropic\n", reports: ["services/py/claude.py: provider SDK (anthropic)"] },
  { name: "D3 openai/client subpath", rel: "lib/llm.ts", body: 'import { OpenAI } from "openai/client"\nexport const c = OpenAI\n', reports: ["lib/llm.ts: provider SDK (openai)"] },
  { name: "D3 backtick import(`openai`)", rel: "lib/lazy.mjs", body: "export const load = () => import(`openai`)\n", reports: ["lib/lazy.mjs: provider SDK (openai)"] },
  // Re-audit defect 4: manifests, Dockerfile.* and shell scripts.
  { name: "D4 openai[datalib] in requirements.txt", rel: "services/py/requirements.txt", body: "openai[datalib]==1.0.0\n", reports: ["services/py/requirements.txt: requires openai"] },
  { name: "D4 requirements-test.txt", rel: "corpus_service/requirements-test.txt", body: "pytest==9.1.1\nopenai==1.0.0\n", reports: ["corpus_service/requirements-test.txt: requires openai"] },
  { name: "D4 Dockerfile.worker", rel: "services/worker/Dockerfile.worker", body: "FROM node:22\nRUN npx playwright install chromium\n", reports: ["services/worker/Dockerfile.worker: Playwright install"] },
  { name: "D4 shell script", rel: "scripts/install-browsers.sh", body: "#!/usr/bin/env bash\nnpx playwright install --with-deps chromium\n", reports: ["scripts/install-browsers.sh: Playwright install"] },
  // PR #57 review round: comments between tokens (Codex P2 #1), ash shebang (Codex P2 #2).
  { name: "P2#1 comment between from and specifier", rel: "lib/commented.ts", body: 'import OpenAI from /* rationale */ "openai"\nexport const o = OpenAI\n', reports: ["lib/commented.ts: provider SDK (openai)"] },
  { name: "P2#2 #!/bin/ash script", rel: "services/bin/ash-setup", body: "#!/bin/ash\nnpx playwright install chromium\n", reports: ["services/bin/ash-setup: Playwright install"] },
  // Caught before this change; must stay caught end to end.
  {
    name: "audit probe: OpenAI + Playwright in app/",
    rel: "app/api/probe/route.ts",
    body: `${OPENAI_IMPORT}${PW_IMPORT}`,
    reports: ["app/api/probe/route.ts: playwright import", "app/api/probe/route.ts: provider SDK (openai)"],
  },
  // Audit F18, check [19]: the Next and eve runtime holds no paid AI client, platform/p1 included.
  {
    name: "F18 openai under platform/p1 (the Next half of P1)",
    rel: "platform/p1/probe-gateway.ts",
    body: OPENAI_IMPORT,
    reports: ["platform/p1/probe-gateway.ts: imports openai"],
  },
  {
    name: "F18 the ai SDK's generateText in a Next route",
    rel: "app/api/brain/route.ts",
    body: 'import { generateText } from "ai"\nexport const g = generateText\n',
    reports: ["app/api/brain/route.ts: imports ai"],
  },
  {
    name: "openai dependency in functions/package.json",
    rel: "functions/package.json",
    body: JSON.stringify({ dependencies: { openai: "4.0.0" } }),
    reports: ["functions/package.json: dependencies lists openai"],
  },
  // Audit F34 R1-003, check [21]: the re-auditor's two planted ad-hoc send sites (re-audit evidence
  // template-experiments.json T4 and T4b), which passed the call-site regex and G-0 at e37b115.
  {
    name: "F34 R1-003 T4: an alias of activeTransport() sending an unregistered system prompt from functions/src",
    rel: "functions/src/p1/zzAuditAdhoc.ts",
    body:
      'import { activeTransport } from "./transport"\n\n' +
      "export async function adhocSummary(text: string): Promise<string | undefined> {\n" +
      "  const gw = activeTransport()\n" +
      '  const reply = await gw?.send({ messages: [{ role: "system", content: "You are a helpful assistant. Summarise." }, { role: "user", content: text }], model: "anthropic/claude-opus-5.5", maxTokens: 512 })\n' +
      "  return reply?.text\n" +
      "}\n",
    reports: ["FAIL: functions/src/p1/zzAuditAdhoc.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "F34 R1-003 T4b: the send placed in platform/p1 and handed the transport from functions/src",
    rel: "functions/src/p1/zzAuditAdhoc2.ts",
    body:
      'import { adhocSend } from "@/platform/p1/zzAuditAdhoc"\nimport { activeTransport } from "./transport"\n' +
      "export const adhoc = (text: string) => adhocSend(activeTransport()!, text)\n",
    extra: {
      "platform/p1/zzAuditAdhoc.ts":
        "type T = { send(r: { model: string; messages: { role: string; content: string }[]; maxTokens: number }): Promise<{ text?: unknown }> }\n" +
        "export async function adhocSend(t: T, text: string) {\n" +
        '  return t.send({ model: "anthropic/claude-opus-5.5", messages: [{ role: "system", content: "Ad hoc." }, { role: "user", content: text }], maxTokens: 512 })\n' +
        "}\n",
    },
    reports: ["FAIL: functions/src/p1/zzAuditAdhoc2.ts: imports activeTransport from functions/src/p1/transport"],
  },
  {
    name: "F34 R1-003 T4b (direct): ad-hoc send and transport import both under platform/p1",
    rel: "platform/p1/zzAuditAdhocDirect.ts",
    body:
      'import { activeTransport } from "@/functions/src/p1/transport"\n\n' +
      "export async function adhocSummary(text: string): Promise<string | undefined> {\n" +
      "  const gw = activeTransport()\n" +
      '  const reply = await gw?.send({ messages: [{ role: "system", content: "You are a helpful assistant. Summarise." }, { role: "user", content: text }], model: "anthropic/claude-opus-5.5", maxTokens: 512 })\n' +
      "  return reply?.text\n" +
      "}\n",
    reports: ["FAIL: platform/p1/zzAuditAdhocDirect.ts: imports activeTransport from functions/src/p1/transport"],
  },
  // PR #129 review, Codex P2 (thread 4368766679): a granted file binding the whole transport and handing a value on.
  {
    name: "F34 R1-003 Codex P2: the granted eval CLI imports the whole transport and re-exports activeTransport()",
    rel: "functions/src/cli/committeeEval.ts",
    body: 'import * as transport from "../p1/transport"\nconst t = transport.activeTransport()\nexport { t }\n',
    reports: [
      "FAIL: functions/src/cli/committeeEval.ts: imports all of functions/src/p1/transport",
      "FAIL: functions/src/cli/committeeEval.ts: granted export violation",
    ],
  },
];

describe("Gate G-0 end to end (FA-CI-001)", () => {
  let base = "";

  beforeAll(() => {
    base = buildBaseTree();
  }, GATE_TIMEOUT_MS);

  // Every case copies the whole base tree (functions/src included), so removing them all can outrun the 15 s default
  // hook timeout on a loaded runner; the cleanup gets the same allowance as a gate run.
  afterAll(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, GATE_TIMEOUT_MS);

  it(
    "control: the minimal tree with allowlisted and P1 uses passes G-0",
    () => {
      const result = runGate(caseTree(base));
      expect(result.out).toContain(
        "PASS: no unallowlisted Playwright/Puppeteer; FA-D3C-001 allowlist entries verified",
      );
      expect(result.out).toContain(
        "PASS: provider SDK imports confined to P1; FA-D3C-002 allowlist entries verified",
      );
      expect(result.out).toContain(
        "PASS: no AI SDK, provider SDK, provider key or provider host in the Next/eve runtime; no deploy surface binds a provider key",
      );
      // Audit F34 R1-003, check [21]: the real send sites and the eval CLI are copied in with functions/src.
      expect(result.out).toMatch(/PASS: P1 transports are imported only by their grants/);
      expect(result.out).toContain("=== Gate G-0 PASSED (static) ===");
      expect(result.status).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );

  it.each(PLANTED)(
    "planted violation fails G-0: $name",
    ({ rel, body, reports, extra }) => {
      const dir = caseTree(base);
      plant(dir, rel, body);
      for (const [extraRel, extraBody] of Object.entries(extra ?? {})) plant(dir, extraRel, extraBody);
      const result = runGate(dir);
      for (const report of reports) expect(result.out).toContain(report);
      expect(result.out).toContain("=== Gate G-0 FAILED ===");
      expect(result.status).toBe(1);
    },
    GATE_TIMEOUT_MS,
  );

  // PR #129 review, Codex P2 (thread 4368766681): G-0 runs check [21] on every change, so a literal dynamic import
  // written with a space, a line break or a comment inside the parenthesis must pass the whole gate.
  it(
    "a literal dynamic import written with whitespace or a comment passes G-0 (F34 R1-003, Codex P2)",
    () => {
      const dir = caseTree(base);
      plant(
        dir,
        "functions/src/p1/zzLazy.ts",
        'export const a = () => import( "./month")\nexport const b = () => import(\n  "./month"\n)\nexport const c = () => require( \'./month\' )\nexport const d = () => import(/* lazy */ "./month")\n',
      );
      const result = runGate(dir);
      expect(result.out).toMatch(/PASS: P1 transports are imported only by their grants/);
      expect(result.out).toContain("=== Gate G-0 PASSED (static) ===");
      expect(result.status).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );
});
