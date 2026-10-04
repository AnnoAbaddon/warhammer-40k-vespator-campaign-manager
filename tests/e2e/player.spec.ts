import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { login, settle } from './helpers';

const demo = () => JSON.parse(fs.readFileSync('.e2e/demo.json', 'utf8')) as { id: string; token: string };

test('Spielerlink: Befehl erteilen, Allianz-Notiz, Autor im Log', async ({ page, browser }) => {
  const { id } = demo();
  await login(page);
  await page.goto(`/admin/c/${id}`);

  // Kommandant setzen (Cockpit, Befehlsphase)
  const commander = page.getByLabel('Kommandant').first();
  await commander.selectOption({ label: 'Konrad' });
  await settle(page);

  // Link erzeugen
  await page.getByRole('tab', { name: 'Allianzen & Spieler' }).click();
  await page.getByRole('tab', { name: 'Spieler', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'Konrad' }).getByRole('button', { name: 'Bearbeiten' }).click();
  await page.getByRole('button', { name: 'Link erzeugen' }).click();
  await settle(page);
  // der Link erscheint erst nach der Server-Antwort – warten, bis ein Feld ihn enthält
  let link: string | undefined;
  await expect
    .poll(async () => (link = await page.locator('input[readonly]').evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value).find((v) => v.includes('/p/')))), { timeout: 30_000 })
    .toBeTruthy();
  const url = new URL(link!);

  // Spielerseite ohne Anmeldung
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(url.pathname);
  await expect(p.getByText('Konrad').first()).toBeVisible();
  await expect(p.getByText(/Befehl für .*Flotte I/)).toBeVisible();
  const box = p.locator('section').filter({ hasText: /Befehl für .*Flotte I/ }).first();
  // ein bereits erteilter Befehl steht vorn; das Formular öffnet sich dann erst über „Ändern“
  const change = box.getByRole('button', { name: 'Ändern', exact: true });
  const editing = (await change.count()) > 0;
  if (editing) await change.first().click();
  await box.getByLabel('Operation').first().selectOption('LOGISTICAL_AUXILIA');
  await box.getByRole('button', { name: editing ? 'Änderung speichern' : 'Befehl erteilen (verdeckt)' }).first().click();
  await expect(box.getByText('Logistical Auxilia').first()).toBeVisible();

  // Allianz-Notiz
  await p.getByRole('tab', { name: 'Allianz' }).click();
  await p.getByLabel('Neue Notiz').fill('Sammelt euch bei Kryndaer');
  await p.getByRole('button', { name: 'Posten' }).click();
  await expect(p.getByText('Sammelt euch bei Kryndaer')).toBeVisible();

  // SL-Aktionen sind gesperrt: ungültiger Link → 404
  const bad = await p.request.get('/p/ungueltig-ungueltig-ungueltig-ungueltig-1234');
  expect(bad.status()).toBe(404);
  await ctx.close();

  // Log zeigt den Urheber
  await page.goto(`/admin/c/${id}`);
  await page.getByRole('tab', { name: 'Log & Würfel' }).click();
  await expect(page.getByText(/Spieler: Konrad/).first()).toBeVisible();
});
