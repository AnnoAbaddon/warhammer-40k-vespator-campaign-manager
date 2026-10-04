import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { SETUP_TOKEN, advanceTo } from './helpers';

const demo = () => JSON.parse(fs.readFileSync('.e2e/demo.json', 'utf8')) as { id: string; token: string };

async function login(page: Page) {
  await page.goto('/admin');
  if (page.url().includes('/setup-admin')) {
    await page.fill('#setupToken', SETUP_TOKEN);
    await page.fill('#username', 'warmaster');
    await page.fill('#password', 'e2e-passwort-123');
    await page.fill('#password2', 'e2e-passwort-123');
    await page.getByRole('button', { name: 'Spielleiter-Konto anlegen' }).click();
  } else if (page.url().includes('/login')) {
    await page.fill('#username', 'warmaster');
    await page.fill('#password', 'e2e-passwort-123');
    await page.getByRole('button', { name: 'Anmelden' }).click();
  }
  await page.waitForURL('**/admin');
}

/** Klickt einen Button und bestätigt eventuelle Warn-/Begründungs-/Würfeldialoge */
async function act(page: Page, name: string | RegExp) {
  await page
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .click();
  await settle(page);
}

async function settle(page: Page) {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const dlg = page.getByRole('dialog');
    if (!(await dlg.isVisible().catch(() => false))) {
      await page.waitForLoadState('networkidle');
      if (!(await dlg.isVisible().catch(() => false))) return;
    }
    const txt = (await dlg.textContent()) ?? '';
    if (txt.includes('Trotzdem fortfahren')) {
      // Begründung ist Pflicht (SPEC 14.1) – Dialoge ohne Begründungsfeld (Undo) haben kein Eingabefeld
      const reason = dlg.locator('input');
      if (await reason.count()) await reason.fill('E2E-Test');
      await dlg.getByRole('button', { name: 'Trotzdem fortfahren' }).click();
    } else if (await dlg.getByRole('button', { name: 'Bestätigen', exact: true }).count()) {
      // Rückfrage ohne Begründung (Hinweise, Undo, Kampagne beenden)
      await dlg.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    }
    else if (txt.includes('Begründung')) {
      await dlg.locator('input').fill('E2E-Test');
      await dlg.getByRole('button', { name: 'Übernehmen' }).click();
    } else if (txt.includes('Wurf eintragen'))
      await dlg
        .getByRole('button', { name: String((i % 6) + 1) })
        .first()
        .click();
  }
}

/** Wartet, bis die Stufenanzeige den Text zeigt (Aktualisierung nach router.refresh) */
async function expectStage(page: Page, text: string) {
  await expect(page.locator('[data-stage]:visible').first()).toContainText(text);
}

test.describe.serial('Kampagne', () => {
  test('Ersteinrichtung und Login', async ({ page }) => {
    // Beim allerersten Aufruf leitet /admin zur Ersteinrichtung (sofern noch kein anderer Test das Konto angelegt hat)
    await page.goto('/admin');
    await expect(page).toHaveURL(/setup-admin|login/);
    await login(page);
    await expect(page.getByRole('heading', { name: /^Kampagnen/ })).toBeVisible();
    await expect(page.getByText('Demo: Krieg an der Vespator-Front')).toBeVisible();
  });

  test('öffentliche Ansicht verbirgt Operationen vor dem Reveal', async ({ page, request }) => {
    const { token } = demo();
    const res = await request.get(`/v/${token}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    const html = await res.text();
    // Operationsdetails (Ziele, Attack Types) dürfen vor dem Reveal nicht ausgeliefert werden
    expect(html).not.toContain('targetPlanetId');
    expect(html).not.toContain('killTeamPlanetId');
    expect(html).not.toContain('destinationPlanetId');
    expect((await request.get('/v/ungueltiger-token-1234567890abcdef')).status()).toBe(404);
    await page.goto(`/v/${token}`);
    await expect(page.getByText('Die Front erwacht').first()).toBeVisible();
    const png = await request.get(`/v/${token}/map.png`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toContain('image/png');
  });

  test('Phase 1 komplett durchspielen', async ({ page }) => {
    const { id } = demo();
    await login(page);
    await page.goto(`/admin/c/${id}`);
    await expectStage(page, 'Operationen wählen');

    await advanceTo(page, 'Reveal');
    await act(page, 'Operationen aufdecken');
    await advanceTo(page, 'Edifice Raising');
    await act(page, 'Bauen ausführen');
    await advanceTo(page, 'Schlachten laufen');

    // Ergebnis für Purge and Burn eintragen
    // die Übersicht „Handlungsbedarf“ zeigt dieselbe Schlacht – den Eintrag der Schlachtenliste öffnen
    await page.locator('button[aria-expanded]').filter({ hasText: /Purge and Burn · Norallus/ }).first().click();
    await page.getByLabel('Gespielt am').fill('2026-10-01T18:00');
    await page.getByLabel('VP Angreifer').fill('72');
    await page.getByLabel('VP Verteidiger').fill('55');
    await page.getByRole('button', { name: 'Schlacht speichern' }).click();
    await settle(page);
    // Seize Power Base verfällt
    const seize = page
      .locator('div')
      .filter({ has: page.getByText('Seize Power Base · Caltus Novem', { exact: false }) })
      .getByLabel('Ungespielt werten')
      .last();
    await seize.selectOption('VOID');
    await settle(page);

    await advanceTo(page, 'Ergebnisse verarbeiten');
    await act(page, 'Alle verarbeiten');
    await advanceTo(page, 'Fleet Arrival');
    await act(page, 'Void Leaps ausführen');
    await act(page, /^Weiter/);
    await act(page, 'Kill Teams auswerten');
    await advanceTo(page, 'Punkte & Events');
    await act(page, 'Punkte berechnen');
    await act(page, 'Events generieren');
    for (let i = 0; i < 5; i++) {
      const discard = page.getByRole('button', { name: 'Verwerfen (Override)' });
      if (!(await discard.count())) break;
      await discard.first().click();
      await settle(page);
    }
    await advanceTo(page, 'Flotten bewegen');
    await act(page, 'Bewegungen ausführen');
    await advanceTo(page, 'Infrastruktur bauen');
    await act(page, 'Reihenfolge bestimmen');
    for (let i = 0; i < 3; i++) await act(page, 'Verzichten');
    await act(page, /Weiter/);
    await expectStage(page, 'Phase 2/5 · Operationen wählen');
  });

  test('Undo nimmt die letzte Aktion zurück', async ({ page }) => {
    const { id } = demo();
    await login(page);
    await page.goto(`/admin/c/${id}`);
    const { token } = demo();
    expect(await (await page.request.get(`/v/${token}?phase=1`)).text()).toContain('Archivansicht: Ende von Phase 1');
    await act(page, 'Rückgängig');
    await expectStage(page, 'Phase 1/5 · Infrastruktur bauen');
    // nach dem Undo des Phasenwechsels gibt es kein Archiv für Phase 1 mehr
    expect(await (await page.request.get(`/v/${token}?phase=1`)).text()).not.toContain('Archivansicht');
    await act(page, /Weiter/);
    await expectStage(page, 'Phase 2/5 · Operationen wählen');
  });

  test('Leseansicht nach Phase 1 und Statistik', async ({ page }) => {
    const { token } = demo();
    await page.goto(`/v/${token}`);
    // abgeschlossene Schlachten stehen in der Chronik der rechten Spalte
    await page.getByRole('tab', { name: 'Chronik' }).click();
    await expect(page.getByText('Purge and Burn').filter({ visible: true }).first()).toBeVisible();
    const archive = await (await page.request.get(`/v/${token}?phase=1`)).text();
    expect(archive).toContain('Archivansicht: Ende von Phase 1');
    expect(archive).toContain('Purge and Burn');
    await page.goto(`/v/${token}/stats`);
    await expect(page.getByText('Punkteverlauf')).toBeVisible();
    await expect(page.getByText('Konrad').first()).toBeVisible();
  });

  test('Export und Import', async ({ page }) => {
    const { id } = demo();
    await login(page);
    const res = await page.request.get(`/api/c/${id}/export`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.state.meta.name).toContain('Demo');
    fs.writeFileSync('.e2e/backup.json', JSON.stringify(json));
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Backup importieren' }).click();
    await page.locator('form').filter({ hasText: 'Importieren' }).locator('input[type=file]').setInputFiles('.e2e/backup.json');
    await page.locator('form').filter({ hasText: 'Importieren' }).locator('input[name=name]').fill('Import-Test');
    await page.getByRole('button', { name: 'Importieren' }).click();
    await page.waitForURL(/\/admin\/c\//);
    await expect(page.getByRole('heading', { name: 'Import-Test' })).toBeVisible();
    // Komplett-Backup als ZIP exportieren und wieder importieren
    const zip = await page.request.get(`/api/c/${id}/export?zip=1`);
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toContain('application/zip');
    fs.writeFileSync('.e2e/backup.zip', await zip.body());
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Backup importieren' }).click();
    await page.locator('form').filter({ hasText: 'Importieren' }).locator('input[type=file]').setInputFiles('.e2e/backup.zip');
    await page.locator('form').filter({ hasText: 'Importieren' }).locator('input[name=name]').fill('ZIP-Import');
    await page.getByRole('button', { name: 'Importieren' }).click();
    await page.waitForURL(/\/admin\/c\//);
    await expect(page.getByRole('heading', { name: 'ZIP-Import' })).toBeVisible();
    // Fehlerhaftes ZIP (kaputtes uploads.json) legt keine halbe Kampagne an
    const { zipSync, strToU8, unzipSync } = await import('fflate');
    const good = unzipSync(new Uint8Array(fs.readFileSync('.e2e/backup.zip')));
    const bad = zipSync({ 'backup.json': good['backup.json'], 'uploads.json': strToU8('{kaputt') });
    await page.goto('/admin');
    const before = await page.locator('h2').count();
    const r = await page.request.post('/api/import?name=Kaputt', { data: Buffer.from(bad), headers: { 'content-type': 'application/zip' } });
    expect(r.status()).toBe(400);
    await page.reload();
    expect(await page.locator('h2').count()).toBe(before);
    await expect(page.getByText('Kaputt', { exact: true })).toHaveCount(0);
    // nicht angemeldet: kein Export
    const anon = await page.context().browser()!.newContext();
    expect((await anon.request.get(`http://localhost:3200/api/c/${id}/export`)).status()).toBe(401);
    expect((await anon.request.post('http://localhost:3200/api/import', { data: '{}' })).status()).toBe(401);
    await anon.close();
  });

  test('mobile Ansicht: Schlacht erfassen', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const { id } = demo();
    await login(page);
    await page.goto(`/admin/c/${id}`);
    // Mobil: Navigation über die Leiste unten
    await page
      .getByRole('navigation', { name: 'Kampagne (mobil)' })
      .getByRole('button', { name: /Schlachten/ })
      .click();
    await page.locator('button[aria-expanded]').filter({ hasText: /Purge and Burn · Norallus/ }).first().click();
    await expect(page.getByLabel('VP Angreifer')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await ctx.close();
  });
});
