'use client';

import { AllianceMembers } from '../people/AllianceMembers';
import { MEDALS } from '@/engine/data/vespator';
import { currentAllianceOf } from '@/engine/players';
import { AllianceTag, Panel } from '@/components/ui';
import { ArrowRightIcon } from '@/components/icons';
import { useCmd } from '../CommandProvider';
import { AlliancesSection } from '../people/PeopleTab';
import { QuickPlayerForm } from '../people/PlayerEditor';
import { FleetCountControl } from '../people/FleetControls';
import { StepHeader } from './common';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { mapOf } from '@/engine/map';
import { useCampaignInfo } from '../infoCtx';
import { MapEditor } from './MapEditor';
import { useT } from '@/i18n/client';
import { GameIcon } from '@/components/icons/GameIcon';

export function W0() {
  const { state, run, busy } = useCmd();
  const t = useT();
  const unassigned = state.players.filter((p) => p.active && !currentAllianceOf(p));
  return (
    <div className="space-y-3">
      <Panel>
        <StepHeader title={t('W0 · Allianzen, Spieler & Flotten')}>
          {t('Lege {n} Allianzen an, ordne die Spieler zu und bestimme die Flotten je Allianz. Detaillierte Bearbeitung im Tab „Allianzen & Spieler“.', { n: state.meta.allianceCount })}
        </StepHeader>
      </Panel>
      <MapCard />
      <AlliancesSection />
      <Panel title={t('Spieler ({n})', { n: state.players.length })} icon={<GameIcon name="fa_marines" size={18} />}>
        <div className="inset p-3">
          <QuickPlayerForm />
        </div>
        <ul className="mt-3 space-y-2 text-[15px]">
          {state.alliances.map((a) => (
            <li key={a.id} className="slab space-y-1.5 p-2.5">
              <AllianceTag alliance={a} />
              <AllianceMembers allianceId={a.id} />
            </li>
          ))}
          {unassigned.length > 0 && (
            <li className="notice">
              {t('Ohne Allianz:')} {unassigned.map((p) => p.nickname).join(', ')}
            </li>
          )}
        </ul>
      </Panel>
      {state.alliances.length > 0 && (
        <Panel title={t('Flotten je Allianz')} icon={<GameIcon name="ui_FLEET" size={18} />}>
          <div className="space-y-3">
            {state.alliances.map((a) => (
              <div key={a.id} className="slab space-y-1.5 p-2.5">
                <AllianceTag alliance={a} className="mb-1" />
                <FleetCountControl key={`${a.id}-${state.fleets.filter((f) => f.allianceId === a.id).length}`} allianceId={a.id} />
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Panel>
        <button className="btn btn-primary" disabled={busy} onClick={() => run({ type: 'SETUP_W0_DONE' })}>
          {t('Weiter')} <ArrowRightIcon />
        </button>
      </Panel>
    </div>
  );
}

export function W1() {
  const { state, run, busy } = useCmd();
  const t = useT();
  const holders = (ids: string[], allianceId: string) =>
    ids.filter((pid) => {
      const p = state.players.find((x) => x.id === pid);
      return p && currentAllianceOf(p) === allianceId;
    }).length;
  return (
    <Panel>
      <StepHeader title={t('W1 · Medaillen der Vorkampagne')}>{t('Jede Medaille geht an die Allianz mit den meisten Trägern (Gleichstand: Roll-off). Du kannst sie auch anders zuordnen oder verwerfen.')}</StepHeader>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Medaille')}</th>
              {state.alliances.map((a) => (
                <th key={a.id}>
                  <AllianceTag alliance={a} />
                </th>
              ))}
              <th>{t('Zuordnung')}</th>
            </tr>
          </thead>
          <tbody>
            {state.inheritedMedals.map((m) => (
              <tr key={m.medal}>
                <td>{MEDALS[m.medal].name}</td>
                {state.alliances.map((a) => (
                  <td key={a.id}>{t('{n} Träger', { n: holders(m.holderPlayerIds, a.id) })}</td>
                ))}
                <td>
                  <select
                    className="select"
                    aria-label={t('Zuordnung {medal}', { medal: MEDALS[m.medal].name })}
                    value={m.assignedAllianceId === undefined ? '' : m.assignedAllianceId === null ? '__none' : m.assignedAllianceId}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      run({
                        type: 'SETUP_MEDAL_ASSIGN',
                        medal: m.medal,
                        allianceId: v === '__none' ? null : v,
                      });
                    }}
                  >
                    <option value="">{t('– offen –')}</option>
                    {state.alliances.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                    <option value="__none">{t('verwerfen')}</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" disabled={busy} onClick={() => run({ type: 'SETUP_MEDAL_SUGGEST' })}>
          {t('Vorschlag nach Regel')}
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => run({ type: 'SETUP_W1_DONE' })}>
          {t('Weiter')} <ArrowRightIcon />
        </button>
      </div>
    </Panel>
  );
}

/** Kartenwahl und Editor (N5.5) – nur in W0, danach ist die Karte gesperrt */
function MapCard() {
  const { state, readOnly } = useCmd();
  const { mapTemplates } = useCampaignInfo();
  const t = useT();
  const [open, setOpen] = useState(false);
  const map = mapOf(state);
  return (
    <Panel
      title={t('Karte')}
      icon={<GameIcon name="ui_PLANET" size={18} />}
      actions={
        !readOnly && (
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            {t('Karte bearbeiten')}
          </button>
        )
      }
    >
      <p className="text-[15px]">
        <b>{map.name}</b> · {t('{n} Planeten', { n: map.planets.length })} · {t('{n} Verbindungen', { n: map.connections.length })}
        {map.template === 'vespator' ? <span className="text-faint"> · {t('Regelwerk-Karte')}</span> : <span className="text-faint"> · {t('eigene Karte')}</span>}
      </p>
      <p className="mt-1 text-[13px] text-faint">{t('Nach Abschluss dieses Schritts ist die Karte für die Kampagne gesperrt.')}</p>
      {/* Vollbild-Dialog außerhalb des Moduls rendern (Container-Abfragen bilden einen eigenen Bezugsrahmen) */}
      {open && createPortal(<MapEditor templates={mapTemplates} onClose={() => setOpen(false)} />, document.body)}
    </Panel>
  );
}
