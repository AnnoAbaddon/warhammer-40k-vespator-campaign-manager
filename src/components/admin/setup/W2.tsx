'use client';

import { useState } from 'react';
import { AllianceTag, Panel, PlanetSelect, planetName } from '@/components/ui';
import { ArrowRightIcon } from '@/components/icons';
import { useCmd } from '../CommandProvider';
import { AllianceSwitch, Messages, StepHeader, medalHolder, useHighlight } from './common';
import { mapOf } from '@/engine/map';
import { strongholdQuota } from '@/engine/setup';
import { useT } from '@/i18n/client';

type Level = 1 | 2 | 3 | 4;

export function W2() {
  const { state } = useCmd();
  const su = state.setup;
  if (su.laurel && !su.laurel.planetId) return <LaurelPick />;
  return su.strongholdsRevealed ? <W2Revealed /> : <W2Choose />;
}

function LaurelPick() {
  const { state, run, busy } = useCmd();
  const [p, setP] = useState('');
  const t = useT();
  const al = state.alliances.find((a) => a.id === state.setup.laurel!.allianceId);
  return (
    <Panel>
      <StepHeader title="W2 · Laurel of Victory">
        <AllianceTag alliance={al} />{' '}
        {t('wählt zuerst einen Planeten: Dort steht ihr Stronghold mit einer zusätzlichen Fortification Line. Andere Allianzen können dort nichts bauen, dort kein PL über 1 wählen und keine Flotten starten.')}
      </StepHeader>
      <div className="flex gap-2">
        <PlanetSelect value={p} onChange={setP} />
        <button className="btn btn-primary" disabled={!p || busy} onClick={() => run({ type: 'SETUP_LAUREL_PLANET', planetId: p })}>
          {t('Festlegen')}
        </button>
      </div>
    </Panel>
  );
}

function initLevels(state: ReturnType<typeof useCmd>['state'], aid: string): Record<string, Level> {
  const c = state.setup.strongholds[aid];
  const out: Record<string, Level> = {};
  for (const p of mapOf(state).planets) out[p.id] = 1;
  if (!c) return out;
  if (c.strongholdPlanetId) out[c.strongholdPlanetId] = 4;
  for (const id of c.pl3) out[id] = 3;
  for (const id of c.pl2) out[id] = 2;
  return out;
}

function W2Choose() {
  const { state, run, busy } = useCmd();
  const su = state.setup;
  const [active, setActive] = useState(state.alliances[0]?.id ?? '');
  const t = useT();
  const complete = (aid: string) => {
    const c = su.strongholds[aid];
    const q = strongholdQuota(state, aid);
    return !!c?.strongholdPlanetId && c.pl3.length === q.pl3 && c.pl2.length === q.pl2;
  };
  const allDone = state.alliances.every((a) => complete(a.id));
  // Regelwerk: 3× PL 3, 4× PL 2 – auf kleinen Karten weniger (gleiche Rechnung wie in der Engine)
  const std = strongholdQuota(state, '');
  return (
    <div className="space-y-3">
      <Panel>
        <StepHeader title={t('W2 · Strongholds & Start-Power-Level')}>
          {t('Jede Allianz wählt verdeckt: 1 Stronghold-Planet (PL 4), {pl3} Planeten mit PL 3, {pl2} Planeten mit PL 2, alle übrigen PL 1. Die Eingaben sind nur für dich sichtbar, bis du aufdeckst.', {
            pl3: std.pl3,
            pl2: std.pl2,
          })}
        </StepHeader>
        <Messages messages={su.messages} />
        <div className="mt-3">
          <AllianceSwitch state={state} value={active} onChange={setActive} done={complete} />
        </div>
      </Panel>
      {active && <AllianceLevels key={`${active}-${JSON.stringify(state.setup.strongholds[active] ?? null)}`} allianceId={active} primary={!allDone} />}
      <Panel>
        <div className="flex flex-wrap items-center gap-2">
          <button className={`btn ${allDone ? 'btn-primary' : ''}`} disabled={busy || !allDone} onClick={() => run({ type: 'SETUP_REVEAL_STRONGHOLDS' })}>
            {t('Aufdecken')}
          </button>
          {!allDone && <span className="text-[15px] text-dim">{t('Erst alle Allianzen vollständig eintragen.')}</span>}
        </div>
      </Panel>
    </div>
  );
}

/** `primary`: Speichern ist die Hauptaktion der Ansicht (solange noch nicht aufgedeckt werden kann) */
function AllianceLevels({ allianceId, primary }: { allianceId: string; primary: boolean }) {
  const { state, run, busy } = useCmd();
  const laurel = state.setup.laurel;
  const t = useT();
  const [lv, setLv] = useState<Record<string, Level>>(() => initLevels(state, allianceId));
  const count = (l: Level) => Object.values(lv).filter((x) => x === l).length;
  const q = strongholdQuota(state, allianceId);
  const need: Record<4 | 3 | 2, number> = { 4: 1, 3: q.pl3, 2: q.pl2 };
  const chosen = mapOf(state)
    .planets.filter((p) => lv[p.id] >= 2)
    .map((p) => p.id);
  useHighlight(chosen);
  const isLaurelAlliance = laurel?.allianceId === allianceId;
  const lockedFor = (pid: string) => (laurel?.planetId === pid ? (isLaurelAlliance ? 'laurel-own' : 'laurel-other') : null);
  const al = state.alliances.find((a) => a.id === allianceId);

  const save = () => {
    const sh = Object.keys(lv).find((k) => lv[k] === 4) ?? null;
    return run({
      type: 'SETUP_STRONGHOLDS',
      allianceId,
      strongholdPlanetId: sh,
      pl3: Object.keys(lv).filter((k) => lv[k] === 3),
      pl2: Object.keys(lv).filter((k) => lv[k] === 2),
    });
  };

  const setLevel = (pid: string, l: Level) => {
    setLv((x) => {
      const n = { ...x };
      if (l === 4) for (const k of Object.keys(n)) if (n[k] === 4) n[k] = 1;
      n[pid] = l;
      return n;
    });
  };

  return (
    <Panel title={<AllianceTag alliance={al} />}>
      <p className="mb-2 font-mono text-[13px]">
        {t('Noch zu vergeben:')}{' '}
        {([4, 3, 2] as const).map((l) => (
          <span key={l} className={`mr-2 ${count(l) === need[l] ? 'text-ok' : count(l) > need[l] ? 'text-danger' : 'text-warn'}`}>
            {Math.max(0, need[l] - count(l))}×{l}
            {count(l) > need[l] ? ` (${t('{n} zu viel', { n: count(l) - need[l] })})` : ''}
          </span>
        ))}
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Planet')}</th>
              <th>Slots</th>
              <th>Power Level</th>
            </tr>
          </thead>
          <tbody>
            {mapOf(state).planets.map((p) => {
              const lock = lockedFor(p.id);
              return (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {lock && <span className="chip ml-1">Laurel</span>}
                  </td>
                  <td className="text-dim">{p.slots}</td>
                  <td>
                    <div className="flex gap-1" role="radiogroup" aria-label={`PL ${p.name}`}>
                      {([4, 3, 2, 1] as Level[]).map((l) => {
                        const disabled = (lock === 'laurel-other' && l > 1) || (lock === 'laurel-own' && l !== 4) || (isLaurelAlliance && l === 4 && lock !== 'laurel-own');
                        return (
                          <button
                            key={l}
                            type="button"
                            role="radio"
                            aria-checked={lv[p.id] === l}
                            disabled={disabled}
                            className={`h-8 w-9 border font-mono text-[15px] disabled:opacity-25 ${lv[p.id] === l ? 'border-accent text-black' : 'border-line text-dim'}`}
                            style={
                              lv[p.id] === l
                                ? {
                                    background: l === 1 ? '#a08a63' : (al?.color ?? '#e0b95c'),
                                  }
                                : undefined
                            }
                            onClick={() => setLevel(p.id, l)}
                            title={l === 4 ? 'Stronghold (PL 4)' : `PL ${l}`}
                          >
                            {l === 4 ? 'SH' : l}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex gap-2">
        <button className={`btn ${primary ? 'btn-primary' : ''}`} disabled={busy} onClick={save}>
          {t('Speichern (verdeckt)')}
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => setLv(initLevels(state, allianceId))}>
          {t('Zurücksetzen')}
        </button>
      </div>
    </Panel>
  );
}

function W2Revealed() {
  const { state, run, busy } = useCmd();
  const wreath = medalHolder(state, 'WREATH');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const t = useT();
  // Nur eine Hauptaktion je Ansicht: erst Wreath anwenden, dann weiter
  const wreathOpen = !!wreath && !state.setup.wreathApplied;
  return (
    <div className="space-y-3">
      <Panel>
        <StepHeader title={t('W2 · Aufgedeckt')}>{t('Strongholds und Start-Power-Level stehen auf der Karte.')}</StepHeader>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Planet')}</th>
                {state.alliances.map((al) => (
                  <th key={al.id}>
                    <AllianceTag alliance={al} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.planets.map((p) => (
                <tr key={p.id}>
                  <td>{planetName(p.id)}</td>
                  {state.alliances.map((al) => (
                    <td key={al.id} className="font-mono">
                      {p.power[al.id]}
                      {p.slots.some((s) => s.infra?.type === 'STRONGHOLD' && s.infra.allianceId === al.id) && ' ★'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {wreath && (
        <Panel title="Penumbral Wreath">
          {state.setup.wreathApplied ? (
            <p className="notice notice-ok">{t('Angewendet.')}</p>
          ) : (
            <>
              <p className="mb-2 text-[15px]">
                <AllianceTag alliance={state.alliances.find((x) => x.id === wreath)} /> {t('wählt zwei Planeten: dort +2 Power Level (max. 4).')}
              </p>
              <div className="flex flex-wrap gap-2">
                <PlanetSelect value={a} onChange={setA} className="max-w-52" placeholder={t('– erster Planet –')} />
                <PlanetSelect value={b} onChange={setB} className="max-w-52" placeholder={t('– zweiter Planet –')} />
                <button className="btn btn-primary" disabled={busy || !a || !b || a === b} onClick={() => run({ type: 'SETUP_WREATH', planetIds: [a, b] })}>
                  {t('Anwenden')}
                </button>
              </div>
            </>
          )}
        </Panel>
      )}
      <Panel>
        <button className={`btn ${wreathOpen ? '' : 'btn-primary'}`} disabled={busy} onClick={() => run({ type: 'SETUP_W2_DONE' })}>
          {t('Weiter')} <ArrowRightIcon />
        </button>
      </Panel>
    </div>
  );
}
