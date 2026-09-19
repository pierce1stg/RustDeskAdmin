import { expect, test } from '@playwright/test'

// Panel smoke against a live stand. Requires:
//   RDA_BASE_URL=https://panel.example.com RDA_USER=admin RDA_PASS=... npx playwright test
// Browsers are NOT installed by default: `npx playwright install chromium`.
// The test only asserts panel login + devices render — it never drives a
// live remote session (see docs/manual-checklist.md for that).
test('panel login + devices render', async ({ page }) => {
  const base = process.env.RDA_BASE_URL ?? 'https://panel.example.com'
  await page.goto(`${base}/login`)
  await page.getByPlaceholder('admin').fill(process.env.RDA_USER ?? 'admin')
  await page.locator('#password').fill(process.env.RDA_PASS ?? 'admin')
  await page.getByRole('button', { name: /sign in|войти/i }).click()
  await page.waitForURL(/\/devices|\/$/, { timeout: 15000 })
  await expect(page.getByText(/устройства|devices/i).first()).toBeVisible({ timeout: 10000 })
})
