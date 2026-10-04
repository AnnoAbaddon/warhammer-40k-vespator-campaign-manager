import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { act, expectStage, login, settle, stage, fillUntilEnabled, advanceTo } from './helpers';

/**
 * Kampagnen-E2E (NTH2 6.3): eine komplette, kurze Kampagne über die Oberfläche –
 * 2 Allianzen mit je 2 Spielern, 2 Phasen. Setup-Wizard W0–W5, Befehle über die Spielerlinks,
 * Reveal, Schlacht mit Ergebnismeldung (Spieler) und Bestätigung (Gegenseite), Verarbeitung,
 * Events, Bewegungen, Bau und Kampagnenende mit Sieger (Cockpit, Spielerseite, Hall of Fame).
 *
 * Die Phasenzahl wird direkt im Anlegen-Formular gesetzt (Feld „Phasen“ = 2).
 * Zufall (Würfel, Events) wird über Schleifen mit Fallback abgedeckt: offene Events werden erst
 * angewendet, scheitert das (fehlende Eingaben), per „Verwerfen (Override)“ deterministisch erledigt.
 */

const NAME = `E2E Vollkampagne ${Date.now()}`;
const ALLIANCES = ['Rot', 'Blau'] as const;
type AllianceName = (typeof ALLIANCES)[number];
const PLAYERS: [string, string, AllianceName][] = [
  ['Anna', 'Orks', 'Rot'],
  ['Bruno', 'Necrons', 'Rot'],
  ['Cleo', 'Tau Empire', 'Blau'],
  ['Dario', 'Aeldari', 'Blau'],
];
const members = (al: string) => PLAYERS.filter(([, , a]) => a === al).map(([n]) => n);

/** W2: Stronghold, 3× PL 3, 4× PL 2 je Allianz (13 Planeten) */
const LEVELS: Record<AllianceName, { sh: string; pl3: string[]; pl2: string[] }> = {
  Rot: { sh: 'Norallus', pl3: ['Masnet', 'Karabas', 'Kryndaer'], pl2: ['Felgris Secundas', 'Caltus Novem', 'Marvinius', 'Vikus Decima'] },
  Blau: { sh: 'Jawardet', pl3: ['Tarkad Vindix', 'Astarthem', 'Ikaron Prime'], pl2: ['Novamagnor', 'Felgris Secundas', 'Masnet', 'Vikus Decima'] },
};
/** W3: bei 2 Allianzen 4 Stücke je Allianz (setupInfraCount) – ohne Slot-Konflikte, also ohne Auslosung */
const INFRA: Record<AllianceName, [string, string][]> = {
  Rot: [
    ['FORTIFICATION_LINE', 'masnet'],
    ['SUPPORT_FACILITY', 'karabas'],
    ['STAGING_GROUNDS', 'kryndaer'],
    ['FORTIFICATION_LINE', 'karabas'],
  ],
  Blau: [
    ['FORTIFICATION_LINE', 'tarkad-vindix'],
    ['SUPPORT_FACILITY', 'astarthem'],
    ['STAGING_GROUNDS', 'ikaron-prime'],
    ['FORTIFICATION_LINE', 'astarthem'],
  ],
};
/** W4: je Allianz 2 Flotten, jeder Spieler führt eine */
const STARTS: Record<string, string> = { 'Rot Flotte I': 'caltus-novem', 'Rot Flotte II': 'kryndaer', 'Blau Flotte I': 'novamagnor', 'Blau Flotte II': 'ikaron-prime' };
const COMMANDERS: Record<string, string> = { 'Rot Flotte I': 'Anna', 'Rot Flotte II': 'Bruno', 'Blau Flotte I': 'Cleo', 'Blau Flotte II': 'Dario' };
/** Die einzige Schlacht der Phase 1: Anna (Caltus Novem) greift das verbundene Ikaron Prime an */
const BATTLE = 'Purge and Burn · Ikaron Prime';

type Raw = {
  stage: { kind: string; phase?: number; step?: string };
  result: { winnerAllianceId: string | null; tiebreak: string } | null;
  alliances: { id: string; name: string }[];
  players: { id: string; nickname: string }[];
  fleets: { id: string; name: string; allianceId: string; planetId: string | null; reserve?: boolean; commanders: Record<string, string> }[];
  battles: { id: string; kind: string; status: string; planetId: string | null; attackType: string | null; vp: { attacker: number; defender: number } | null; draft: unknown }[];
  phases: { number: number; operations: { fleetId: string; type: string; revealed: boolean }[]; builds: Record<string, unknown> }[];
};

// über die seriellen Tests hinweg geteilt
let id = '';
const links: Record<string, string> = {};

/** Vollständiger Zustand über den Admin-Export (inkl. Schlachten und Kommandanten) */
async function rawState(page: Page): Promise<Raw> {
  const res = await page.request.get(`/api/c/${id}/export?revisions=0`);
  expect(res.status()).toBe(200);
  return (await res.json()).state as Raw;
}

async function openCockpit(page: Page) {
  await login(page);
  await page.goto(`/admin/c/${id}`);
  await page.waitForLoadState('networkidle');
}

/** Klickt eine Aktion nur, wenn sie angeboten wird (z. B. Archeotech, An Open Tome nach zufälligen Events) */
async function actIfPresent(page: Page, name: string, scope?: Locator) {
  const btn = (scope ?? page).getByRole('button', { name, exact: true });
  if ((await btn.count()) && (await btn.first().isEnabled())) await act(page, name, scope);
}

/** Weiterschalten im Cockpit und auf die neue Stufe warten */
async function advance(page: Page, next: string) {
  await advanceTo(page, next);
}

/** Spielerseite ohne Anmeldung öffnen (eigener Kontext = kein Admin-Cookie) */
async function openPlayer(ctx: BrowserContext, nick: string) {
  expect(links[nick], `Spielerlink von ${nick}`).toBeTruthy();
  const p = await ctx.newPage();
  await p.goto(links[nick]);
  await expect(p.getByText(nick).first()).toBeVisible();
  await p.waitForLoadState('networkidle');
  return p;
}

async function playerContext(browser: Browser) {
  return browser.newContext({ locale: 'de-DE', viewport: { width: 1500, height: 1000 } });
}

const card = (p: Page, text: string) => p.locator('section.hud:not(.frame)').filter({ hasText: text });
const fleetRow = (page: Page, fleet: string) =>
  page
    .locator('div.slab')
    .filter({ has: page.locator('b', { hasText: new RegExp(`^${fleet}$`) }) })
    .first();

/** Befehl über den Spielerlink erteilen; `fill` belegt das Formular vor */
async function giveOrder(p: Page, fleet: string, fill: (box: Locator) => Promise<void>) {
  const box = card(p, `Befehl für ${fleet} @`).first();
  await expect(box).toBeVisible();
  await fill(box);
  await act(p, 'Befehl erteilen (verdeckt)', box);
  await expect(box.getByText('Erteilter Befehl (verdeckt)')).toBeVisible();
}

/** Offene Events: erst anwenden, sonst (fehlende Eingaben) deterministisch per Override verwerfen */
async function resolveEvents(page: Page) {
  const open = page.locator('div.slab.border').filter({ has: page.getByRole('button', { name: 'Verwerfen (Override)', exact: true }) });
  for (let i = 0; i < 12; i++) {
    const n = await open.count();
    if (!n) break;
    await act(page, 'Anwenden', open.first());
    if ((await open.count()) < n) continue;
    await act(page, 'Verwerfen (Override)', open.first());
  }
  await expect(open).toHaveCount(0);
}

test.describe.serial('Kampagnen-E2E: kurze Kampagne komplett über die Oberfläche', () => {
  test('Setup W0–W5: 2 Allianzen, 4 Spieler, 2 Phasen', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);
    await page.fill('input[name=name]', NAME);
    await page.locator('select[name=allianceCount]').selectOption('2');
    await page.fill('input[name=phaseCount]', '2');
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await page.waitForURL(/\/admin\/c\//);
    id = page.url().split('/c/')[1].split(/[?#/]/)[0];
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
    for (let i = 0; i < ALLIANCES.length; i++) {
      const slab = fleetPanel.locator('div.slab').nth(i);
      // nach dem Speichern der vorigen Allianz lädt die Seite neu und kann ein eben ausgefülltes Feld zurücksetzen –
      // deshalb wiederholen, bis die Flottenzahl wirklich übernommen ist
      await expect(async () => {
        await slab.getByLabel('Flottenzahl').fill('2');
        const save = slab.getByRole('button', { name: 'Flotten setzen', exact: true });
        if (await save.isEnabled()) await act(page, 'Flotten setzen', slab);
        await expect(slab.getByText('aktuell 2')).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    }
    await expect(fleetPanel.getByText('aktuell 2')).toHaveCount(2);
    await advance(page, 'Setup · Strongholds & Power Level');

    // ── W2: Strongholds & Start-Power-Level (verdeckt, dann aufdecken) ──
    for (const al of ALLIANCES) {
      await page.getByRole('tab', { name: new RegExp(`^${al}`) }).click();
      const lv = LEVELS[al];
      const pick = (planet: string, level: string) =>
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
    await advance(page, 'Setup · Start-Infrastruktur');

    // ── W3: Start-Infrastruktur (4 Stücke je Allianz) ──
    for (const al of ALLIANCES) {
      await page.getByRole('tab', { name: new RegExp(`^${al}`) }).click();
      const panel = page.locator('section.hud:not(.frame)').filter({ has: page.getByRole('button', { name: 'Speichern (verdeckt)', exact: true }) });
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
    await advance(page, 'Setup · Flotten-Startpositionen');

    // ── W4: Flotten-Startpositionen ──
    for (const [fleet, planet] of Object.entries(STARTS)) {
      await page
        .locator('div.flex')
        .filter({ has: page.getByText(fleet, { exact: true }) })
        .last()
        .locator('select')
        .selectOption(planet);
    }
    await act(page, 'Speichern (verdeckt)');
    await act(page, 'Aufdecken');
    await expect(page.getByText('W4 · Flotten aufgedeckt')).toBeVisible();
    await advance(page, 'Setup · Start vorbereiten');

    // ── W5: Start ──
    await act(page, 'Kampagne starten');
    await expectStage(page, 'Phase 1/2 · Operationen wählen');

    const s = await rawState(page);
    expect(s.stage).toEqual({ kind: 'PHASE', phase: 1, step: 'OPS' });
    expect(s.alliances.map((a) => a.name).sort()).toEqual(['Blau', 'Rot']);
    expect(s.players).toHaveLength(4);
    const pos = Object.fromEntries(s.fleets.filter((f) => !f.reserve).map((f) => [f.name, f.planetId]));
    expect(pos).toEqual(STARTS);

    // Spielerlinks: Sammelblatt erzeugt fehlende Links (Druckfassung enthält den vollständigen Link)
    await page.goto(`/admin/c/${id}/player-links`);
    for (const [nick] of PLAYERS) {
      const item = page.locator('li').filter({ has: page.locator('p.font-serif', { hasText: new RegExp(`^${nick}$`) }) });
      const url = ((await item.locator('p.font-mono').textContent()) ?? '').trim();
      expect(url, `Link für ${nick}`).toContain('/p/');
      links[nick] = url;
    }
  });

  test('Phase 1: Kommandanten, Befehle über Spielerlinks, Reveal, Bauen', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await openCockpit(page);
    await expectStage(page, 'Phase 1/2 · Operationen wählen');
    // Kommandanten fest zuordnen (unabhängig von der automatischen Verteilung)
    for (const [fleet, nick] of Object.entries(COMMANDERS)) {
      await fleetRow(page, fleet).getByLabel('Kommandant').selectOption({ label: nick });
      await settle(page);
    }
    // Befehl wirkt „silent“ – auf den gespeicherten Stand warten
    await expect
      .poll(async () => {
        const s = await rawState(page);
        return Object.fromEntries(s.fleets.map((f) => [f.name, s.players.find((p) => p.id === f.commanders['1'])?.nickname]));
      })
      .toEqual(COMMANDERS);

    const ctx = await playerContext(browser);
    try {
      // Anna: Schlacht (Purge and Burn auf Ikaron Prime gegen Blau)
      const anna = await openPlayer(ctx, 'Anna');
      await giveOrder(anna, 'Rot Flotte I', async (box) => {
        await box.getByLabel('Operation', { exact: true }).selectOption('BATTLE');
        await box.getByLabel('Attack Type', { exact: true }).selectOption('PURGE_AND_BURN');
        await box.getByLabel('Zielplanet', { exact: true }).selectOption('ikaron-prime');
        await box.getByLabel('Gegner', { exact: true }).selectOption({ label: 'Blau' });
      });
      // Bruno und Cleo: Logistical Auxilia
      for (const [nick, fleet] of [
        ['Bruno', 'Rot Flotte II'],
        ['Cleo', 'Blau Flotte I'],
      ] as const) {
        const p = await openPlayer(ctx, nick);
        await giveOrder(p, fleet, async (box) => {
          await box.getByLabel('Operation', { exact: true }).selectOption('LOGISTICAL_AUXILIA');
        });
        await p.close();
      }
      // Dario: Raise Edifices (Fortification Line auf Ikaron Prime)
      const dario = await openPlayer(ctx, 'Dario');
      await giveOrder(dario, 'Blau Flotte II', async (box) => {
        await box.getByLabel('Operation', { exact: true }).selectOption('RAISE_EDIFICES');
        await box.getByLabel('Infrastruktur', { exact: true }).selectOption('FORTIFICATION_LINE');
      });
    } finally {
      await ctx.close();
    }

    // Cockpit: alle Befehle erteilt (verdeckt, noch nicht aufgedeckt)
    await page.reload();
    await expect(page.getByText('Befehle: 4 von 4 erteilt')).toBeVisible();
    let s = await rawState(page);
    expect(s.phases.find((p) => p.number === 1)!.operations.filter((o) => !o.revealed)).toHaveLength(4);

    await advance(page, 'Phase 1/2 · Reveal');
    await act(page, 'Operationen aufdecken');
    s = await rawState(page);
    expect(s.phases.find((p) => p.number === 1)!.operations.every((o) => o.revealed)).toBe(true);
    const battle = s.battles.find((b) => b.attackType === 'PURGE_AND_BURN' && b.planetId === 'ikaron-prime');
    expect(battle, 'Schlacht aus der Battle Operation').toBeTruthy();

    await advance(page, 'Phase 1/2 · Edifice Raising');
    await act(page, 'Bauen ausführen');
    await expect(page.getByText('Ausgeführt.', { exact: true })).toBeVisible();
    await advance(page, 'Phase 1/2 · Schlachten laufen');
  });

  test('Phase 1: Ergebnis per Spielerlink melden und von der Gegenseite bestätigen', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const ctx = await playerContext(browser);
    try {
      // Angreiferin meldet das Ergebnis
      const anna = await openPlayer(ctx, 'Anna');
      await anna.getByRole('tab', { name: /^Schlachten/ }).click();
      const form = card(anna, BATTLE)
        .filter({ has: anna.getByText('Ergebnis melden') })
        .first();
      await expect(form).toBeVisible();
      await form.getByText('Ergebnis melden').click();
      await form.getByLabel('VP Angreifer').fill('78');
      await form.getByLabel('VP Verteidiger').fill('52');
      await form.getByLabel('Gespielt am').fill('2026-10-01T18:00');
      await act(anna, 'Ergebnis zur Bestätigung senden', form);
      await expect(anna.getByText('Wartet auf Bestätigung der Gegenseite.').first()).toBeVisible();

      // Gegenseite (ein Mitglied von Blau, das die Verteidigung stellt) bestätigt in „Aufgaben“
      let confirmed = false;
      for (const nick of members('Blau')) {
        const p = await openPlayer(ctx, nick);
        const box = card(p, BATTLE).filter({ has: p.getByRole('button', { name: 'Bestätigen', exact: true }) });
        if (await box.count()) {
          await act(p, 'Bestätigen', box.first());
          await expect(card(p, BATTLE).getByRole('button', { name: 'Bestätigen', exact: true })).toHaveCount(0);
          confirmed = true;
        }
        await p.close();
        if (confirmed) break;
      }
      expect(confirmed, 'Blau konnte das Ergebnis bestätigen').toBe(true);
    } finally {
      await ctx.close();
    }

    await openCockpit(page);
    const s = await rawState(page);
    const b = s.battles.find((x) => x.attackType === 'PURGE_AND_BURN' && x.planetId === 'ikaron-prime')!;
    expect(b.vp).toEqual({ attacker: 78, defender: 52 });
    expect(b.draft).toBeNull();
  });

  test('Phase 1: Verarbeitung, Events, Bewegungen und Bau', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await openCockpit(page);
    await expectStage(page, 'Phase 1/2 · Schlachten laufen');
    await advance(page, 'Phase 1/2 · Ergebnisse verarbeiten');
    await actIfPresent(page, 'Archeotech auswerten');
    await act(page, 'Alle verarbeiten');
    let s = await rawState(page);
    expect(s.battles.find((x) => x.attackType === 'PURGE_AND_BURN' && x.planetId === 'ikaron-prime')!.status).toBe('PROCESSED');

    await advance(page, 'Phase 1/2 · Fleet Arrival');
    await act(page, 'Void Leaps ausführen');
    await advance(page, 'Phase 1/2 · Low-level Resistance');
    await act(page, 'Kill Teams auswerten');
    await advance(page, 'Phase 1/2 · Punkte & Events');

    // Punkte und Events (zufällig: jede Anzahl offener Events wird abgearbeitet)
    await act(page, 'Punkte berechnen');
    await act(page, 'Events generieren');
    await resolveEvents(page);
    await advance(page, 'Phase 1/2 · Flotten bewegen');

    // Bewegungen über die Spielerlinks (Kommandanten dieser Phase); Anna zieht, die anderen bleiben stehen
    s = await rawState(page);
    const ctx = await playerContext(browser);
    try {
      for (const f of s.fleets.filter((x) => !x.reserve && x.planetId)) {
        const nick = s.players.find((p) => p.id === f.commanders['1'])?.nickname;
        if (!nick || !links[nick]) continue;
        const p = await openPlayer(ctx, nick);
        const box = card(p, `Bewegung für ${f.name} @`).first();
        const btn = box.getByRole('button', { name: 'Bewegung festlegen (verdeckt)', exact: true });
        if (await btn.count()) {
          const sel = box.getByLabel('bleibt', { exact: true });
          if (nick === 'Anna' && (await sel.locator('option').count()) > 1) await sel.selectOption({ index: 1 });
          await act(p, 'Bewegung festlegen (verdeckt)', box);
          await expect(box.getByText(/Festgelegt:/)).toBeVisible();
        }
        await p.close();
      }
    } finally {
      await ctx.close();
    }
    await page.reload();
    await act(page, 'Bewegungen ausführen');
    await expect(page.getByText('Ausgeführt.', { exact: true })).toBeVisible();
    await advance(page, 'Phase 1/2 · Infrastruktur bauen');

    // Bau: Reihenfolge bestimmen, dann baut je Allianz ein Mitglied über seinen Link
    await act(page, 'Reihenfolge bestimmen');
    const bctx = await playerContext(browser);
    try {
      for (let turn = 0; turn < ALLIANCES.length; turn++) {
        await page.reload();
        const active = page.locator('li[data-active="true"]');
        if (!(await active.count())) break;
        const text = (await active.first().textContent()) ?? '';
        const al = ALLIANCES.find((a) => text.includes(a))!;
        expect(al, `aktive Allianz im Bauschritt: ${text}`).toBeTruthy();
        for (const nick of members(al)) {
          const p = await openPlayer(bctx, nick);
          const box = card(p, 'Deine Allianz baut jetzt').first();
          if (!(await box.count())) {
            await p.close();
            continue;
          }
          const type = box.getByLabel('Bauwerk', { exact: true });
          let built = false;
          if ((await type.locator('option').count()) > 1) {
            await type.selectOption({ index: 1 });
            const planet = box.getByLabel('Planet', { exact: true });
            if ((await planet.locator('option').count()) > 1) {
              await planet.selectOption({ index: 1 });
              await act(p, 'Bauen', box);
              built = true;
            }
          }
          if (!built) await act(p, 'Verzichten', box);
          await p.close();
          break;
        }
        // Fallback: konnte kein Spieler bauen (z. B. Warnung, die nur der Spielleiter übergehen darf), verzichtet der SL
        await page.reload();
        const still = page.locator('li[data-active="true"]').filter({ hasText: al });
        if (await still.count()) await act(page, 'Verzichten', still.first());
      }
    } finally {
      await bctx.close();
    }
    await page.reload();
    s = await rawState(page);
    expect(Object.keys(s.phases.find((p) => p.number === 1)!.builds).sort()).toEqual(s.alliances.map((a) => a.id).sort());
    await advance(page, 'Phase 2/2 · Operationen wählen');
  });

  test('Phase 2 und Kampagnenende mit Sieger', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await openCockpit(page);
    await expectStage(page, 'Phase 2/2 · Operationen wählen');

    // Kommandanten der Phase 2 (übernommen oder – nach Events – neu verteilt); fehlt einer, setzt ihn der SL
    let s = await rawState(page);
    for (const f of s.fleets.filter((x) => !x.reserve && x.planetId && !x.commanders['2'])) {
      await fleetRow(page, f.name).getByLabel('Kommandant').selectOption({ index: 1 });
      await settle(page);
    }
    s = await rawState(page);
    const ctx = await playerContext(browser);
    try {
      for (const f of s.fleets.filter((x) => !x.reserve && x.planetId)) {
        const nick = s.players.find((p) => p.id === f.commanders['2'])?.nickname;
        if (!nick || !links[nick]) continue;
        const p = await openPlayer(ctx, nick);
        const box = card(p, `Befehl für ${f.name} @`).first();
        // Logistical Auxilia kann durch ein Event (Sinister Omens) gesperrt sein – dann bleibt der Befehl offen
        if ((await box.count()) && (await box.getByLabel('Operation', { exact: true }).first().locator('option[value="LOGISTICAL_AUXILIA"]').count())) {
          await giveOrder(p, f.name, async (b) => {
            await b.getByLabel('Operation', { exact: true }).selectOption('LOGISTICAL_AUXILIA');
          });
        }
        await p.close();
      }
    } finally {
      await ctx.close();
    }

    await page.reload();
    await actIfPresent(page, 'Operationen offenlegen'); // An Open Tome
    await advance(page, 'Phase 2/2 · Reveal');
    await act(page, 'Operationen aufdecken');
    await advance(page, 'Phase 2/2 · Edifice Raising');
    await act(page, 'Bauen ausführen');
    await advance(page, 'Phase 2/2 · Schlachten laufen');
    // ggf. durch Events entstandene Schlachten ohne Ergebnis: Weiterschalten wertet sie ungespielt (Warnung wird bestätigt)
    await advance(page, 'Phase 2/2 · Ergebnisse verarbeiten');
    await actIfPresent(page, 'Archeotech auswerten');
    await actIfPresent(page, 'Alle verarbeiten');
    await advance(page, 'Phase 2/2 · Fleet Arrival');
    await actIfPresent(page, 'Void Leaps ausführen');
    await advance(page, 'Phase 2/2 · Low-level Resistance');
    await actIfPresent(page, 'Kill Teams auswerten');
    await advance(page, 'Phase 2/2 · Punkte & Events');

    // Letzte Phase: keine Events, nach dem Festschreiben der Punkte endet die Kampagne
    await act(page, 'Punkte berechnen');
    await expect(page.getByText('Letzte Phase')).toBeVisible();
    await act(page, 'Kampagne beenden');
    await expect(page.locator('[data-stage]:visible').first()).toContainText(/Kampagne beendet|Entscheidungsschlacht/);
    if ((await stage(page)).includes('Entscheidungsschlacht')) {
      // Gleichstand: deterministisch per Spielleiter-Entscheid statt Würfel/Schlacht
      await act(page, `${ALLIANCES[0]} gewinnt`);
    }
    await expectStage(page, 'Kampagne beendet');

    s = await rawState(page);
    expect(s.stage.kind).toBe('ENDED');
    const winner = s.alliances.find((a) => a.id === s.result?.winnerAllianceId);
    expect(winner, 'Sieger festgestellt').toBeTruthy();
    await expect(page.getByText('Sieger der Vespator Front')).toBeVisible();
    await expect(page.locator('p.inset').filter({ hasText: winner!.name }).first()).toBeVisible();
    await expect(page.getByText('Laurel of Victory').filter({ visible: true }).first()).toBeVisible();

    // Spielerseite zeigt das Ende mit Sieger
    const pctx = await playerContext(browser);
    try {
      const anna = await openPlayer(pctx, 'Anna');
      const end = card(anna, 'Kampagne beendet').first();
      await expect(end).toBeVisible();
      await expect(end.getByText('Sieger:')).toBeVisible();
      await expect(end).toContainText(winner!.name);
    } finally {
      await pctx.close();
    }
  });

  test('Hall of Fame listet die beendete Kampagne mit Sieger', async ({ page, browser }) => {
    await login(page);
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: 'Administration' }).click();
    const sect = page.getByRole('region', { name: 'Hall of Fame (öffentlicher Link)' });
    const href = await sect.getByRole('link', { name: /Öffnen/ }).getAttribute('href');
    expect(href).toContain('/hall/');
    const s = await rawState(page);
    const winner = s.alliances.find((a) => a.id === s.result?.winnerAllianceId)!;

    const ctx = await playerContext(browser);
    try {
      const hall = await ctx.newPage();
      await hall.goto(href!);
      const panel = hall.locator('section').filter({ hasText: NAME }).last();
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(winner.name);
    } finally {
      await ctx.close();
    }
  });
});
