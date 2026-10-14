import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();

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

function mkProbe(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g0-probe-"));
  copyGuardTree(dir);
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

describe("G-0 full-tree scraper/provider guards (FA-CI-001)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Playwright import under app/", () => {
    const dir = mkProbe();
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
    const rel = path.join(dir, "corpus_service", "scraper", "new_harvest.py");
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, 'from playwright.async_api import async_playwright\n');
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/new_harvest\.py/);
  });

  it("detects static OpenAI import under functions/src outside p1", () => {
    const dir = mkProbe();
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
    tmpDirs.push(dir);
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
