import { devices, expect, test } from '@playwright/test';

test.use({ ...devices['Pixel 7'] });

test('mobile uses menu drawer and defaults to chat page', async ({ page }) => {
  await page.goto('/');

  const sidebar = page.getByTestId('dashboard-sidebar');
  await expect(sidebar).toHaveClass(/-translate-x-full/);
  await expect(page.getByRole('heading', { name: 'NeoClaw' })).toBeVisible();

  await page.getByTestId('mobile-menu-button').click();
  await expect(sidebar).toHaveClass(/translate-x-0/);

  await page.getByText('概览', { exact: true }).click();
  await expect(page.locator('h2', { hasText: '概览' })).toBeVisible();
  await expect(sidebar).toHaveClass(/-translate-x-full/);
});
