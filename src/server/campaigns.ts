import 'server-only';
import { dropPendingForRevision, notifyChange } from './notify';
import crypto from 'node:crypto';
import { db, defaultLocale, tx } from './db';
import { executeCommand, isOverrideCommand, type Command, type ExecResult } from '@/engine/commands';
import { parseCommand } from '@/engine/commandSchema';
import { stageDeadline, type StageDeadline } from '@/engine/deadlines';
import { backupCampaign } from './autoBackup';
import { purgeCampaignData } from './cleanup';
import { tableCommandError, tableStateError } from './club';
import { uploadRefError, type CommandActor } from './uploadGuard';
import { isSingleEmail } from './actionInput';
import { revokePlayerAccess } from './players';
import { makeT } from '@/i18n/core';
import { recordError } from './health';
import { createCampaignState, defaultToggles } from '@/engine/init';
import { adoptImportedMap, migrateState } from '@/engine/migrate';
import { validateState } from '@/engine/schema';
import type { CampaignState } from '@/engine/types';
import type { MapDef } from '@/engine/map';
import { applyTemplate, templateMap, type CampaignTemplateData } from '@/engine/campaignTemplate';

export interface CampaignRow {
  id: string;
  name: string;
  archived: number;
  public_token: string;
  public_enabled: number;
  current_rev: number;
  previous_campaign_id: string | null;
  /** Szenario-Sandbox (NTH2 2.1): ID der Originalkampagne, sonst null */
  sandbox_of?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  number: number;
  parent_number: number | null;
  command: string;
  summary: string;
  log: string;
  is_override: number;
  reason: string | null;
  undone: number;
  created_at: string;
  author: string | null;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
const newId = () => crypto.randomBytes(9).toString('base64url');

/** Eintrag der Kampagnenliste; deadline = Frist passend zum laufenden Schritt (B10) */
export type CampaignListEntry = CampaignRow & { state: CampaignState; broken?: string; deadline: StageDeadline | null };

export function listCampaigns(): CampaignListEntry[] {
  // Sandboxes (NTH2 2.1) erscheinen nur bei ihrer Originalkampagne
  const rows = db().prepare('SELECT * FROM campaign WHERE sandbox_of IS NULL ORDER BY archived, updated_at DESC').all() as unknown as CampaignRow[];
  // Validiert wird beim Schreiben (Import, Commands). Hier nur robust laden: defekte Kampagnen
  // bleiben sichtbar (markiert), damit sie geöffnet, exportiert oder gelöscht werden können.
  const out: CampaignListEntry[] = [];
  for (const r of rows) {
    try {
      const state = loadState(r.id, r.current_rev);
      if (!state?.stage?.kind || !Array.isArray(state.alliances)) throw new Error('Zustand unvollständig');
      out.push({ ...r, state, deadline: stageDeadline(state) });
    } catch (e) {
      const fallback = createCampaignState({ name: r.name, phaseCount: 1, allianceCount: 3 });
      out.push({ ...r, state: fallback, broken: e instanceof Error ? e.message : String(e), deadline: null });
    }
  }
  return out;
}

export function getCampaign(id: string): CampaignRow | null {
  return (db().prepare('SELECT * FROM campaign WHERE id = ?').get(id) as unknown as CampaignRow) ?? null;
}

export function getCampaignByToken(token: string): CampaignRow | null {
  if (!token || token.length < 20) return null;
  const row = db().prepare('SELECT * FROM campaign WHERE public_token = ?').get(token) as unknown as CampaignRow | undefined;
  if (!row || !row.public_enabled) return null;
  // Vergleich in konstanter Zeit
  const a = Buffer.from(row.public_token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

export function loadState(campaignId: string, rev: number): CampaignState {
  const r = db().prepare('SELECT state FROM revision WHERE campaign_id = ? AND number = ?').get(campaignId, rev) as { state: string } | undefined;
  if (!r) throw new Error('Revision nicht gefunden');
  return migrateState(JSON.parse(r.state));
}

export function currentState(campaignId: string): { row: CampaignRow; state: CampaignState } {
  const row = getCampaign(campaignId);
  if (!row) throw new Error('Kampagne nicht gefunden');
  return { row, state: loadState(campaignId, row.current_rev) };
}

function insertRevision(
  campaignId: string,
  number: number,
  parent: number | null,
  command: unknown,
  state: CampaignState,
  summary: string,
  log: string[],
  isOverride: boolean,
  reason: string | null,
  author: string | null = null,
) {
  db()
    .prepare('INSERT INTO revision(campaign_id, number, parent_number, command, state, summary, log, is_override, reason, created_at, author) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(campaignId, number, parent, JSON.stringify(command), JSON.stringify(state), summary, JSON.stringify(log), isOverride ? 1 : 0, reason, new Date().toISOString(), author);
}

export function createCampaign(opts: {
  name: string;
  intro: string;
  phaseCount: number;
  allianceCount: 2 | 3;
  previousCampaignId?: string | null;
  map?: MapDef;
  author?: string | null;
  /** Kampagnen-Vorlage (NTH2 2.6) */
  template?: CampaignTemplateData | null;
}): string {
  const id = newId();
  const tplMap = opts.template ? templateMap(opts.template) : null;
  let state = createCampaignState({
    name: opts.name,
    intro: opts.intro,
    phaseCount: opts.phaseCount,
    allianceCount: opts.allianceCount,
    toggles: defaultToggles(opts.allianceCount),
    map: tplMap?.map ?? opts.map,
    locale: defaultLocale() ?? undefined,
  });
  const log = ['Kampagne angelegt'];
  if (opts.template && tplMap) {
    state = applyTemplate(state, opts.template, tplMap.rename, new Date().toISOString(), (p) => `${p}_${newId()}`);
    log.push('Vorlage übernommen: Regeln, Karte, Missionen, Spielgrößen, Rhythmus und Texte');
  }
  if (opts.previousCampaignId) {
    const prev = currentState(opts.previousCampaignId).state;
    const map: Record<string, string> = {};
    for (const p of prev.players) {
      const nid = 'pl_' + newId();
      map[p.id] = nid;
      state.players.push({ ...structuredClone(p), id: nid, memberships: [], active: p.active, factionHistory: p.faction ? [{ faction: p.faction, subfaction: p.subfaction ?? '', fromPhase: 0 }] : [] });
    }
    if (prev.toggles.medals && prev.stage.kind === 'ENDED') {
      for (const m of prev.medals) {
        state.inheritedMedals.push({ medal: m.medal, fromCampaignId: opts.previousCampaignId, holderPlayerIds: m.playerIds.map((x) => map[x]).filter(Boolean), assignedAllianceId: undefined });
      }
    }
    log.push(`${prev.players.length} Spieler und ${state.inheritedMedals.length} Medaillen aus „${prev.meta.name}“ übernommen`);
  }
  const now = new Date().toISOString();
  tx(() => {
    db()
      .prepare('INSERT INTO campaign(id, name, public_token, current_rev, previous_campaign_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, opts.name, newToken(), 1, opts.previousCampaignId ?? null, now, now);
    insertRevision(id, 1, null, { type: 'CREATE' }, state, log[0], log, false, null, opts.author ?? null);
  });
  return id;
}

/** Prüft einen importierten Zustand und bereitet ihn auf (wirft bei ungültigen Daten). */
export function prepareImportedState(state: unknown, name?: string): CampaignState {
  // Karte erst nach der Prüfung registrieren (abgelehnter Import lässt die Registry unberührt), Konflikte forken
  const s = migrateState(state, { register: false });
  const err = validateState(s);
  if (err) throw new Error(`Ungültiges Backup – ${err}`);
  adoptImportedMap(s);
  if (name) s.meta.name = name;
  return s;
}

/** Historie aus einem Backup (N5.1): alle Revisionen mit Zustand, der aktive Stand und die Phasen-Snapshots */
export interface ImportedHistory {
  current: number;
  revisions: {
    number: number;
    parent: number | null;
    command: unknown;
    state: CampaignState;
    summary: string;
    log: string[];
    isOverride: boolean;
    reason: string | null;
    undone: boolean;
    createdAt: string;
    author: string | null;
  }[];
  snapshots: { phase: number; revision: number }[];
}

/** Prüft die Struktur einer importierten Historie (Nummern eindeutig, Eltern und Snapshots vorhanden); liefert einen Fehlertext oder null */
export function checkImportedHistory(h: ImportedHistory): string | null {
  const nums = new Set<number>();
  for (const r of h.revisions) {
    if (!Number.isInteger(r.number) || r.number < 1 || nums.has(r.number)) return 'Revisionsnummern ungültig';
    nums.add(r.number);
  }
  for (const r of h.revisions) if (r.parent !== null && (!nums.has(r.parent) || r.parent >= r.number)) return 'Revisionskette ungültig';
  if (!nums.has(h.current)) return 'Aktuelle Revision fehlt';
  for (const x of h.snapshots) if (!Number.isInteger(x.phase) || !nums.has(x.revision)) return 'Snapshots ungültig';
  return null;
}

/**
 * Legt eine importierte Kampagne an – ohne eigene Transaktion (für zusammengesetzte Importe).
 * Mit Historie werden alle Revisionen unter der neuen Kampagnen-ID übernommen (Codex und Zeitraffer
 * behalten ihre Bilder); der Import selbst ist dann eine weitere Revision auf dem aktiven Stand.
 */
export function insertImportedCampaign(s: CampaignState, id = newId(), history: ImportedHistory | null = null, author: string | null = null, note: string | null = null): string {
  const now = new Date().toISOString();
  const log = ['Kampagne aus Backup importiert', ...(note ? [note] : [])];
  if (!history) {
    db().prepare('INSERT INTO campaign(id, name, public_token, current_rev, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(id, s.meta.name, newToken(), 1, now, now);
    insertRevision(id, 1, null, { type: 'IMPORT' }, s, 'Kampagne importiert', log, false, null, author);
    return id;
  }
  const err = checkImportedHistory(history);
  if (err) throw new Error(`Ungültiges Backup – ${err}`);
  const head = Math.max(...history.revisions.map((r) => r.number)) + 1;
  db().prepare('INSERT INTO campaign(id, name, public_token, current_rev, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(id, s.meta.name, newToken(), head, now, now);
  const ins = db().prepare('INSERT INTO revision(campaign_id, number, parent_number, command, state, summary, log, is_override, reason, undone, created_at, author) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of history.revisions) {
    ins.run(id, r.number, r.parent, JSON.stringify(r.command ?? null), JSON.stringify(r.state), r.summary, JSON.stringify(r.log), r.isOverride ? 1 : 0, r.reason, r.undone ? 1 : 0, r.createdAt, r.author);
  }
  insertRevision(id, head, history.current, { type: 'IMPORT' }, s, 'Kampagne importiert', log, false, null, author);
  const snap = db().prepare('INSERT INTO snapshot(campaign_id, phase, revision) VALUES(?,?,?)');
  for (const x of history.snapshots) snap.run(id, x.phase, x.revision);
  return id;
}

export function importCampaign(state: CampaignState, name?: string): string {
  const s = prepareImportedState(state, name);
  return tx(() => insertImportedCampaign(s));
}

export { newId as newCampaignId };

/** hints: nicht blockierende Hinweise der Engine (regelkonforme Folgen, Terminüberschneidungen, Spiellast) */
export type RunResult = { ok: true; revision: number; log: string[]; warnings: string[]; hints: string[] } | Exclude<ExecResult, { ok: true }> | { ok: false; kind: 'stale'; error: string };

/** actor: wer den Command auslöst (Bildprüfung F6); ohne Angabe die Spielleitung */
type RunOpts = { force?: boolean; reason?: string; diceMode?: 'DIGITAL' | 'MANUAL'; manualDice?: number[]; author?: string; actor?: CommandActor };

export function runCommand(campaignId: string, baseRev: number, cmd: Command, opts: RunOpts): RunResult {
  // Speicherschutz: Größe und Form prüfen, Steuerzeichen aus Freitexten entfernen (gilt für alle Wege)
  // S2: Command-Schema (unbekannte Felder fallen weg, gespeichert wird der bereinigte Command)
  const parsed = parseCommand(cmd);
  if (!parsed.ok) return { ok: false, kind: 'error', error: parsed.error };
  const r = runCommandTx(campaignId, baseRev, parsed.cmd, opts);
  // B13: automatisches Backup nach jedem Phasenabschluss (neue Phase oder Kampagnenende) – erst nach dem Commit und
  // außerhalb der Anfrage (das ZIP entsteht synchron); Fehler werden nur protokolliert und lassen den Command nie scheitern
  if (r.ok && r.phaseEnded && !getCampaign(campaignId)?.sandbox_of) {
    setImmediate(() => {
      try {
        backupCampaign(campaignId);
      } catch (e) {
        console.error('Backup nach Phasenabschluss fehlgeschlagen:', campaignId, e);
        recordError(`Backup nach Phasenabschluss ${campaignId}`, e);
      }
    });
  }
  if (!r.ok) return r;
  return { ok: true, revision: r.revision, log: r.log, warnings: r.warnings, hints: r.hints };
}

function runCommandTx(
  campaignId: string,
  baseRev: number,
  cmd: Command,
  opts: RunOpts,
): Exclude<RunResult, { ok: true }> | { ok: true; revision: number; log: string[]; warnings: string[]; hints: string[]; phaseEnded: boolean } {
  return tx(() => {
    const row = getCampaign(campaignId);
    if (!row) return { ok: false, kind: 'error', error: 'Kampagne nicht gefunden' } as const;
    if (row.archived) return { ok: false, kind: 'error', error: 'Kampagne ist archiviert (schreibgeschützt)' } as const;
    // baseRev -1: auf dem aktuellen Stand ausführen (Spieler-Aktionen, keine Konfliktprüfung nötig)
    if (baseRev !== -1 && row.current_rev !== baseRev) return { ok: false, kind: 'stale', error: 'Die Kampagne wurde inzwischen geändert – Ansicht wird neu geladen' } as const;
    const state = loadState(campaignId, row.current_rev);
    // NTH2 2.5: Spieltisch – kampagnenübergreifende Belegung prüft der Server (die Engine kennt nur diese Kampagne)
    const tableErr = tableCommandError(campaignId, state, cmd, makeT('de'));
    if (tableErr) return { ok: false, kind: 'error', error: tableErr } as const;
    // F10: genau eine gültige E-Mail-Adresse je Spieler (keine Listen – Benachrichtigungen enthalten den Spielerlink)
    if (cmd.type === 'PLAYER_UPSERT' && cmd.data?.email && !isSingleEmail(cmd.data.email)) return { ok: false, kind: 'error', error: 'Ungültige E-Mail-Adresse' } as const;
    const res = executeCommand(state, cmd, {
      force: opts.force,
      reason: opts.reason,
      dice: { mode: opts.diceMode ?? 'DIGITAL', manual: opts.manualDice ?? [], random: (n) => crypto.randomInt(1, n + 1) },
    });
    if (!res.ok) return res;
    // NTH2 2.5: jede Terminänderung einer Schlacht mit Spieltisch (Verschieben, Annehmen, Tischwahl) gegen die Belegung prüfen
    const clash = tableStateError(campaignId, state, res.state, makeT('de'));
    if (clash) return { ok: false, kind: 'error', error: clash } as const;
    // F6: neu verwendete Bilder müssen zu dieser Kampagne (bei Spielern: zum Spieler) gehören
    const imgErr = uploadRefError(campaignId, state, res.state, opts.actor ?? { kind: 'gm' });
    if (imgErr) return { ok: false, kind: 'error', error: imgErr } as const;
    const maxRow = db().prepare('SELECT MAX(number) AS m FROM revision WHERE campaign_id = ?').get(campaignId) as { m: number };
    const number = maxRow.m + 1;
    // Override: Korrektur-Commands, Abweichungen vom Regelfall und übergangene Warnungen – nicht der bestätigte Regelfall
    const isOverride = isOverrideCommand(cmd) || (!!opts.force && res.override);
    const summary = (isOverride ? '⚠ ' : '') + res.summary;
    // B4: Begründung ist der eingegebene Text; übergangene Warnungen bleiben als Kontext im Protokoll der Revision
    const reason = opts.reason?.trim() || (res.warnings.length ? res.warnings.join(' | ') : null);
    const revLog = isOverride && opts.reason?.trim() && res.warnings.length ? [...res.log, ...res.warnings.map((w) => `Übergangene Warnung: ${w}`)] : res.log;
    insertRevision(campaignId, number, row.current_rev, cmd, res.state, summary, revLog, isOverride, reason, opts.author ?? null);
    db().prepare('UPDATE campaign SET current_rev = ?, name = ?, updated_at = ? WHERE id = ?').run(number, res.state.meta.name, new Date().toISOString(), campaignId);
    // F3: deaktivierte oder gelöschte Spieler verlieren ihren Link samt Push, Discord, Kalender und Einmal-Links
    for (const p of state.players) {
      if (p.active === false) continue;
      const now = res.state.players.find((x) => x.id === p.id);
      if (!now || now.active === false) revokePlayerAccess(campaignId, p.id);
    }
    // Benachrichtigungen einreihen (N1.4) – ein Fehler hier darf den Command nie scheitern lassen
    // Sandboxes (NTH2 2.1) benachrichtigen niemanden
    try {
      if (!row.sandbox_of) notifyChange(campaignId, number, state, res.state);
    } catch (e) {
      console.error('Benachrichtigung fehlgeschlagen', e);
    }
    // Phasen-Snapshot: Übergang in eine neue Phase oder Kampagnenende
    const was = state.stage;
    const now = res.state.stage;
    const endedPhase = now.kind === 'PHASE' && was.kind === 'PHASE' && now.phase === was.phase + 1 ? was.phase : now.kind === 'ENDED' && was.kind !== 'ENDED' ? res.state.meta.phaseCount : null;
    if (endedPhase !== null) {
      // Snapshot = Übergangsrevision: enthält den vollständigen Abschluss der Phase (inkl. automatischer
      // Verzichte in Schritt 5) und fällt bei einem Undo des Übergangs aus dem aktiven Zweig heraus.
      // Die Darstellung als „Ende von Phase N“ übernimmt atPhaseEnd().
      db().prepare('INSERT INTO snapshot(campaign_id, phase, revision) VALUES(?,?,?)').run(campaignId, endedPhase, number);
    }
    return { ok: true, revision: number, log: res.log, warnings: res.warnings, hints: res.hints, phaseEnded: endedPhase !== null } as const;
  });
}

export function undo(campaignId: string, baseRev: number, confirmed = false): { ok: boolean; error?: string; confirm?: string; confirmSummary?: string; revision?: number } {
  return tx(() => {
    const row = getCampaign(campaignId);
    if (!row) return { ok: false, error: 'Kampagne nicht gefunden' };
    if (row.archived) return { ok: false, error: 'Archiviert' };
    if (row.current_rev !== baseRev) return { ok: false, error: 'Veraltet – bitte neu laden' };
    const rev = db().prepare('SELECT parent_number, command FROM revision WHERE campaign_id = ? AND number = ?').get(campaignId, row.current_rev) as { parent_number: number | null; command: string };
    if (!rev?.parent_number) return { ok: false, error: 'Nichts rückgängig zu machen' };
    // NTH2 2.1: Eine übernommene Sandbox wird in einem Schritt zurückgenommen (Stand vor der Übernahme)
    const applied = (() => {
      try {
        const c = JSON.parse(rev.command) as { type?: string; originalRev?: unknown };
        return c.type === 'SANDBOX_APPLY' && typeof c.originalRev === 'number' ? c.originalRev : null;
      } catch {
        return null;
      }
    })();
    if (applied !== null) {
      if (!confirmed) return { ok: false, confirm: 'Die Übernahme der Sandbox rückgängig machen? Die Kampagne springt auf den Stand vor der Übernahme zurück.' };
      let cur: number | null = row.current_rev;
      while (cur && cur !== applied) {
        db().prepare('UPDATE revision SET undone = 1 WHERE campaign_id = ? AND number = ?').run(campaignId, cur);
        dropPendingForRevision(campaignId, cur);
        cur = (db().prepare('SELECT parent_number FROM revision WHERE campaign_id = ? AND number = ?').get(campaignId, cur) as { parent_number: number | null } | undefined)?.parent_number ?? null;
      }
      if (cur !== applied) return { ok: false, error: 'Revisionskette ungültig' };
      db().prepare('UPDATE campaign SET current_rev = ?, updated_at = ? WHERE id = ?').run(applied, new Date().toISOString(), campaignId);
      return { ok: true, revision: applied };
    }
    if (!confirmed) {
      const cur = loadState(campaignId, row.current_rev).stage;
      const prev = loadState(campaignId, rev.parent_number).stage;
      const key = (s: CampaignState['stage']) => (s.kind === 'PHASE' ? `P${s.phase}` : s.kind === 'SETUP' ? 'SETUP' : s.kind);
      if (key(cur) !== key(prev)) {
        const summary = (db().prepare('SELECT summary FROM revision WHERE campaign_id = ? AND number = ?').get(campaignId, row.current_rev) as { summary: string }).summary;
        // confirmSummary: die Oberfläche übersetzt die (deutsche) Zusammenfassung getrennt und setzt sie in ihren Text ein
        return { ok: false, confirm: `Diese Aktion überschreitet eine Phasengrenze: „${summary}“. Wirklich rückgängig machen?`, confirmSummary: summary };
      }
    }
    db().prepare('UPDATE revision SET undone = 1 WHERE campaign_id = ? AND number = ?').run(campaignId, row.current_rev);
    dropPendingForRevision(campaignId, row.current_rev);
    db().prepare('UPDATE campaign SET current_rev = ?, updated_at = ? WHERE id = ?').run(rev.parent_number, new Date().toISOString(), campaignId);
    return { ok: true, revision: rev.parent_number };
  });
}

/** Revisionen des aktiven Zweigs (Kette von current zurück) und verworfene */
export function listRevisions(campaignId: string): (RevisionRow & { active: boolean })[] {
  const row = getCampaign(campaignId);
  if (!row) return [];
  const all = db()
    .prepare('SELECT number, parent_number, command, summary, log, is_override, reason, undone, created_at, author FROM revision WHERE campaign_id = ? ORDER BY number DESC')
    .all(campaignId) as unknown as RevisionRow[];
  const byNum = new Map(all.map((r) => [r.number, r]));
  const active = new Set<number>();
  let cur: number | null = row.current_rev;
  while (cur) {
    active.add(cur);
    cur = byNum.get(cur)?.parent_number ?? null;
  }
  return all.map((r) => ({ ...r, active: active.has(r.number) }));
}

/** Schlanke Revisionsliste (ohne Command-Text und Log): Nummer, Elternteil, Zeitpunkt, Command-Typ und ob aktiv */
export function listRevisionChain(campaignId: string): { number: number; parent_number: number | null; created_at: string; type: string | null; active: boolean }[] {
  const row = getCampaign(campaignId);
  if (!row) return [];
  const all = db().prepare("SELECT number, parent_number, created_at, json_extract(command, '$.type') AS type FROM revision WHERE campaign_id = ? ORDER BY number DESC").all(campaignId) as {
    number: number;
    parent_number: number | null;
    created_at: string;
    type: string | null;
  }[];
  const byNum = new Map(all.map((r) => [r.number, r]));
  const active = new Set<number>();
  let cur: number | null = row.current_rev;
  while (cur && !active.has(cur)) {
    active.add(cur);
    cur = byNum.get(cur)?.parent_number ?? null;
  }
  return all.map((r) => ({ ...r, active: active.has(r.number) }));
}

export function setArchived(id: string, archived: boolean) {
  db()
    .prepare('UPDATE campaign SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, new Date().toISOString(), id);
}

export function regenerateToken(id: string) {
  db().prepare('UPDATE campaign SET public_token = ? WHERE id = ?').run(newToken(), id);
}

export function setPublicEnabled(id: string, enabled: boolean) {
  db()
    .prepare('UPDATE campaign SET public_enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
}

export function deleteCampaign(id: string) {
  // Sandboxes der Kampagne (NTH2 2.1) gehen mit
  const ids = (db().prepare('SELECT id FROM campaign WHERE id = ? OR sandbox_of = ?').all(id, id) as { id: string }[]).map((r) => r.id);
  db().prepare('DELETE FROM campaign WHERE id = ? OR sandbox_of = ?').run(id, id);
  // Restdaten ohne Fremdschlüssel (Outbox, Discord, Push, Einstellungen, Uploads, Backups)
  purgeCampaignData(ids);
}

/** Stellt einen Übergangs-Snapshot als Stand am Ende von Phase `phase` dar (Schritt 5 abgeschlossen). */
export function atPhaseEnd(state: CampaignState, phase: number): CampaignState {
  if (state.stage.kind === 'PHASE' && state.stage.phase === phase + 1) {
    return { ...state, stage: { kind: 'PHASE', phase, step: 'BUILD' }, phases: state.phases.filter((p) => p.number <= phase) };
  }
  return state;
}

/** Zustand am Ende jeder abgeschlossenen Phase (für Zeitreise), nur im aktiven Zweig */
export function phaseSnapshots(campaignId: string): { phase: number; revision: number }[] {
  const active = new Set(
    listRevisionChain(campaignId)
      .filter((r) => r.active)
      .map((r) => r.number),
  );
  const rows = db().prepare('SELECT phase, revision FROM snapshot WHERE campaign_id = ? ORDER BY phase, revision DESC').all(campaignId) as unknown as { phase: number; revision: number }[];
  const out = new Map<number, number>();
  for (const r of rows) if (active.has(r.revision) && !out.has(r.phase)) out.set(r.phase, r.revision);
  return [...out.entries()].map(([phase, revision]) => ({ phase, revision }));
}

/** Nur IDs und Namen aller Kampagnen (ohne Zustände zu laden) */
export function campaignNameList(): { id: string; name: string }[] {
  return db().prepare('SELECT id, name FROM campaign WHERE sandbox_of IS NULL ORDER BY archived, updated_at DESC').all() as { id: string; name: string }[];
}
