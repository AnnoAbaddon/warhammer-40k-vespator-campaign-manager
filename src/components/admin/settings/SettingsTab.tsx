'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { campaignAdminAction } from '@/app/actions/campaign';
import { ATTACK_TYPES, EVENTS, type AttackType, type EventCode } from '@/engine/data/vespator';
import type { RuleToggles } from '@/engine/types';
import { Field, Panel, TabPanel, Tabs } from '@/components/ui';
import { BookIcon, ExternalIcon, NoteIcon, PrintIcon, SaveIcon, WarnIcon } from '@/components/icons';
import { GameIcon } from '@/components/icons/GameIcon';
import { useCmd } from '../CommandProvider';
import type { CampaignInfo } from '../types';
import { CopyField } from './CopyField';
import { HOUSE_RULES } from '@/engine/houseRules';
import { EditionPanel } from './EditionPanel';
import { SandboxPanel } from '../gm/SandboxTools';
import { TemplatePanel } from '../gm/TemplatePanel';
import { CustomEventsPanel } from '../gm/CustomEventsPanel';
import { R1HouseRules } from './R1HouseRules';
import { R2Rules } from './R2Rules';
import { CrusadeRulesPanel } from '@/components/crusade/CrusadeRules';
import { MissionPoolPanel } from './MissionPoolPanel';
import { useIntlLocale, useMsg, useT } from '@/i18n/client';
import { BackupPanel, NotifyPanel } from './OpsPanels';
import { LOCALES, LOCALE_NAMES, toLocale } from '@/i18n/core';

/** Download-Link des Phasenberichts; die Sprache kommt nur aus der festen Liste (keine freien Werte in der URL) */
function reportHref(campaignId: string, phase: number, lang: string): string {
  const q = new URLSearchParams({ download: '1' });
  if (lang === 'both' || (LOCALES as readonly string[]).includes(lang)) q.set('lang', lang);
  return `/api/c/${encodeURIComponent(campaignId)}/report/${encodeURIComponent(String(phase))}?${q}`;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-8 items-center gap-2.5 text-[15px]">
      <input type="checkbox" className="h-4 w-4 shrink-0 accent-[#dda94d]" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function SettingsTab({ info }: { info: CampaignInfo }) {
  const { state, run, busy, campaignId, toast } = useCmd();
  const router = useRouter();
  const t = useT();
  const msg = useMsg();
  const intl = useIntlLocale();
  const [tog, setTog] = useState<RuleToggles>(structuredClone(state.toggles));
  const [name, setName] = useState(state.meta.name);
  const [pending, start] = useTransition();
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [delName, setDelName] = useState('');
  // Löschbestätigung erscheint erst nach bewusster Wahl
  const [delOpen, setDelOpen] = useState(false);
  const [reportPhase, setReportPhase] = useState<number>(state.phases.at(-1)?.number ?? 1);
  const [report, setReport] = useState<string | null>(null);
  const [reportLang, setReportLang] = useState('');
  const dirty = JSON.stringify(tog) !== JSON.stringify(state.toggles);
  const [sec, setSec] = useState<'campaign' | 'rules' | 'notify' | 'export'>('campaign');

  const admin = (action: Parameters<typeof campaignAdminAction>[1], confirmName?: string) =>
    start(async () => {
      const r = await campaignAdminAction(campaignId, action, confirmName);
      if (r && !r.ok) toast('error', r.error ? msg(r.error) : t('Fehler'));
      else {
        toast('ok', t('Gespeichert'));
        router.refresh();
      }
    });

  const set = (fn: (d: RuleToggles) => void) =>
    setTog((cur) => {
      const n = structuredClone(cur);
      fn(n);
      return n;
    });

  const loadReport = async () => {
    const r = await fetch(`/api/c/${campaignId}/report/${reportPhase}${reportLang ? `?lang=${reportLang}` : ''}`);
    setReport(r.ok ? await r.text() : t('Fehler {status}', { status: r.status }));
  };

  return (
    <div className="space-y-3">
      <Tabs
        sticky
        idBase="settings"
        label={t('Einstellungen')}
        value={sec}
        onChange={setSec}
        tabs={[
          { id: 'campaign', label: t('Kampagne'), icon: <GameIcon name="ui_PLANET" size={16} /> },
          { id: 'rules', label: t('Regeln'), icon: <BookIcon size={16} />, badge: dirty ? 1 : undefined },
          { id: 'notify', label: t('Dienste'), icon: <NoteIcon size={16} /> },
          { id: 'export', label: 'Export', icon: <SaveIcon size={16} /> },
        ]}
      />
      <TabPanel idBase="settings" value={sec}>
        {sec === 'campaign' && (
          <div className="space-y-5">
            <div className="grid items-start gap-x-8 gap-y-5 2xl:grid-cols-2">
              <section className="space-y-3" aria-labelledby="set-campaign">
                <p id="set-campaign" className="section-title">
                  {t('Kampagne')}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Field label={t('Kampagnenname')}>
                      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                    </Field>
                  </div>
                  <button className="btn shrink-0 self-start sm:self-auto" disabled={busy || !name.trim() || name === state.meta.name} onClick={() => run({ type: 'META_UPDATE', name })}>
                    {t('Umbenennen')}
                  </button>
                </div>
                <p className="readout">
                  {t('{a} Allianzen · {p} Phasen (fix) · angelegt {date}', { a: state.meta.allianceCount, p: state.meta.phaseCount, date: new Date(state.meta.createdAt).toLocaleDateString(intl) })}
                </p>
                <Field label={t('Standardsprache (Leseansicht und Spielerseiten)')}>
                  <select className="select sm:w-44" value={state.meta.locale ?? 'de'} disabled={busy} onChange={(e) => run({ type: 'META_UPDATE', locale: toLocale(e.target.value) })}>
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {LOCALE_NAMES[l]}
                      </option>
                    ))}
                  </select>
                </Field>
              </section>

              <section className="space-y-3 border-t border-line/60 pt-4 2xl:border-t-0 2xl:pt-0" aria-labelledby="set-public">
                <p id="set-public" className="section-title">
                  {t('Öffentlicher Link')}
                </p>
                <p className="flex items-center gap-2 text-[15px]">
                  <span aria-hidden className={`lamp ${info.publicEnabled ? 'lamp-ok' : 'lamp-alert'}`} />
                  {info.publicEnabled ? (
                    <span>
                      <span className="text-ok">{t('aktiv')}</span> – {t('Leseansicht für alle mit dem Link')}
                    </span>
                  ) : (
                    <span>
                      <span className="text-danger">{t('deaktiviert')}</span> – {t('der Link zeigt nichts an')}
                    </span>
                  )}
                </p>
                <CopyField value={info.publicUrl} label={t('Link zur Leseansicht')} masked />
                <div className="flex flex-wrap gap-2">
                  {info.publicEnabled ? (
                    <>
                      <a className="btn btn-sm" href={info.publicUrl} target="_blank" rel="noreferrer">
                        {t('Öffnen')} <ExternalIcon />
                        <span className="sr-only">{t('(öffnet in neuem Tab)')}</span>
                      </a>
                      <button className="btn btn-sm" disabled={pending} onClick={() => admin('public-off')}>
                        {t('Deaktivieren')}
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => admin('public-on')}>
                      {t('Aktivieren')}
                    </button>
                  )}
                  {confirmRegen ? (
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={pending}
                      onClick={() => {
                        setConfirmRegen(false);
                        admin('regenerate-token');
                      }}
                    >
                      {t('Wirklich? Alter Link wird ungültig')}
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => setConfirmRegen(true)}>
                      {t('Neu erzeugen')}
                    </button>
                  )}
                </div>
                {info.publicEnabled && (
                  <details className="fold">
                    <summary>{t('QR-Code anzeigen')}</summary>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/c/${campaignId}/qr.svg?v=${encodeURIComponent(info.publicUrl.slice(-8))}`}
                      alt={t('QR-Code des öffentlichen Links')}
                      width={180}
                      height={180}
                      className="mt-1 border border-line bg-white"
                    />
                  </details>
                )}
                <p className="text-[14px] text-dim">{t('Die Leseansicht ist für Suchmaschinen gesperrt (noindex) und zeigt keine Kontaktdaten und keine verdeckten Befehle.')}</p>
              </section>
            </div>

            {/* Gefahrenbereich: nachgeordnet und eingeklappt; das Bestätigungsfeld erscheint erst nach bewusster Wahl */}
            <details className="fold border-t border-line/60 pt-2" aria-label={t('Archiv & Löschen')}>
              <summary>
                <WarnIcon size={16} className="text-warn" /> {t('Archivieren oder löschen')}
              </summary>
              <div className="mt-2 space-y-4 pl-1">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {info.archived ? (
                    <button className="btn btn-sm self-start" disabled={pending} onClick={() => admin('unarchive')}>
                      {t('Aus dem Archiv holen')}
                    </button>
                  ) : (
                    <button className="btn btn-sm self-start" disabled={pending} onClick={() => admin('archive')}>
                      {t('Archivieren (schreibgeschützt)')}
                    </button>
                  )}
                  <span className="text-[14px] text-dim">{t('Archivierte Kampagnen bleiben lesbar und lassen sich jederzeit zurückholen.')}</span>
                </div>
                {!delOpen ? (
                  <button className="btn btn-sm btn-danger" onClick={() => setDelOpen(true)}>
                    {t('Kampagne endgültig löschen …')}
                  </button>
                ) : (
                  <div className="notice notice-danger flex-col items-stretch gap-2">
                    <p className="font-semibold">{t('Kampagne endgültig löschen')}</p>
                    <p className="text-[14px] text-dim">{t('Zur Bestätigung den Namen eingeben: „{name}“', { name: state.meta.name })}</p>
                    <input className="input" value={delName} onChange={(e) => setDelName(e.target.value)} aria-label={t('Name zur Bestätigung')} />
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-sm btn-danger" disabled={pending || delName !== state.meta.name} onClick={() => admin('delete', delName)}>
                        {t('Endgültig löschen')}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setDelOpen(false);
                          setDelName('');
                        }}
                      >
                        {t('Abbrechen')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </details>
            {/* R3: Szenario-Sandbox (NTH2 2.1) und Kampagnen-Vorlage (NTH2 2.6) */}
            <div className="grid items-start gap-4 2xl:grid-cols-2">
              <SandboxPanel info={info} />
              <TemplatePanel info={info} />
            </div>
          </div>
        )}

        {sec === 'rules' && (
          <div className="grid items-start gap-4 2xl:grid-cols-2">
            <Panel title={t('Regel-Schalter')} icon={<GameIcon name="ui_COG" size={18} />}>
              {state.stage.kind !== 'SETUP' && <p className="notice mb-3">{t('Die Kampagne läuft bereits – Änderungen werden mit Warnung geloggt und gelten ab der nächsten Aktion.')}</p>}
              <div className="grid gap-4 @lg:grid-cols-2">
                <div className="space-y-1">
                  <p className="section-title">Events</p>
                  <Check label="Fortunes of War" checked={tog.events.fortunesOfWar} onChange={(v) => set((d) => void (d.events.fortunesOfWar = v))} />
                  <Check label="Perils of Power" checked={tog.events.perilsOfPower} onChange={(v) => set((d) => void (d.events.perilsOfPower = v))} />
                  <Check label="Desperate Measures" checked={tog.events.desperateMeasures} onChange={(v) => set((d) => void (d.events.desperateMeasures = v))} />
                  <p className="section-title mt-3">{t('Sonstiges')}</p>
                  <Check label="Theatres & Twists" checked={tog.theatreTwists} onChange={(v) => set((d) => void (d.theatreTwists = v))} />
                  <Check label="Campaign Medals" checked={tog.medals} onChange={(v) => set((d) => void (d.medals = v))} />
                  <div className="pt-2">
                    <Field label={t('Start-Infrastruktur je Allianz')}>
                      <input className="input w-24" type="number" min={0} max={10} value={tog.setupInfraCount} onChange={(e) => set((d) => void (d.setupInfraCount = Math.max(0, Number(e.target.value))))} />
                    </Field>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="section-title">{t('Operationen')}</p>
                  <Check label="Void Leap" checked={tog.operations.voidLeap} onChange={(v) => set((d) => void (d.operations.voidLeap = v))} />
                  <Check label="Raise Edifices" checked={tog.operations.raiseEdifices} onChange={(v) => set((d) => void (d.operations.raiseEdifices = v))} />
                  <Check label="Logistical Auxilia" checked={tog.operations.logisticalAuxilia} onChange={(v) => set((d) => void (d.operations.logisticalAuxilia = v))} />
                  <Check label="Deploy Kill Teams" checked={tog.operations.killTeams} onChange={(v) => set((d) => void (d.operations.killTeams = v))} />
                  <p className="section-title mt-3">Campaign Attack Types</p>
                  {(Object.keys(ATTACK_TYPES) as AttackType[]).map((a) => (
                    <Check key={a} label={ATTACK_TYPES[a].name} checked={tog.operations.attackTypes[a]} onChange={(v) => set((d) => void (d.operations.attackTypes[a] = v))} />
                  ))}
                </div>
              </div>
              <details className="fold mt-3">
                <summary>{t('Einzelne Events deaktivieren ({n})', { n: tog.events.disabled.length })}</summary>
                <div className="mt-2 grid gap-1 @lg:grid-cols-2">
                  {(Object.keys(EVENTS) as EventCode[]).map((c) => (
                    <Check
                      key={c}
                      label={`${EVENTS[c].name} (${c.replace('_', ' ')})`}
                      checked={!tog.events.disabled.includes(c)}
                      onChange={(v) => set((d) => void (d.events.disabled = v ? d.events.disabled.filter((x) => x !== c) : [...d.events.disabled, c]))}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[13px] text-faint">{t('Ein deaktiviertes Event wird beim Würfeln neu gewürfelt.')}</p>
              </details>
              <div className="mt-3 space-y-1">
                <p className="section-title">{t('Andere Spielsysteme')}</p>
                <Check
                  label={t('Void-Leap-Abfangen: gegnerische Flotte am Ziel kann ein Abfanggefecht (z. B. Raumkampf) erzwingen')}
                  checked={tog.voidLeapIntercept ?? false}
                  onChange={(v) => set((d) => void (d.voidLeapIntercept = v))}
                />
              </div>
              <div className="mt-3 space-y-1">
                <p className="section-title">{t('Spiellast (nur Warnungen)')}</p>
                <label className="flex flex-wrap items-center gap-2 text-[15px]">
                  {t('Höchstens')}
                  <input
                    className="input w-20"
                    type="number"
                    min={0}
                    value={tog.load?.maxPerPlayer ?? ''}
                    placeholder={t('aus')}
                    onChange={(e) => set((d) => void (d.load = { minOnePerAlliance: false, ...d.load, maxPerPlayer: e.target.value ? Math.max(1, Number(e.target.value)) : null }))}
                    aria-label={t('Höchstzahl Schlachten je Spieler und Phase')}
                  />
                  {t('Schlachten je Spieler und Phase')}
                </label>
                <Check
                  label={t('Mindestens eine Battle Operation je Allianz und Phase')}
                  checked={tog.load?.minOnePerAlliance ?? false}
                  onChange={(v) => set((d) => void (d.load = { maxPerPlayer: null, ...d.load, minOnePerAlliance: v }))}
                />
              </div>
              <R1HouseRules tog={tog} set={set} />
              <R2Rules tog={tog} set={set} />
              <CrusadeRulesPanel tog={tog} set={set} />
              <div className="mt-3">
                <p className="section-title">{t('Letzte Phase (Hausregeln)')}</p>
                {(
                  [
                    ['mandatoryBattle', 'Pflichtschlacht: Warnung, wenn eine Allianz keine Battle Operation erklärt'],
                    ['doubleGains', 'Doppelte PL-Gewinne des Siegers aus Campaign Outcomes (+1 → +2, höchstens 4)'],
                    ['noVoidLeap', 'Kein Void Leap in der letzten Phase'],
                  ] as const
                ).map(([k, label]) => (
                  <Check
                    key={k}
                    label={t(label)}
                    checked={tog.lastPhase?.[k] ?? false}
                    onChange={(v) => set((d) => void (d.lastPhase = { mandatoryBattle: false, doubleGains: false, noVoidLeap: false, ...d.lastPhase, [k]: v }))}
                  />
                ))}
              </div>
              <details className="fold mt-3" open={Object.values(tog.houseRules ?? {}).some(Boolean)}>
                <summary>{t('Hausregeln zu FAQ-Entscheidungen ({n} abweichend)', { n: Object.values(tog.houseRules ?? {}).filter(Boolean).length })}</summary>
                <p className="mt-2 text-[13px] text-faint">{t('Standard ist jeweils unsere FAQ-Entscheidung. Ein Haken aktiviert die Alternative; sie erscheint dann auf der Regeln-Seite und im FAQ der Leseansicht.')}</p>
                <ul className="mt-2 space-y-2">
                  {HOUSE_RULES.map((r) => {
                    const alt = tog.houseRules?.[r.id] === true;
                    return (
                      <li key={r.id} className="border-l-2 pl-3" style={{ borderColor: alt ? '#e0b95c' : '#4a3a22' }}>
                        <label className="flex items-start gap-2 text-[15px]">
                          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#dda94d]" checked={alt} onChange={(e) => set((d) => void (d.houseRules = { ...d.houseRules, [r.id]: e.target.checked }))} />
                          <span>
                            <b>{r.faq}</b> {msg(r.title)}
                            <span className="block text-[13px] text-dim">
                              {t('Standard:')} {msg(r.standard)}
                              <br />
                              {t('Alternative:')} {msg(r.alternative)}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </details>
              <div className="mt-3 flex justify-end gap-2">
                <button className="btn btn-sm" disabled={!dirty} onClick={() => setTog(structuredClone(state.toggles))}>
                  {t('Zurücksetzen')}
                </button>
                <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => run({ type: 'TOGGLES_UPDATE', toggles: tog })}>
                  <SaveIcon /> {t('Schalter speichern')}
                </button>
              </div>
            </Panel>
            <EditionPanel />
            <MissionPoolPanel />
            <CustomEventsPanel />
          </div>
        )}

        {sec === 'notify' && (
          <div className="grid items-start gap-4 2xl:grid-cols-2">
            <NotifyPanel info={info} />
            <BackupPanel info={info} />
          </div>
        )}

        {sec === 'export' && (
          <Panel title="Export" icon={<SaveIcon size={18} />}>
            <p className="section-title">{t('Backups')}</p>
            <div className="flex flex-wrap gap-2">
              <a className="btn btn-sm btn-primary" href={`/api/c/${campaignId}/export?zip=1`}>
                {t('Komplett-Backup (ZIP inkl. Bilder)')}
              </a>
              <a className="btn btn-sm" href={`/api/c/${campaignId}/export`}>
                {t('JSON-Backup')}
              </a>
              <a className="btn btn-sm" href={`/api/c/${campaignId}/export?revisions=0`}>
                {t('JSON (nur Stand)')}
              </a>
            </div>
            <p className="mt-2 text-[14px] text-faint">{t('Zusätzlich zu den automatischen Backups nach jedem Phasenabschluss ein Backup herunterladen.')}</p>
            <p className="section-title mt-4">{t('Karte, Druck und Präsentation')}</p>
            <div className="flex flex-wrap gap-2">
              <a className="btn btn-sm" href={`/api/c/${campaignId}/map.png`} target="_blank" rel="noreferrer">
                {t('Karte PNG')}
              </a>
              <a className="btn btn-sm" href={`/api/c/${campaignId}/map.png?format=svg`}>
                {t('Karte SVG')}
              </a>
              <a className="btn btn-sm" href={`/admin/c/${campaignId}/print`} target="_blank" rel="noreferrer">
                <PrintIcon /> {t('Druckansicht')}
              </a>
              <a className="btn btn-sm" href={`/admin/c/${campaignId}/sheets/orders`} target="_blank" rel="noreferrer">
                <PrintIcon /> {t('Druckbögen')}
              </a>
              <a className="btn btn-sm" href={`/admin/c/${campaignId}/codex`} target="_blank" rel="noreferrer">
                Codex
              </a>
              <a className="btn btn-sm" href={`/admin/c/${campaignId}/zeitraffer`} target="_blank" rel="noreferrer">
                {t('Zeitraffer')}
              </a>
              {info.publicEnabled && (
                <a className="btn btn-sm" href={`${info.publicUrl}/present`} target="_blank" rel="noreferrer">
                  {t('Präsentation')}
                </a>
              )}
            </div>
            <div className="mt-4 border-t border-line/60 pt-3">
              <p className="section-title">{t('Phasenbericht (Markdown für Discord/WhatsApp)')}</p>
              <div className="flex flex-wrap gap-2">
                <select className="select w-40" value={reportPhase} aria-label={t('Phase')} onChange={(e) => setReportPhase(Number(e.target.value))}>
                  {state.phases.map((p) => (
                    <option key={p.number} value={p.number}>
                      {t('Phase {n}', { n: p.number })}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" disabled={!state.phases.length} onClick={loadReport}>
                  {t('Erzeugen')}
                </button>
                {/* NTH2 7.4: Sprache des Berichts – Kampagne, eine Sprache oder beide nacheinander */}
                <select className="select w-auto" value={reportLang} aria-label={t('Sprache des Berichts')} onChange={(e) => setReportLang(e.target.value)}>
                  <option value="">{t('Sprache der Kampagne')}</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                  <option value="both">{t('beide Sprachen')}</option>
                </select>
                <a className="btn btn-sm" href={reportHref(campaignId, reportPhase, reportLang)}>
                  {t('Download .md')}
                </a>
              </div>
              {report !== null && (
                <div className="mt-2">
                  <textarea className="textarea font-mono text-[13px]" rows={12} readOnly value={report} aria-label={t('Bericht')} />
                  <button
                    className="btn btn-sm mt-1"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(report);
                        toast('ok', t('Bericht kopiert'));
                      } catch {
                        toast('error', t('Kopieren nicht möglich – bitte manuell markieren'));
                      }
                    }}
                  >
                    {t('Kopieren')}
                  </button>
                </div>
              )}
            </div>
          </Panel>
        )}
      </TabPanel>
    </div>
  );
}
