import { expect, test } from "@playwright/test"

test("foundation console: sign in and normalise sends Authorization Bearer", async ({ page }) => {
  const email = process.env.E2E_CONSOLE_EMAIL
  const password = process.env.E2E_CONSOLE_PASSWORD
  if (!email || !password) {
    throw new Error("E2E_CONSOLE_EMAIL and E2E_CONSOLE_PASSWORD must be set (see scripts/e2e-console-auth.sh)")
  }

  await page.goto("/")
  await page.getByPlaceholder("email").fill(email)
  await page.getByPlaceholder("password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Signed in")).toBeVisible()

  await page.getByRole("tab", { name: "Courts" }).click()

  const requestPromise = page.waitForRequest(
    (req) => req.url().includes("/api/g0/normalise") && req.method() === "POST"
  )
  const responsePromise = page.waitForResponse((res) => res.url().includes("/api/g0/normalise"))

  await page.getByRole("button", { name: "Normalise" }).click()

  const request = await requestPromise
  const authHeader = request.headers().authorization ?? ""
  expect(authHeader).toMatch(/^Bearer \S+/)

  const response = await responsePromise
  expect(response.status()).toBe(200)
  const json = (await response.json()) as { result?: { status?: string; canonical?: string } }
  expect(json.result?.status).toBeTruthy()
  await expect(page.getByText(json.result!.canonical!).first()).toBeVisible({ timeout: 15_000 })
})
