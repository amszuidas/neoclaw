import { expect, test } from '@playwright/test';

test('desktop sidebar navigation responds and updates content', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('dashboard-sidebar')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NeoClaw' })).toBeVisible();

  await page.getByText('概览', { exact: true }).click();
  await expect(page.locator('h2', { hasText: '概览' })).toBeVisible();
  await expect(page.getByText('页面正在开发中，已成功响应侧边栏点击。')).toBeVisible();
});
