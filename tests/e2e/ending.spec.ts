import { expect, test } from '@playwright/test';
import { act, exportState, expectStage, login, scenarios, settle, fillUntilEnabled } from './helpers';

test.describe.serial('Kampagnenende und Folgekampagne', () => {
  test('Gleichstand → Entscheidungsschlacht → Sieger und Medaillen', async ({ page }) => {
    const { ending } = scenarios();
    await login(page);
    await page.goto(`/admin/c/${ending.id}`);
    await expectStage(page, 'Phase 1/1 · Punkte & Events');
    await act(page, 'Kampagne beenden');
    await expectStage(page, 'Entscheidungsschlacht');

    // Entscheidungsschlacht Imperium vs. Chaos ansetzen und erfassen
    await act(page, 'Ansetzen');
    await page
      .getByRole('button', { name: /Entscheidungsschlacht/ })
      .first()
      .click();
    await page.getByLabel('VP Angreifer').fill('80');
    await page.getByLabel('VP Verteidiger').fill('61');
    await act(page, 'Schlacht speichern');
    await act(page, 'Imperium gewinnt');
    await expectStage(page, 'Kampagne beendet');

    const s = await exportState(page, ending.id);
    const imp = s.alliances.find((a) => a.name === 'Imperium')!.id;
    expect(s.result?.winnerAllianceId).toBe(imp);
    expect(s.result?.tiebreak).toBe('FINAL_BATTLE');
    expect(s.medals.find((m) => m.medal === 'LAUREL')?.allianceId).toBe(imp);
    await expect(page.locator('b').filter({ hasText: 'Laurel of Victory' }).first()).toBeVisible();
  });

  test('Folgekampagne übernimmt Spieler und ordnet Medaillen nach Regel zu', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.fill('input[name=name]', 'E2E Folgekampagne');
    await page.locator('select[name=previous]').selectOption({ label: 'E2E Finale' });
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await page.waitForURL(/\/admin\/c\//);
    const id = page.url().split('/c/')[1];

    // Allianzen anlegen
    for (const name of ['Imperium II', 'Chaos II', 'Xenos II']) {
      const form = page.locator('section.hud:not(.frame)').filter({ hasText: 'Neue Allianz' });
      await fillUntilEnabled(form.locator('input').first(), name, form.getByRole('button', { name: 'Allianz anlegen', exact: true }));
      await act(page, 'Allianz anlegen', form);
    }
    // übernommene Spieler zuordnen (Tab „Allianzen & Spieler“ → Spieler bearbeiten)
    await page.getByRole('tab', { name: 'Allianzen & Spieler' }).click();
    for (const [nick, al] of [
      ['Konrad', 'Imperium II'],
      ['Dario', 'Chaos II'],
      ['Ayla', 'Xenos II'],
    ] as const) {
      await page.getByRole('row').filter({ hasText: nick }).getByRole('button', { name: 'Bearbeiten' }).click();
      const editor = page.locator('section.hud:not(.frame)').filter({ hasText: `Spieler bearbeiten: ${nick}` });
      await editor.getByLabel('Allianz').selectOption({ label: al });
      await act(page, 'Speichern', editor);
    }
    await page.getByRole('tab', { name: 'Cockpit' }).click();
    const fleetPanel = page.locator('section.hud:not(.frame)').filter({ hasText: 'Flotten je Allianz' });
    for (let i = 0; i < 3; i++) {
      await fleetPanel.getByLabel('Flottenzahl').nth(i).fill('1');
      await fleetPanel.getByRole('button', { name: 'Flotten setzen' }).nth(i).click();
      await settle(page);
    }
    await act(page, 'Weiter');
    await expectStage(page, 'Setup · Medaillen zuordnen');

    await act(page, 'Vorschlag nach Regel');
    const s = await exportState(page, id);
    expect(s.inheritedMedals.length).toBeGreaterThanOrEqual(1);
    for (const m of s.inheritedMedals) expect(m.assignedAllianceId).toBeTruthy();
    const konradAlliance = s.alliances.find((a) => a.name === 'Imperium II')!.id;
    expect(s.inheritedMedals.find((m) => m.medal === 'LAUREL')?.assignedAllianceId).toBe(konradAlliance);
  });
});
