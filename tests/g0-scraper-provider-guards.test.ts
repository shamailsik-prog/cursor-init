import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();

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

describe("G-0 full-tree scraper/provider guards (FA-CI-001)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Playwright import under app/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g0-probe-"));
    tmpDirs.push(dir);
    const appApi = path.join(dir, "app", "api", "probe");
    fs.mkdirSync(appApi, { recursive: true });
    fs.writeFileSync(
      path.join(appApi, "route.ts"),
      'import { chromium } from "playwright"\nexport const GET = () => new Response("ok")\n',
    );
    fs.mkdirSync(path.join(dir, "ci_gates"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "ci_gates/check_scraper_libraries.py"),
      path.join(dir, "ci_gates/check_scraper_libraries.py"),
    );
    const result = runGuard("ci_gates/check_scraper_libraries.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/playwright/i);
  });

  it("detects OpenAI import under functions/src outside p1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g0-probe-"));
    tmpDirs.push(dir);
    const fnDir = path.join(dir, "functions", "src", "probe");
    fs.mkdirSync(fnDir, { recursive: true });
    const forbiddenImport = ["import OpenAI from ", '"openai"', "\nexport const x = OpenAI\n"].join(
      "",
    );
    fs.writeFileSync(path.join(fnDir, "bad.ts"), forbiddenImport);
    fs.mkdirSync(path.join(dir, "ci_gates"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "ci_gates/check_provider_imports.py"),
      path.join(dir, "ci_gates/check_provider_imports.py"),
    );
    const result = runGuard("ci_gates/check_provider_imports.py", dir);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/functions\/src\/probe\/bad\.ts/);
  });
});
