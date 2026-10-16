import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = process.cwd();

const SCRAPER = "ci_gates/check_scraper_libraries.py";
const PROVIDER = "ci_gates/check_provider_imports.py";

function copyGuardTree(targetDir: string) {
  const gates = path.join(targetDir, "ci_gates");
  fs.mkdirSync(gates, { recursive: true });
  for (const name of [
    "check_scraper_libraries.py",
    "check_provider_imports.py",
    "g0_guard_common.py",
  ]) {
    fs.copyFileSync(path.join(repoRoot, "ci_gates", name), path.join(gates, name));
  }
  writeAllowlist(targetDir, [], []);
}

function runGuard(script: string, cwd: string): { status: number; out: string } {
  try {
    const out = execSync(`python3 ${script}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// Every probe directory this file creates, removed after each test.
const tmpDirs: string[] = [];

function mkProbe(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g0-probe-"));
  try {
    copyGuardTree(dir);
  } catch (err) {
    // Re-audit 2026-10-16: a failed copy used to leak the directory.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  tmpDirs.push(dir);
  return dir;
}

function writeAllowlist(
  dir: string,
  scraper: string[],
  provider: string[],
): void {
  fs.writeFileSync(
    path.join(dir, "ci_gates", "g0_guard_allowlist.json"),
    JSON.stringify(
      { fa_d3c_001_scraper: scraper, fa_d3c_002_provider: provider },
      null,
      2,
    ),
  );
}

type Plant = { rel: string; body: string };

function plant(dir: string, files: Plant[]): void {
  for (const { rel, body } of files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

const PW_IMPORT = 'import { chromium } from "playwright"\nexport const browser = chromium\n';
const OPENAI_IMPORT = 'import OpenAI from "openai"\nexport const client = OpenAI\n';

/** A planted file that the named guard must report, with the exact report line it must print. */
type Violation = { name: string; script: string; files: Plant[]; report: string };

/** A planted file that the named guard must accept (exit 0). */
type Accepted = { name: string; script: string; files: Plant[] };

// Re-audit 2026-10-16 (FA-CI-001 FAIL 6/10): each of these escaped G-0 on main at b7e4023.
const REAUDIT_ESCAPES: Violation[] = [
  // Defect 1: ci_gates, _superseded and .eve were skipped at any depth, not only at the repo root.
  {
    name: "D1 playwright under app/ci_gates/ (skip-anywhere)",
    script: SCRAPER,
    files: [{ rel: "app/ci_gates/route.ts", body: PW_IMPORT }],
    report: "app/ci_gates/route.ts: playwright import",
  },
  {
    name: "D1 playwright under lib/_superseded/ (skip-anywhere)",
    script: SCRAPER,
    files: [{ rel: "lib/_superseded/x.ts", body: PW_IMPORT }],
    report: "lib/_superseded/x.ts: playwright import",
  },
  {
    name: "D1 playwright under functions/src/.eve/ (skip-anywhere)",
    script: SCRAPER,
    files: [{ rel: "functions/src/.eve/x.ts", body: PW_IMPORT }],
    report: "functions/src/.eve/x.ts: playwright import",
  },
  {
    name: "D1 openai under app/ci_gates/ (skip-anywhere)",
    script: PROVIDER,
    files: [{ rel: "app/ci_gates/route.ts", body: OPENAI_IMPORT }],
    report: "app/ci_gates/route.ts: provider SDK (openai)",
  },
  {
    name: "D1 openai under lib/_superseded/ (skip-anywhere)",
    script: PROVIDER,
    files: [{ rel: "lib/_superseded/x.ts", body: OPENAI_IMPORT }],
    report: "lib/_superseded/x.ts: provider SDK (openai)",
  },
  {
    name: "D1 openai under functions/src/.eve/ (skip-anywhere)",
    script: PROVIDER,
    files: [{ rel: "functions/src/.eve/x.ts", body: OPENAI_IMPORT }],
    report: "functions/src/.eve/x.ts: provider SDK (openai)",
  },
  // Defect 2: scraper imports written across lines or as re-exports.
  {
    name: "D2 multi-line import from playwright in lib/",
    script: SCRAPER,
    files: [{ rel: "lib/browser.ts", body: 'import {\n  chromium,\n} from "playwright"\n' }],
    report: "lib/browser.ts: playwright import",
  },
  {
    name: "D2 multi-line import from playwright in services/",
    script: SCRAPER,
    files: [{ rel: "services/d9/browser.ts", body: 'import {\n  chromium\n} from "playwright";\n' }],
    report: "services/d9/browser.ts: playwright import",
  },
  {
    name: "D2 re-export from playwright in lib/",
    script: SCRAPER,
    files: [{ rel: "lib/reexport.ts", body: 'export { chromium } from "playwright"\n' }],
    report: "lib/reexport.ts: playwright import",
  },
  {
    name: "D2 re-export from playwright in services/",
    script: SCRAPER,
    files: [{ rel: "services/reexport.ts", body: "export { chromium } from 'playwright';\n" }],
    report: "services/reexport.ts: playwright import",
  },
  {
    name: "D2 star re-export from puppeteer-core",
    script: SCRAPER,
    files: [{ rel: "services/pp.ts", body: 'export * from "puppeteer-core"\n' }],
    report: "services/pp.ts: puppeteer import",
  },
  {
    name: "D2 backtick dynamic import of playwright",
    script: SCRAPER,
    files: [{ rel: "lib/lazy.mjs", body: "export const load = () => import(`playwright`)\n" }],
    report: "lib/lazy.mjs: playwright import",
  },
  {
    name: "D2 multi-line type import from @playwright/test in app/",
    script: SCRAPER,
    files: [{ rel: "app/types.ts", body: 'import type {\n  Page,\n} from "@playwright/test"\nexport type P = Page\n' }],
    report: "app/types.ts: playwright import",
  },
  {
    name: "D2 Python importlib.import_module of playwright",
    script: SCRAPER,
    files: [{ rel: "services/py/lazy.py", body: 'import importlib\npw = importlib.import_module("playwright.sync_api")\n' }],
    report: "services/py/lazy.py: playwright import",
  },
  {
    name: "D2 Python pyppeteer (Puppeteer port)",
    script: SCRAPER,
    files: [{ rel: "services/py/browser.py", body: "from pyppeteer import launch\n" }],
    report: "services/py/browser.py: puppeteer import",
  },
  // Defect 3: provider SDK imports in Python from-form, subpaths and backtick dynamic import.
  {
    name: "D3 Python from openai import AsyncOpenAI",
    script: PROVIDER,
    files: [{ rel: "services/py/llm.py", body: "from openai import AsyncOpenAI\nclient = AsyncOpenAI()\n" }],
    report: "services/py/llm.py: provider SDK (openai)",
  },
  {
    name: "D3 Python from anthropic import AsyncAnthropic",
    script: PROVIDER,
    files: [{ rel: "services/py/claude.py", body: "from anthropic import AsyncAnthropic\nclient = AsyncAnthropic()\n" }],
    report: "services/py/claude.py: provider SDK (anthropic)",
  },
  {
    name: "D3 Python from openai.types submodule",
    script: PROVIDER,
    files: [{ rel: "corpus_service/scraper/vec.py", body: "from openai.types import Embedding\n" }],
    report: "corpus_service/scraper/vec.py: provider SDK (openai)",
  },
  {
    name: "D3 Python from google.cloud import vision",
    script: PROVIDER,
    files: [{ rel: "services/py/ocr.py", body: "from google.cloud import vision\nclient = vision.ImageAnnotatorClient()\n" }],
    report: "services/py/ocr.py: provider SDK (google.cloud.vision)",
  },
  {
    name: "D3 subpath import openai/client",
    script: PROVIDER,
    files: [{ rel: "lib/llm.ts", body: 'import { OpenAI } from "openai/client"\nexport const c = OpenAI\n' }],
    report: "lib/llm.ts: provider SDK (openai)",
  },
  {
    name: "D3 subpath require @anthropic-ai/sdk/resources",
    script: PROVIDER,
    files: [{ rel: "services/res.cjs", body: 'module.exports = require("@anthropic-ai/sdk/resources")\n' }],
    report: "services/res.cjs: provider SDK (@anthropic-ai/sdk)",
  },
  {
    name: "D3 backtick dynamic import of openai",
    script: PROVIDER,
    files: [{ rel: "lib/lazy.mts", body: "export const load = () => import(`openai`)\n" }],
    report: "lib/lazy.mts: provider SDK (openai)",
  },
  {
    name: "D3 dynamic import with a webpack magic comment",
    script: PROVIDER,
    files: [{ rel: "app/lazy.ts", body: 'export const load = () => import(/* webpackChunkName: "llm" */ "openai")\n' }],
    report: "app/lazy.ts: provider SDK (openai)",
  },
  {
    name: "D3 @google/genai (successor of the listed @google/generative-ai)",
    script: PROVIDER,
    files: [{ rel: "lib/gemini.ts", body: 'import { GoogleGenAI } from "@google/genai"\nexport const g = GoogleGenAI\n' }],
    report: "lib/gemini.ts: provider SDK (@google/genai)",
  },
  // Defect 4: dependency manifests, Dockerfile variants and shell scripts.
  {
    name: "D4 requirements extras openai[datalib]",
    script: PROVIDER,
    files: [{ rel: "services/py/requirements.txt", body: "openai[datalib]==1.0.0\n" }],
    report: "services/py/requirements.txt: requires openai",
  },
  {
    name: "D4 requirements environment marker openai; python_version",
    script: PROVIDER,
    files: [{ rel: "services/py/requirements.txt", body: 'openai; python_version >= "3.8"\n' }],
    report: "services/py/requirements.txt: requires openai",
  },
  {
    name: "D4 requirements PEP 503 name google_generativeai",
    script: PROVIDER,
    files: [{ rel: "services/py/requirements.txt", body: "google_generativeai==0.8.0\n" }],
    report: "services/py/requirements.txt: requires google-generativeai",
  },
  {
    name: "D4 requirements editable VCS line with #egg=openai",
    script: PROVIDER,
    files: [{ rel: "services/py/requirements.txt", body: "-e git+https://github.com/openai/openai-python.git#egg=openai\n" }],
    report: "services/py/requirements.txt: requires openai",
  },
  {
    name: "D4 requirements pytest-playwright plugin",
    script: SCRAPER,
    files: [{ rel: "services/py/requirements.txt", body: "pytest-playwright==0.5.0\n" }],
    report: "services/py/requirements.txt: requires pytest-playwright",
  },
  {
    name: "D4 invalid pyproject.toml fails closed (provider)",
    script: PROVIDER,
    files: [{ rel: "services/py/pyproject.toml", body: "[project\ndependencies = [\n" }],
    report: "services/py/pyproject.toml: cannot read manifest",
  },
  {
    name: "D4 invalid package.json fails closed (scraper)",
    script: SCRAPER,
    files: [{ rel: "services/pkg/package.json", body: '{ "dependencies": { "playwright": ' }],
    report: "services/pkg/package.json: cannot read manifest",
  },
  {
    name: "D4 requirements-test.txt is read (provider)",
    script: PROVIDER,
    files: [{ rel: "corpus_service/requirements-test.txt", body: "pytest==9.1.1\nopenai==1.0.0\n" }],
    report: "corpus_service/requirements-test.txt: requires openai",
  },
  {
    name: "D4 requirements-dev.txt is read (scraper)",
    script: SCRAPER,
    files: [{ rel: "services/py/requirements-dev.txt", body: "playwright==1.40.0\n" }],
    report: "services/py/requirements-dev.txt: requires playwright",
  },
  {
    name: "D4 requirements extras playwright[all]",
    script: SCRAPER,
    files: [{ rel: "services/py/requirements.txt", body: "playwright[all]>=1.40\n" }],
    report: "services/py/requirements.txt: requires playwright",
  },
  {
    name: "D4 pyproject.toml [project] dependencies (provider)",
    script: PROVIDER,
    files: [{ rel: "services/py/pyproject.toml", body: '[project]\nname = "x"\ndependencies = ["openai>=1"]\n' }],
    report: "services/py/pyproject.toml: requires openai",
  },
  {
    name: "D4 pyproject.toml optional-dependencies (scraper)",
    script: SCRAPER,
    files: [{ rel: "services/py/pyproject.toml", body: '[project]\nname = "x"\n[project.optional-dependencies]\nscrape = ["playwright"]\n' }],
    report: "services/py/pyproject.toml: requires playwright",
  },
  {
    name: "D4 Pipfile [packages] (provider)",
    script: PROVIDER,
    files: [{ rel: "services/py/Pipfile", body: '[packages]\nanthropic = "*"\n' }],
    report: "services/py/Pipfile: requires anthropic",
  },
  {
    name: "D4 Dockerfile.worker runs npx playwright install",
    script: SCRAPER,
    files: [{ rel: "services/worker/Dockerfile.worker", body: "FROM node:22\nRUN npx playwright install chromium\n" }],
    report: "services/worker/Dockerfile.worker: Playwright install",
  },
  {
    name: "D4 Dockerfile pip-installs playwright across a line continuation",
    script: SCRAPER,
    files: [{ rel: "services/worker/Dockerfile", body: "FROM python:3.12\nRUN pip install --no-cache-dir \\\n    playwright\n" }],
    report: "services/worker/Dockerfile: Playwright install",
  },
  {
    name: "D4 shell script runs npx playwright install",
    script: SCRAPER,
    files: [{ rel: "scripts/install-browsers.sh", body: "#!/usr/bin/env bash\nset -e\nnpx playwright install --with-deps chromium\n" }],
    report: "scripts/install-browsers.sh: Playwright install",
  },
  {
    name: "D4 extensionless shell script (shebang) runs playwright install",
    script: SCRAPER,
    files: [{ rel: "services/bin/bootstrap", body: "#!/bin/sh\npython -m playwright install chromium\n" }],
    report: "services/bin/bootstrap: Playwright install",
  },
  {
    name: "D4 package.json script runs playwright install",
    script: SCRAPER,
    files: [{ rel: "services/pkg/package.json", body: JSON.stringify({ scripts: { postinstall: "playwright install chromium" } }) }],
    report: "services/pkg/package.json: Playwright install",
  },
];

// The audit's own runtime probe (forensic audit v2, FA-CI-001): OpenAI + Playwright in these trees.
const AUDIT_PROBE_DIRS = ["app/api/probe/route.ts", "functions/src/probe.ts", "lib/probe.ts", "components/Probe.tsx"];

// Caught before this change; must stay caught.
const STAYS_CAUGHT: Violation[] = [
  ...AUDIT_PROBE_DIRS.flatMap((rel): Violation[] => [
    {
      name: `audit probe: playwright in ${rel}`,
      script: SCRAPER,
      files: [{ rel, body: `${OPENAI_IMPORT}${PW_IMPORT}` }],
      report: `${rel}: playwright import`,
    },
    {
      name: `audit probe: openai in ${rel}`,
      script: PROVIDER,
      files: [{ rel, body: `${OPENAI_IMPORT}${PW_IMPORT}` }],
      report: `${rel}: provider SDK (openai)`,
    },
  ]),
  {
    name: "audit probe: playwright in corpus_service (Python)",
    script: SCRAPER,
    files: [{ rel: "corpus_service/probe.py", body: "from openai import OpenAI\nfrom playwright.sync_api import sync_playwright\n" }],
    report: "corpus_service/probe.py: playwright import",
  },
  {
    name: "audit probe: openai in corpus_service (Python)",
    script: PROVIDER,
    files: [{ rel: "corpus_service/probe.py", body: "from openai import OpenAI\nfrom playwright.sync_api import sync_playwright\n" }],
    report: "corpus_service/probe.py: provider SDK (openai)",
  },
  {
    name: "openai dependency in functions/package.json",
    script: PROVIDER,
    files: [{ rel: "functions/package.json", body: JSON.stringify({ dependencies: { openai: "4.0.0" } }) }],
    report: "functions/package.json: dependencies lists openai",
  },
  {
    name: "playwright dependency in functions/package.json",
    script: SCRAPER,
    files: [{ rel: "functions/package.json", body: JSON.stringify({ dependencies: { playwright: "1.40.0" } }) }],
    report: "functions/package.json: dependencies lists playwright",
  },
  {
    name: "from playwright.async_api import",
    script: SCRAPER,
    files: [{ rel: "corpus_service/scraper/harvest.py", body: "from playwright.async_api import async_playwright\n" }],
    report: "corpus_service/scraper/harvest.py: playwright import",
  },
  {
    name: 'require("playwright-core")',
    script: SCRAPER,
    files: [{ rel: "lib/core.cjs", body: 'module.exports = require("playwright-core")\n' }],
    report: "lib/core.cjs: playwright import",
  },
  {
    name: "a nested tests/ directory is scanned (only the root tests/ is skipped)",
    script: SCRAPER,
    files: [{ rel: "services/tests/x.test.ts", body: PW_IMPORT }],
    report: "services/tests/x.test.ts: playwright import",
  },
  {
    name: 'side-effect import "puppeteer"',
    script: SCRAPER,
    files: [{ rel: "app/side.ts", body: 'import "puppeteer"\n' }],
    report: "app/side.ts: puppeteer import",
  },
  {
    name: "Python import openai inside a function body",
    script: PROVIDER,
    files: [{ rel: "corpus_service/scraper/tasks/emb.py", body: "def f():\n    import openai\n    return openai.AsyncOpenAI()\n" }],
    report: "corpus_service/scraper/tasks/emb.py: provider SDK (openai)",
  },
  {
    name: "Dockerfile runs playwright install",
    script: SCRAPER,
    files: [{ rel: "corpus_service/Dockerfile", body: "FROM python:3.12-slim\nRUN pip install -r requirements.txt && playwright install chromium --with-deps\n" }],
    report: "corpus_service/Dockerfile: Playwright install",
  },
  {
    name: "Dockerfile npm-installs puppeteer",
    script: SCRAPER,
    files: [{ rel: "services/worker/Dockerfile", body: "FROM node:22\nRUN npm install puppeteer\n" }],
    report: "services/worker/Dockerfile: Puppeteer",
  },
];

const STAYS_ACCEPTED: Accepted[] = [
  {
    name: "root ci_gates/ is still skipped",
    script: SCRAPER,
    files: [{ rel: "ci_gates/fixtures/probe.py", body: "from playwright.sync_api import sync_playwright\n" }],
  },
  {
    name: "root tests/ is still skipped (Playwright e2e specs)",
    script: SCRAPER,
    files: [{ rel: "tests/e2e/x.spec.ts", body: 'import { test } from "@playwright/test"\n' }],
  },
  {
    name: "root _superseded/ is still skipped (scraper)",
    script: SCRAPER,
    files: [{ rel: "_superseded/old.ts", body: PW_IMPORT }],
  },
  {
    name: "root _superseded/ is still skipped (provider)",
    script: PROVIDER,
    files: [{ rel: "_superseded/old.ts", body: OPENAI_IMPORT }],
  },
  {
    name: "root .eve/ is still skipped",
    script: PROVIDER,
    files: [{ rel: ".eve/cache/x.ts", body: OPENAI_IMPORT }],
  },
  {
    name: "node_modules is skipped at any depth (scraper)",
    script: SCRAPER,
    files: [{ rel: "lib/node_modules/playwright/index.js", body: 'module.exports = require("playwright-core")\n' }],
  },
  {
    name: "node_modules is skipped at any depth (provider)",
    script: PROVIDER,
    files: [{ rel: "functions/node_modules/openai/index.js", body: 'module.exports = require("openai/client")\n' }],
  },
  {
    name: ".next is skipped at any depth",
    script: PROVIDER,
    files: [{ rel: "app/.next/server/chunk.js", body: 'module.exports = require("openai")\n' }],
  },
  {
    name: ".git is skipped at any depth",
    script: SCRAPER,
    files: [{ rel: "lib/vendored/.git/hooks/x.mjs", body: PW_IMPORT }],
  },
  {
    name: "provider SDK under platform/p1/ (P1 gateway)",
    script: PROVIDER,
    files: [{ rel: "platform/p1/gateway.ts", body: OPENAI_IMPORT }],
  },
  {
    name: "provider SDK under platform/committeeBrain/",
    script: PROVIDER,
    files: [{ rel: "platform/committeeBrain/brain.ts", body: 'import Anthropic from "@anthropic-ai/sdk"\nexport const a = Anthropic\n' }],
  },
  {
    name: "provider SDK under functions/src/p1/",
    script: PROVIDER,
    files: [{ rel: "functions/src/p1/transport.ts", body: 'import { OpenAI } from "openai/client"\nexport const o = OpenAI\n' }],
  },
  {
    name: "shell script that runs the root Playwright e2e suite (not an install)",
    script: SCRAPER,
    files: [{ rel: "scripts/e2e.sh", body: '#!/usr/bin/env bash\nexport PLAYWRIGHT_BASE_URL="http://127.0.0.1:1"\nnpx playwright test tests/e2e/console-auth.spec.ts\n' }],
  },
  {
    name: "a Dockerfile comment that mentions playwright install",
    script: SCRAPER,
    files: [{ rel: "services/worker/Dockerfile", body: "FROM python:3.12\n# no playwright install here: the runtime image carries Chromium\nRUN pip install -r requirements.txt\n" }],
  },
  {
    name: "a relative module whose file name contains playwright",
    script: SCRAPER,
    files: [{ rel: "lib/uses-helper.ts", body: 'import { x } from "./playwright-helpers"\nexport const y = x\n' }],
  },
];

describe("G-0 full-tree scraper/provider guards (FA-CI-001)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mkProbe removes its temp directory when populating it fails", () => {
    const mkdtemp = vi.spyOn(fs, "mkdtempSync");
    vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw new Error("injected copy failure");
    });
    let created: string | undefined;
    try {
      expect(() => mkProbe()).toThrow("injected copy failure");
      expect(mkdtemp).toHaveBeenCalledTimes(1);
      created = mkdtemp.mock.results[0]?.value as string;
      expect(typeof created).toBe("string");
      expect(fs.existsSync(created)).toBe(false);
    } finally {
      if (created) fs.rmSync(created, { recursive: true, force: true });
    }
  });

  it.each(REAUDIT_ESCAPES)("re-audit escape is now caught: $name", ({ script, files, report }) => {
    const dir = mkProbe();
    plant(dir, files);
    const result = runGuard(script, dir);
    expect(result.out).toContain(report);
    expect(result.status).toBe(1);
  });

  it.each(STAYS_CAUGHT)("still caught: $name", ({ script, files, report }) => {
    const dir = mkProbe();
    plant(dir, files);
    const result = runGuard(script, dir);
    expect(result.out).toContain(report);
    expect(result.status).toBe(1);
  });

  it.each(STAYS_ACCEPTED)("still accepted: $name", ({ script, files }) => {
    const dir = mkProbe();
    plant(dir, files);
    const result = runGuard(script, dir);
    expect(result.out).toMatch(/^PASS:/m);
    expect(result.status).toBe(0);
  });

  it("detects Playwright import under app/", () => {
    const dir = mkProbe();
    const appApi = path.join(dir, "app", "api", "probe");
    fs.mkdirSync(appApi, { recursive: true });
    fs.writeFileSync(
      path.join(appApi, "route.ts"),
      'import { chromium } from "playwright"\nexport const GET = () => new Response("ok")\n',
    );
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/playwright/i);
  });

  it("detects require(playwright) in .mjs", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "lib", "scrape.mjs"),
      'const pw = require("playwright");\nexport default pw;\n',
    );
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
  });

  it("detects puppeteer in nested package.json devDependencies", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "services", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "services", "pkg", "package.json"),
      JSON.stringify({ devDependencies: { puppeteer: "1.0.0" } }),
    );
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/puppeteer/i);
  });

  it("allows root @playwright/test devDependency only", () => {
    const dir = mkProbe();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "1.64.0" } }),
    );
    fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'export default {}\n');
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).toBe(0);
  });

  it("does not skip functions/test/ for scraper imports", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "functions", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "functions", "test", "bad.test.ts"),
      'import puppeteer from "puppeteer"\n',
    );
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
  });

  it("fails new corpus_service violation not on FA-D3C-001 allowlist", () => {
    const dir = mkProbe();
    const rel = path.join(dir, "corpus_service", "scraper", "new_harvest.py");
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, 'from playwright.async_api import async_playwright\n');
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/new_harvest\.py/);
  });

  it("detects static OpenAI import under functions/src outside p1", () => {
    const dir = mkProbe();
    const fnDir = path.join(dir, "functions", "src", "probe");
    fs.mkdirSync(fnDir, { recursive: true });
    const forbiddenImport = ["import OpenAI from ", '"openai"', "\nexport const x = OpenAI\n"].join(
      "",
    );
    fs.writeFileSync(path.join(fnDir, "bad.ts"), forbiddenImport);
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/functions\/src\/probe\/bad\.ts/);
  });

  it("detects require(openai)", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "services"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "services", "bad.cjs"),
      'const o = require("openai");\nmodule.exports = o;\n',
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
  });

  it("detects dynamic import(openai)", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "lib", "dyn.mts"),
      'export async function load() { return await import("openai"); }\n',
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
  });

  it("detects export from openai", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "lib", "reexp.jsx"),
      'export { OpenAI } from "openai";\n',
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
  });

  it("detects openai in package.json dependencies", () => {
    const dir = mkProbe();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { openai: "4.0.0" } }),
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/package\.json/);
  });

  it("allows provider SDK under platform/p1/", () => {
    const dir = mkProbe();
    fs.mkdirSync(path.join(dir, "platform", "p1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "platform", "p1", "gateway.ts"),
      'import OpenAI from "openai"\nexport const client = OpenAI\n',
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).toBe(0);
  });

  it("passes on real repo allowlisted corpus_service files", () => {
    const scraper = runGuard("ci_gates/check_scraper_libraries.py", repoRoot);
    const provider = runGuard("ci_gates/check_provider_imports.py", repoRoot);
    expect(scraper.status).toBe(0);
    expect(provider.status).toBe(0);
  });

  it("fails when a second scraper package is added to an allowlisted requirements file", () => {
    const dir = mkProbe();
    writeAllowlist(
      dir,
      ["corpus_service/requirements.txt:playwright"],
      [],
    );
    const req = path.join(dir, "corpus_service", "requirements.txt");
    fs.mkdirSync(path.dirname(req), { recursive: true });
    fs.writeFileSync(req, "playwright\npuppeteer\n");
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/requires puppeteer/);
  });

  it("fails when a second provider package is added to an allowlisted requirements file", () => {
    const dir = mkProbe();
    writeAllowlist(dir, [], ["corpus_service/requirements.txt:openai"]);
    const req = path.join(dir, "corpus_service", "requirements.txt");
    fs.mkdirSync(path.dirname(req), { recursive: true });
    fs.writeFileSync(req, "openai\nanthropic\n");
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/requires anthropic/);
  });

  it("fails when embeddings.py allowlists openai but file also imports anthropic", () => {
    const dir = mkProbe();
    writeAllowlist(dir, [], ["corpus_service/scraper/tasks/embeddings.py:openai"]);
    const py = path.join(dir, "corpus_service", "scraper", "tasks", "embeddings.py");
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, "import openai\nimport anthropic\n");
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/anthropic/);
  });

  it("fails on stale scraper allowlist entry with no matching finding", () => {
    const dir = mkProbe();
    writeAllowlist(
      dir,
      [
        "corpus_service/requirements.txt:playwright",
        "corpus_service/requirements.txt:puppeteer",
      ],
      [],
    );
    const req = path.join(dir, "corpus_service", "requirements.txt");
    fs.mkdirSync(path.dirname(req), { recursive: true });
    fs.writeFileSync(req, "playwright\n");
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/stale allowlist entry.*puppeteer/);
  });

  it("fails on stale provider allowlist entry with no matching finding", () => {
    const dir = mkProbe();
    writeAllowlist(
      dir,
      [],
      [
        "corpus_service/requirements.txt:openai",
        "corpus_service/requirements.txt:anthropic",
      ],
    );
    const req = path.join(dir, "corpus_service", "requirements.txt");
    fs.mkdirSync(path.dirname(req), { recursive: true });
    fs.writeFileSync(req, "openai\n");
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/stale allowlist entry.*anthropic/);
  });
});
