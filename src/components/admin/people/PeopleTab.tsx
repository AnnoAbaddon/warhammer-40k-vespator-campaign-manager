'use client';

import { useRef, useState } from 'react';
import type { Player } from '@/engine/types';
import { allianceOf, currentAllianceOf, playersOfAlliance } from '@/engine/players';
import { AllianceTag, Avatar, FactionTag, Empty, Panel, PlanetSelect, planetName, TabPanel, Tabs, uploadUrl } from '@/components/ui';
import { CloseIcon } from '@/components/icons';
import { useCmd } from '../CommandProvider';
import { AllianceMembers } from './AllianceMembers';
import { AllianceEditor } from './AllianceEditor';
import { PlayerEditor, QuickPlayerForm } from './PlayerEditor';
import { PlayerLink } from './PlayerLink';
import { CommanderEditor } from './CommanderEditor';
import { CrusadeAdminSection } from '@/components/crusade/OrderOfBattle';
import { PrivacyTools } from './PrivacyTools';
import { FleetCountControl, ReserveControl, reserveTargets } from './FleetControls';
import { useIntlLocale, useT } from '@/i18n/client';
import { LifecycleSection } from './LifecycleSection';
import { StorySection } from './StorySection';
import { HobbyAdmin } from './HobbyAdmin';
import { GameIcon } from '@/components/icons/GameIcon';

type Section = 'alliances' | 'players' | 'fleets' | 'lifecycle' | 'story';

export function PeopleTab() {
  const [sec, setSec] = useState<Section>('players');
  const t = useT();
  return (
    <div className="space-y-3">
      <Tabs<Section>
        sticky
        idBase="people"
        label={t('Allianzen & Spieler')}
        value={sec}
        onChange={setSec}
        tabs={[
          { id: 'players', label: t('Spieler'), icon: <GameIcon name="fa_marines" size={16} /> },
          { id: 'alliances', label: t('Allianzen'), icon: <GameIcon name="em_crown" size={16} /> },
          { id: 'fleets', label: t('Flotten'), icon: <GameIcon name="ui_FLEET" size={16} /> },
          { id: 'lifecycle', label: t('Abwesenheit & Wechsel'), icon: <GameIcon name="em_moon" size={16} /> },
          { id: 'story', label: t('Ziele & Finale'), icon: <GameIcon name="ui_TROPHY" size={16} /> },
        ]}
      />
      <TabPanel idBase="people" value={sec}>
        {sec === 'alliances' && <AlliancesSection />}
        {sec === 'players' && <PlayersSection />}
        {sec === 'fleets' && <FleetsSection />}
        {sec === 'lifecycle' && <LifecycleSection />}
        {sec === 'story' && <StorySection />}
      </TabPanel>
    </div>
  );
}

export function AlliancesSection() {
  const { state } = useCmd();
  const t = useT();
  const [edit, setEdit] = useState<string | null>(null);
  const canCreate = state.stage.kind === 'SETUP' && state.stage.step === 'W0' && state.alliances.length < state.meta.allianceCount;
  return (
    <div className="@container">
      <div className="grid gap-3 @4xl:grid-cols-2">
        {state.alliances.map((a) => {
          const members = playersOfAlliance(state, a.id);
          const leader = state.players.find((p) => p.id === a.leaderPlayerId);
          const logo = uploadUrl(a.logo, true);
          return (
            <Panel
              key={a.id}
              title={<AllianceTag alliance={a} />}
              actions={
                edit !== a.id && (
                  <button className="btn btn-sm" onClick={() => setEdit(a.id)}>
                    {t('Bearbeiten')}
                  </button>
                )
              }
            >
              {edit === a.id ? (
                <AllianceEditor key={JSON.stringify(a)} alliance={a} onDone={() => setEdit(null)} />
              ) : (
                <div className="flex gap-3 text-[15px]">
                  {logo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="" className="h-16 w-16 border border-line object-cover" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div>
                      <p className="section-title">{t('Mitglieder ({n})', { n: members.length })}</p>
                      <AllianceMembers allianceId={a.id} />
                    </div>
                    <p>
                      {t('Anführer:')} {leader?.nickname ?? <span className="text-faint">–</span>}
                    </p>
                    <p>
                      {t('Flotten:')} {state.fleets.filter((f) => f.allianceId === a.id && !f.reserve).length}
                      {state.fleets.some((f) => f.allianceId === a.id && f.reserve) ? ` (${t('+{n} Reserve', { n: state.fleets.filter((f) => f.allianceId === a.id && f.reserve).length })})` : ''}
                    </p>
                    <p>
                      Stronghold:{' '}
                      {state.stage.kind === 'SETUP' && !state.setup.strongholdsRevealed ? (
                        <span className="text-faint">{t('noch nicht gebaut')}</span>
                      ) : a.strongholdDestroyed ? (
                        <span className="text-danger">{t('zerstört')}</span>
                      ) : (
                        <span className="text-ok">{t('intakt')}</span>
                      )}
                    </p>
                  </div>
                </div>
              )}
              <AllianceNotes allianceId={a.id} />
            </Panel>
          );
        })}
        {canCreate && (
          <Panel title={t('Neue Allianz')} icon={<GameIcon name="em_crown" size={18} />}>
            <AllianceEditor key={`new-${state.alliances.length}`} showLeader={false} />
          </Panel>
        )}
      </div>
    </div>
  );
}

export function PlayersSection() {
  const { state, run, campaignId } = useCmd();
  const t = useT();
  const [edit, setEdit] = useState<string | null>(null);
  // Anlegen ist eingeklappt: 'quick' = Kurzformular, 'full' = alle Angaben
  const [adding, setAdding] = useState<null | 'quick' | 'full'>(null);
  const editorRef = useRef<HTMLElement>(null);
  const aName = (id: string | null) => state.alliances.find((a) => a.id === id) ?? null;
  const editing = state.players.find((p) => p.id === edit);
  // Kontaktspalte nur, wenn überhaupt Kontaktdaten erfasst sind
  const hasContact = state.players.some((p) => p.email || p.discord);
  const open = (id: string) => {
    setEdit(id);
    setAdding(null);
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const del = (p: Player) => {
    if (confirm(t('{name} löschen? (Spieler mit Schlachten werden nur deaktiviert)', { name: p.nickname }))) run({ type: 'PLAYER_DELETE', id: p.id });
  };
  const nameCell = (p: Player) => (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar id={p.avatar} name={p.nickname} size={28} />
      <span className="min-w-0">
        <span className="font-semibold text-ink">{p.nickname}</span>
        {p.isGameMaster && <span className="chip ml-1.5">{t('SL')}</span>}
        {!p.active && <span className="chip ml-1.5">{t('inaktiv')}</span>}
      </span>
    </span>
  );
  const actions = (p: Player, wide = false) => (
    <span className={`flex gap-2 ${wide ? '' : 'justify-end'}`}>
      <button type="button" className={`btn btn-sm ${wide ? 'flex-1' : ''}`} onClick={() => open(p.id)}>
        {t('Bearbeiten')}
      </button>
      <button
        type="button"
        className={`btn btn-sm btn-ghost text-danger hover:text-[#ffd0c9] ${wide ? 'flex-1 shadow-[inset_0_0_0_1px_rgba(201,69,59,0.45)]' : ''}`}
        aria-label={t('{name} löschen', { name: p.nickname })}
        onClick={() => del(p)}
      >
        {t('Löschen')}
      </button>
    </span>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="hud-title mr-auto flex items-center gap-2.5">
          <GameIcon name="fa_marines" size={18} color="#b3975f" />
          {t('Spieler ({n})', { n: state.players.length })}
        </h2>
        <a className="btn btn-sm btn-ghost" href={`/admin/c/${campaignId}/player-links`} target="_blank" rel="noreferrer">
          {t('Spielerlinks drucken')}
        </a>
        <a className="btn btn-sm btn-ghost" href={`/admin/c/${campaignId}/player-cards`} target="_blank" rel="noreferrer">
          {t('QR-Karten')}
        </a>
        <button type="button" className="btn btn-sm btn-primary" aria-expanded={adding !== null} aria-controls="player-add" onClick={() => setAdding((a) => (a ? null : 'quick'))}>
          {adding ? t('Anlegen schließen') : t('Spieler hinzufügen')}
        </button>
      </div>

      {adding && (
        <div id="player-add" className="space-y-3 border-y border-line/60 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="section-title mb-0 flex-1">{adding === 'quick' ? t('Neuer Spieler') : t('Neuer Spieler – alle Angaben')}</p>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(adding === 'quick' ? 'full' : 'quick')}>
              {adding === 'quick' ? t('Alle Angaben erfassen') : t('Kurzformular')}
            </button>
          </div>
          {adding === 'quick' ? <QuickPlayerForm /> : <PlayerEditor key={`new-${state.players.length}`} onDone={() => setAdding(null)} />}
        </div>
      )}

      {state.players.length ? (
        <>
          {/* Desktop/Tablet: Tabelle mit einheitlich ausgerichteten Zeilenaktionen */}
          <div className="hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Spieler')}</th>
                  <th>{t('Allianz')}</th>
                  <th>{t('Fraktion')}</th>
                  {hasContact && <th>{t('Kontakt')}</th>}
                  <th className="w-px">
                    <span className="sr-only">{t('Aktionen')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.players.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'opacity-60'} data-active={edit === p.id ? 'true' : undefined}>
                    <td>{nameCell(p)}</td>
                    <td>
                      <AllianceTag alliance={aName(currentAllianceOf(p))} />
                    </td>
                    <td>
                      <FactionTag name={p.faction} />
                      {p.subfaction && <span className="text-dim"> · {p.subfaction}</span>}
                    </td>
                    {hasContact && <td className="text-[14px] text-dim">{[p.email, p.discord].filter(Boolean).join(' · ') || '–'}</td>}
                    <td className="whitespace-nowrap">{actions(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobil: kompakte Zeilenkarten, Aktionen vollständig sichtbar */}
          <ul className="divide-y divide-line/60 border-y border-line/60 md:hidden">
            {state.players.map((p) => (
              <li key={p.id} className={`space-y-2 py-3 ${p.active ? '' : 'opacity-60'}`}>
                <div className="flex items-center justify-between gap-2">
                  {nameCell(p)}
                  <AllianceTag alliance={aName(currentAllianceOf(p))} className="shrink-0" />
                </div>
                <p className="text-[15px] text-dim">
                  <FactionTag name={p.faction} />
                  {p.subfaction && <span> · {p.subfaction}</span>}
                </p>
                {(p.email || p.discord) && <p className="break-words text-[14px] text-dim">{[p.email, p.discord].filter(Boolean).join(' · ')}</p>}
                {actions(p, true)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Empty>{t('Noch keine Spieler – lege sie über „Spieler hinzufügen“ an.')}</Empty>
      )}

      {editing && (
        <section ref={editorRef} className="hud scroll-mt-2 p-3 sm:p-4" aria-label={t('Spieler bearbeiten: {name}', { name: editing.nickname })}>
          <div className="relative z-[1] mb-3 flex items-center justify-between gap-2">
            <h2 className="hud-title flex min-w-0 items-center gap-2.5">
              <GameIcon name="fa_marines" size={18} color="#b3975f" />
              <span className="min-w-0">{t('Spieler bearbeiten: {name}', { name: editing.nickname })}</span>
            </h2>
            <button type="button" className="btn btn-sm shrink-0" onClick={() => setEdit(null)} aria-label={t('Schließen')}>
              <CloseIcon />
            </button>
          </div>
          <div className="@container relative z-[1] divide-y divide-line/60 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
            <PlayerEditor key={JSON.stringify(editing)} player={editing} onDone={() => setEdit(null)} />
            <PlayerLink playerId={editing.id} />
            <CommanderEditor key={`cmd-${JSON.stringify(editing)}`} player={editing} />
            {/* P2: Bemal-Chronik (D5) */}
            <HobbyAdmin player={editing} />
            {/* P3: Order of Battle (Crusade) */}
            <CrusadeAdminSection player={editing} />
            {/* P3: Datenschutz (NTH2 6.4) */}
            <PrivacyTools player={editing} />
            <div className="grid gap-4 @2xl:grid-cols-2">
              <div>
                <p className="section-title">{t('Allianz-Historie')}</p>
                {editing.memberships.length ? (
                  <ul className="space-y-1 text-[15px]">
                    {editing.memberships.map((m, i) => (
                      <li key={i}>
                        <AllianceTag alliance={aName(m.allianceId)} />{' '}
                        <span className="text-dim">
                          – {m.fromPhase === 0 ? t('ab Setup') : t('ab Phase {n}', { n: m.fromPhase })}
                          {m.toPhase !== null ? ` ${t('bis Phase {n}', { n: m.toPhase })}` : ` ${t('(aktuell)')}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>{t('Keine Allianz-Zugehörigkeit.')}</Empty>
                )}
              </div>
              <div>
                <p className="section-title">{t('Armee-Historie')}</p>
                {editing.factionHistory?.length ? (
                  <ul className="space-y-1 text-[15px]">
                    {editing.factionHistory.map((h, i) => (
                      <li key={i}>
                        {h.faction}
                        {h.subfaction ? ` – ${h.subfaction}` : ''} <span className="text-dim">– {h.fromPhase === 0 ? t('ab Setup') : t('ab Phase {n}', { n: h.fromPhase })}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>{t('Noch keine Armee eingetragen.')}</Empty>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function currentPhaseFor(state: ReturnType<typeof useCmd>['state']): number {
  if (state.stage.kind === 'PHASE') return state.stage.phase;
  if (state.stage.kind === 'SETUP') return 1;
  return state.meta.phaseCount;
}

export function FleetsSection() {
  const { state, run } = useCmd();
  const t = useT();
  const phase = currentPhaseFor(state);
  const [names, setNames] = useState<Record<string, string>>({});
  return (
    <div className="@container">
      <div className="grid gap-3 @4xl:grid-cols-2">
        {state.alliances.map((a) => {
          const fleets = state.fleets.filter((f) => f.allianceId === a.id);
          const players = playersOfAlliance(state, a.id, phase);
          return (
            <Panel key={a.id} title={<AllianceTag alliance={a} />}>
              <div className="mb-3">
                <FleetCountControl key={`${a.id}-${fleets.length}`} allianceId={a.id} />
                <div className="mt-2">
                  <ReserveControl key={`r-${a.id}-${fleets.length}-${fleets.filter((f) => f.reserve).length}`} allianceId={a.id} />
                </div>
              </div>
              {fleets.length ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('Flotte')}</th>
                      <th>{t('Position')}</th>
                      <th>{t('Kommandant Ph. {n}', { n: phase })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fleets.map((f) => {
                      const cmdId = f.commanders[String(phase)] ?? '';
                      const cmdPlayer = state.players.find((p) => p.id === cmdId);
                      const nm = names[f.id] ?? f.name;
                      return (
                        <tr key={f.id}>
                          <td>
                            <div className="flex gap-1">
                              <input
                                className="input min-w-28"
                                value={nm}
                                onChange={(e) =>
                                  setNames((x) => ({
                                    ...x,
                                    [f.id]: e.target.value,
                                  }))
                                }
                                aria-label={t('Flottenname')}
                              />
                              {nm !== f.name && (
                                <button
                                  className="btn btn-sm"
                                  onClick={async () => {
                                    if (
                                      await run({
                                        type: 'FLEET_UPDATE',
                                        id: f.id,
                                        name: nm,
                                      })
                                    )
                                      setNames((x) => {
                                        const n = { ...x };
                                        delete n[f.id];
                                        return n;
                                      });
                                  }}
                                >
                                  {t('Speichern')}
                                </button>
                              )}
                            </div>
                          </td>
                          <td>
                            {f.reserve ? (
                              state.stage.kind === 'PHASE' ? (
                                <PlanetSelect
                                  value=""
                                  placeholder={t('– Reserve aktivieren –')}
                                  className="w-auto"
                                  options={reserveTargets(state, a.id)}
                                  onChange={(pid) =>
                                    pid &&
                                    run({
                                      type: 'FLEET_ACTIVATE',
                                      fleetId: f.id,
                                      planetId: pid,
                                    })
                                  }
                                />
                              ) : (
                                <span className="text-faint">{t('Reserve')}</span>
                              )
                            ) : f.planetId ? (
                              planetName(f.planetId)
                            ) : state.stage.kind !== 'SETUP' || state.setup.fleetsRevealed ? (
                              <PlanetSelect
                                value=""
                                placeholder={t('– platzieren –')}
                                className="w-auto"
                                onChange={(pid) =>
                                  pid &&
                                  run({
                                    type: 'FLEET_PLACE',
                                    fleetId: f.id,
                                    planetId: pid,
                                  })
                                }
                              />
                            ) : (
                              <span className="text-faint">–</span>
                            )}
                          </td>
                          <td>
                            <select
                              className="select"
                              value={cmdId}
                              aria-label={t('Kommandant {name}', {
                                name: f.name,
                              })}
                              onChange={(e) =>
                                run({
                                  type: 'FLEET_COMMANDER',
                                  fleetId: f.id,
                                  phase,
                                  playerId: e.target.value || null,
                                })
                              }
                            >
                              <option value="">{t('– keiner –')}</option>
                              {players.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.nickname}
                                </option>
                              ))}
                              {cmdPlayer && allianceOf(cmdPlayer, phase) !== a.id && (
                                <option value={cmdPlayer.id}>
                                  {t('{name} (andere Allianz)', {
                                    name: cmdPlayer.nickname,
                                  })}
                                </option>
                              )}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <Empty>{t('Keine Flotten.')}</Empty>
              )}
            </Panel>
          );
        })}
        {!state.alliances.length && <Empty>{t('Noch keine Allianzen.')}</Empty>}
      </div>
    </div>
  );
}

/** Allianz-Notizen (N1.3): nur für die Allianz sichtbar; der Warmaster liest mit und darf löschen */
function AllianceNotes({ allianceId }: { allianceId: string }) {
  const { state, run, busy } = useCmd();
  const [text, setText] = useState('');
  const t = useT();
  const intl = useIntlLocale();
  const notes = (state.allianceNotes ?? []).filter((n) => n.allianceId === allianceId).sort((a, b) => b.at.localeCompare(a.at));
  return (
    <details className="fold mt-3 border-t border-[#665333]/40 pt-1 text-[15px]">
      <summary>{t('Allianz-Notizen ({n})', { n: notes.length })}</summary>
      <div className="mt-2 flex gap-2">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Nachricht an die Allianz')} aria-label={t('Nachricht an die Allianz')} />
        <button
          className="btn btn-sm"
          disabled={busy || !text.trim()}
          onClick={async () =>
            (await run({
              type: 'NOTE_ADD',
              allianceId,
              playerId: null,
              text,
            })) && setText('')
          }
        >
          {t('Posten')}
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {notes.map((n) => (
          <li key={n.id} className="border-l-2 border-line pl-2">
            <span className="whitespace-pre-wrap">{n.text}</span>
            <span className="block text-[13px] text-faint">
              {n.playerId ? (state.players.find((p) => p.id === n.playerId)?.nickname ?? '?') : t('Warmaster')} ·{' '}
              {new Date(n.at).toLocaleString(intl, {
                timeZone: state.meta.timezone,
                dateStyle: 'short',
                timeStyle: 'short',
              })}
              <button className="btn btn-sm btn-ghost ml-2 min-h-7 px-1.5" disabled={busy} onClick={() => run({ type: 'NOTE_DELETE', id: n.id })}>
                {t('löschen')}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
