import { expect, test, type Page } from '@playwright/test';
import { act, exportState, expectStage, login, fillUntilEnabled } from './helpers';

const ALLIANCES = ['Rot', 'Blau', 'Grün'] as const;
const PLAYERS: [string, string, (typeof ALLIANCES)[number]][] = [
  ['Anna', 'Orks', 'Rot'],
  ['Ben', 'Necrons', 'Blau'],
  ['Cleo', 'Tau Empire', 'Grün'],
];
/** Planetennamen → PL-Wahl je Allianz (1× SH, 3× 3, 4× 2) */
const LEVELS: Record<(typeof ALLIANCES)[number], { sh: string; pl3: string[]; pl2: string[] }> = {
  Rot: { sh: 'Norallus', pl3: ['Masnet', 'Karabas', 'Kryndaer'], pl2: ['Felgris Secundas', 'Caltus Novem', 'Marvinius', 'Vikus Decima'] },
  Blau: { sh: 'Jawardet', pl3: ['Tarkad Vindix', 'Astarthem', 'Ikaron Prime'], pl2: ['Novamagnor', 'Felgris Secundas', 'Masnet', 'Vikus Decima'] },
  Grün: { sh: 'Caltus Novem', pl3: ['Vikus Decima', 'Marvinius', 'Novamagnor'], pl2: ['Kryndaer', 'Karabas', 'Ikaron Prime', 'Astarthem'] },
};
/** Start-Infrastruktur: [Typ-Wert, Planet-ID] */
const INFRA: Record<(typeof ALLIANCES)[number], [string, string][]> = {
  Rot: [
    ['FORTIFICATION_LINE', 'masnet'],
    ['SUPPORT_FACILITY', 'karabas'],
    ['STAGING_GROUNDS', 'kryndaer'],
  ],
  Blau: [
    ['FORTIFICATION_LINE', 'tarkad-vindix'],
    ['SUPPORT_FACILITY', 'astarthem'],
    ['STAGING_GROUNDS', 'ikaron-prime'],
  ],
  Grün: [
    ['FORTIFICATION_LINE', 'marvinius'],
    ['SUPPORT_FACILITY', 'vikus-decima'],
    ['STAGING_GROUNDS', 'novamagnor'],
  ],
};
const STARTS: Record<string, string> = { 'Rot Flotte I': 'kryndaer', 'Blau Flotte I': 'novamagnor', 'Grün Flotte I': 'caltus-novem' };

const panelWith = (page: Page, button: string) => page.locator('section.hud:not(.frame)').filter({ has: page.getByRole('button', { name: button, exact: true }) });

test('Setup-Wizard komplett über die Oberfläche (3 Allianzen, 2 Phasen)', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.fill('input[name=name]', 'E2E Setup-Wizard');
  await page.locator('select[name=allianceCount]').selectOption('3');
  await page.fill('input[name=phaseCount]', '2');
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
  await page.waitForURL(/\/admin\/c\//);
  const id = page.url().split('/c/')[1];
  await expectStage(page, 'Setup · Allianzen & Spieler');

  // ── W0: Allianzen, Spieler, Flotten ──
  for (const name of ALLIANCES) {
    const form = page.locator('section.hud:not(.frame)').filter({ hasText: 'Neue Allianz' });
    await fillUntilEnabled(form.locator('input').first(), name, form.getByRole('button', { name: 'Allianz anlegen', exact: true }));
    await act(page, 'Allianz anlegen', form);
  }
  for (const [nick, faction, al] of PLAYERS) {
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: '+ Spieler' }) });
    await form.locator('input').nth(0).fill(nick);
    await form.locator('input').nth(1).fill(faction);
    await form.locator('select').selectOption({ label: al });
    await act(page, '+ Spieler', form);
  }
  const fleetPanel = page.locator('section.hud:not(.frame)').filter({ hasText: 'Flotten je Allianz' });
  for (let i = 0; i < 3; i++) {
    await fleetPanel.getByLabel('Flottenzahl').nth(i).fill('1');
    await fleetPanel.getByRole('button', { name: 'Flotten setzen' }).nth(i).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
  }
  await act(page, 'Weiter');
  await expectStage(page, 'Setup · Strongholds & Power Level');

  // ── W2: Strongholds & Start-Power-Level ──
  for (const al of ALLIANCES) {
    await page.getByRole('tab', { name: new RegExp(`^${al}`) }).click();
    const lv = LEVELS[al];
    const pick = async (planet: string, level: string) =>
      page
        .getByRole('radiogroup', { name: `PL ${planet}` })
        .getByRole('radio', { name: level, exact: true })
        .click();
    await pick(lv.sh, 'SH');
    for (const p of lv.pl3) await pick(p, '3');
    for (const p of lv.pl2) await pick(p, '2');
    await act(page, 'Speichern (verdeckt)');
    await expect(page.getByRole('tab', { name: new RegExp(`^${al}.*erledigt`) })).toBeVisible();
  }
  await act(page, 'Aufdecken');
  await expect(page.getByText('W2 · Aufgedeckt')).toBeVisible();
  await act(page, 'Weiter');
  await expectStage(page, 'Setup · Start-Infrastruktur');

  // ── W3: Start-Infrastruktur ──
  for (const al of ALLIANCES) {
    await page.getByRole('tab', { name: new RegExp(`^${al}`) }).click();
    const panel = panelWith(page, 'Speichern (verdeckt)');
    const selects = panel.locator('select');
    for (const [k, [type, planet]] of INFRA[al].entries()) {
      await selects.nth(k * 2).selectOption(type);
      await selects.nth(k * 2 + 1).selectOption(planet);
    }
    await act(page, 'Speichern (verdeckt)', panel);
    await expect(page.getByRole('tab', { name: new RegExp(`^${al}.*erledigt`) })).toBeVisible();
  }
  await act(page, 'Aufdecken');
  await expect(page.getByText('W3 · Start-Infrastruktur aufgedeckt')).toBeVisible();
  await act(page, 'Weiter');
  await expectStage(page, 'Setup · Flotten-Startpositionen');

  // ── W4: Flotten-Startpositionen ──
  for (const [fleet, planet] of Object.entries(STARTS)) {
    const select = page.locator('div.flex').filter({ has: page.getByText(fleet, { exact: true }) }).last().locator('select');
    // unter Last kann die Auswahl vor dem Laden der Optionen verpuffen – bis der Wert wirklich steht wiederholen
    await expect(async () => {
      await select.selectOption(planet);
      await expect(select).toHaveValue(planet, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  }
  await expect(page.getByRole('button', { name: 'Speichern (verdeckt)', exact: true }).first()).toBeEnabled();
  await act(page, 'Speichern (verdeckt)');
  await expect(page.getByRole('button', { name: 'Aufdecken', exact: true }).first()).toBeEnabled({ timeout: 30_000 });
  await act(page, 'Aufdecken');
  await expect(page.getByText('W4 · Flotten aufgedeckt')).toBeVisible();
  await act(page, 'Weiter');
  await expectStage(page, 'Setup · Start vorbereiten');

  // ── W5: Start ──
  await act(page, 'Kampagne starten');
  await expectStage(page, 'Phase 1/2 · Operationen wählen');

  const s = await exportState(page, id);
  expect(s.stage).toEqual({ kind: 'PHASE', phase: 1, step: 'OPS' });
  const rot = s.alliances.find((a) => a.name === 'Rot')!.id;
  expect(s.planets.find((p) => p.id === 'norallus')!.power[rot]).toBe(4);
  expect(s.planets.find((p) => p.id === 'masnet')!.power[rot]).toBe(3);
  expect(s.fleets.map((f) => f.planetId).sort()).toEqual(['caltus-novem', 'kryndaer', 'novamagnor']);
});
