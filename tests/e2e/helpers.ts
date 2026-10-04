import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';

export const USER = 'warmaster';
export const PASS = 'e2e-passwort-123';
/** Einmal-Token der Ersteinrichtung – setzt scripts/e2e-server.mjs als SETUP_TOKEN */
export const SETUP_TOKEN = 'e2e-setup-token-0123456789';

export type Scenario = { id: string; token: string };
export const scenarios = () => JSON.parse(fs.readFileSync('.e2e/scenarios.json', 'utf8')) as Record<'xeno' | 'fate' | 'bargain' | 'ending', Scenario>;

/** Meldet an; legt das Konto an, falls es noch keins gibt */
export async function login(page: Page) {
  await page.goto('/admin');
  if (page.url().includes('/setup-admin')) {
    // Standardsprache ausdrücklich Deutsch: die Suite erwartet eine deutsche Oberfläche, unabhängig von der
    // Build-Standardsprache (NEXT_PUBLIC_DEFAULT_LOCALE, ohne Angabe Englisch)
    const de = page.locator('input[name=locale][value=de]');
    if (!(await de.isChecked())) {
      await page.getByText('Deutsch', { exact: true }).click();
      await expect(de).toBeChecked();
    }
    await page.fill('#setupToken', SETUP_TOKEN);
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.fill('#password2', PASS);
    await page.getByRole('button', { name: 'Spielleiter-Konto anlegen' }).click();
  } else if (page.url().includes('/login')) {
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.getByRole('button', { name: 'Anmelden' }).click();
  }
  await page.waitForURL('**/admin');
}

/** Wartet auf das Ende einer Aktion und bestätigt dabei Warn-, Begründungs- und Würfeldialoge */
export async function settle(page: Page) {
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
    } else if (txt.includes('Begründung')) {
      await dlg.locator('input').fill('E2E-Test');
      await dlg.getByRole('button', { name: 'Übernehmen' }).click();
    } else if (txt.includes('Wurf eintragen'))
      await dlg
        .getByRole('button', { name: String((i % 6) + 1) })
        .first()
        .click();
  }
  // nicht still weitermachen: ein offener Dialog heißt, die Aktion ist nicht abgeschlossen
  throw new Error(
    `settle: Dialog nach 10 s noch offen – ${(
      (await page
        .getByRole('dialog')
        .textContent()
        .catch(() => '')) ?? ''
    ).slice(0, 200)}`,
  );
}

/** Klickt einen Button (exakter Name oder RegExp) und wartet auf das Ergebnis */
export async function act(page: Page, name: string | RegExp, scope?: ReturnType<Page['locator']>) {
  const root = scope ?? page;
  await root
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .click();
  await settle(page);
}

export async function stage(page: Page) {
  return (await page.locator('[data-stage]:visible').first().textContent()) ?? '';
}

export async function expectStage(page: Page, text: string) {
  await expect(page.locator('[data-stage]:visible').first()).toContainText(text);
}

/** Aktueller Kampagnenzustand über den Admin-Export */
export async function exportState(page: Page, id: string) {
  const res = await page.request.get(`/api/c/${id}/export?revisions=0`);
  expect(res.status()).toBe(200);
  return (await res.json()).state as {
    stage: { kind: string; phase?: number; step?: string };
    planets: { id: string; power: Record<string, number> }[];
    fleets: { id: string; planetId: string | null; allianceId: string; name: string }[];
    players: { id: string; nickname: string; memberships: { allianceId: string; fromPhase: number; toPhase: number | null }[] }[];
    alliances: { id: string; name: string }[];
    events: { id: string; code: string; status: string; allianceId: string | null; data: Record<string, unknown> }[];
    medals: { medal: string; allianceId: string }[];
    inheritedMedals: { medal: string; assignedAllianceId?: string | null }[];
    result: { winnerAllianceId: string | null; tiebreak: string } | null;
  };
}

/**
 * Füllt ein Feld, bis die zugehörige Schaltfläche aktiv ist. Direkt nach dem Laden kann React beim Hydrieren ein
 * eben getipptes Feld noch leeren – dann einfach erneut tippen.
 */
export async function fillUntilEnabled(input: ReturnType<Page['locator']>, value: string, button: ReturnType<Page['locator']>) {
  await expect(async () => {
    await input.fill(value);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Schaltet mit „Weiter …“ zum nächsten Schritt und wartet auf `text`. Bleibt der Schritt unter Last unverändert
 * (Klick fiel in eine laufende Aktion), wird erneut geklickt – aber nur dann, damit nie ein Schritt übersprungen wird.
 */
export async function advanceTo(page: Page, text: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stage(page);
    await act(page, /^Weiter/);
    const changed = await expect
      .poll(async () => await stage(page), { timeout: 15_000 })
      .not.toBe(before)
      .then(() => true)
      .catch(() => false);
    if (changed) break;
  }
  await expectStage(page, text);
}
