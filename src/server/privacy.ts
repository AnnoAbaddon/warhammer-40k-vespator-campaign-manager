import 'server-only';
import { db, getSetting, setSetting, tx } from './db';
import { audit } from './audit';
import { currentState, listCampaigns } from './campaigns';
import { outboxStatus } from './notify';
import { deleteUploads } from './cleanup';
import { playerDataExport, scrubState, scrubValues, type ScrubOptions } from '@/engine/privacy';
import type { CampaignState } from '@/engine/types';

/**
 * Datenschutz-Werkzeuge (NTH2 6.4): Export der Daten eines Spielers, Löschen der Kontaktdaten auf Knopfdruck und
 * automatische Bereinigung nach Kampagnenende. Gelöscht wird in allen Revisionen (die Historie behält sonst die
 * Daten), in den Sandboxes der Kampagne und in der Outbox; jede Löschung steht im Verwaltungsprotokoll.
 * Automatische Backups auf der Platte rotieren heraus (14 tägliche, 5 manuelle je Kampagne; Datenbank-Sicherungen
 * 7 Tage) – bis dahin stehen die Daten noch in älteren Sicherungen (DEPLOY.md, "Backups and privacy").
 */

export function exportPlayer(campaignId: string, playerId: string) {
  const { state } = currentState(campaignId);
  const data = playerDataExport(state, playerId);
  if (!data) return null;
  const p = state.players.find((x) => x.id === playerId)!;
  const addr = [p.email, p.discord].filter((x) => x?.trim());
  const outbox = addr.length ? outboxStatus(campaignId, 500).filter((m) => addr.includes(m.recipient)) : [];
  return { ...data, exportedAt: new Date().toISOString(), messages: outbox.map((m) => ({ channel: m.channel, subject: m.subject, status: m.status, created_at: m.created_at, sent_at: m.sent_at })) };
}

/**
 * Bereinigt eine Kampagne in allen Revisionen – samt ihrer Sandboxes (NTH2 2.1), sonst brächte das Übernehmen
 * einer Sandbox die gelöschten Daten zurück. Mit `contact` gehen auch Avatar- und Kommandanten-Bilder der Spieler
 * sowie deren Discord-Verknüpfungen (mit Discord-Namen). Liefert die Zahl geänderter Revisionen.
 */
export function scrubCampaign(campaignId: string, o: ScrubOptions, author: string, action: string, detail: string | null): number {
  let changed = 0;
  const campaigns = [campaignId, ...(db().prepare('SELECT id FROM campaign WHERE sandbox_of = ?').all(campaignId) as { id: string }[]).map((r) => r.id)];
  const images = new Set<string>();
  tx(() => {
    const allRemoved = new Set<string>();
    const contacts = new Set<string>();
    const hitIds = new Set<string>();
    const work: { campaign: string; number: number; state: CampaignState; before: string; command: string }[] = [];
    for (const cid of campaigns) {
      const rows = db().prepare('SELECT number, state, command FROM revision WHERE campaign_id = ?').all(cid) as { number: number; state: string; command: string }[];
      for (const r of rows) {
        const res = scrubState(JSON.parse(r.state) as CampaignState, o);
        for (const v of res.removed) allRemoved.add(v);
        for (const c of res.contacts) contacts.add(c);
        if (o.contact) {
          for (const p of res.state.players) {
            if (o.players !== 'ALL' && !o.players.includes(p.id)) continue;
            hitIds.add(p.id);
            if (p.avatar) images.add(p.avatar);
            if (p.commander?.portrait) images.add(p.commander.portrait);
            p.avatar = null;
            if (p.commander) p.commander = { ...p.commander, portrait: null };
          }
        }
        work.push({ campaign: cid, number: r.number, state: res.state, before: r.state, command: r.command });
      }
    }
    const removed = [...allRemoved, ...images];
    const upd = db().prepare('UPDATE revision SET state = ?, command = ? WHERE campaign_id = ? AND number = ?');
    for (const w of work) {
      const s = JSON.stringify(w.state);
      let cmd = w.command;
      try {
        cmd = JSON.stringify(scrubValues(JSON.parse(w.command), removed));
      } catch {
        // Command nicht lesbar – unverändert lassen
      }
      if (s !== w.before || cmd !== w.command) {
        upd.run(s, cmd, w.campaign, w.number);
        changed++;
      }
    }
    for (const cid of campaigns) {
      // Outbox: Nachrichten an die gelöschten Adressen entfernen
      const del = db().prepare('DELETE FROM outbox WHERE campaign_id = ? AND recipient = ?');
      for (const c of contacts) del.run(cid, c);
      // Discord-Verknüpfungen (enthalten den Discord-Namen)
      const unlink = db().prepare('DELETE FROM discord_link WHERE campaign_id = ? AND player_id = ?');
      for (const pid of hitIds) unlink.run(cid, pid);
    }
  });
  // Bilder erst nach dem Commit löschen: eigene Bilder der Kampagne immer (F6 – auch wenn eine andere Kampagne sie
  // referenziert), fremde nur, wenn sie nirgends sonst mehr vorkommen
  if (images.size) deleteUploads([...images], campaigns, { owned: true });
  audit(author, action, detail, campaignId);
  return changed;
}

/** Kontaktdaten eines Spielers löschen (E-Mail, Discord, Klarname) – auf Wunsch des Spielers */
export function deletePlayerContact(campaignId: string, playerId: string, author: string): number {
  const { state } = currentState(campaignId);
  const p = state.players.find((x) => x.id === playerId);
  if (!p) throw new Error('Spieler nicht gefunden');
  return scrubCampaign(campaignId, { players: [playerId], contact: true, notes: false, pulse: false }, author, 'Kontaktdaten gelöscht', p.nickname);
}

// ─── Automatische Bereinigung nach Kampagnenende ───────────────────────────

export interface PrivacySettings {
  /** Tage nach Kampagnenende; null = aus */
  days: number | null;
  contact: boolean;
  notes: boolean;
  pulse: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = { days: null, contact: true, notes: true, pulse: true };

export function privacySettings(): PrivacySettings {
  try {
    return { ...DEFAULT_PRIVACY, ...(JSON.parse(getSetting('privacy') ?? '{}') as Partial<PrivacySettings>) };
  } catch {
    return DEFAULT_PRIVACY;
  }
}

export function setPrivacySettings(s: PrivacySettings) {
  const days = s.days === null || !Number.isFinite(s.days) ? null : Math.max(1, Math.min(3650, Math.round(s.days)));
  setSetting('privacy', JSON.stringify({ days, contact: !!s.contact, notes: !!s.notes, pulse: !!s.pulse }));
}

/** Zeitpunkt des Kampagnenendes: erste Revision der aktuellen Kette mit Stufe ENDED (sonst letzte Änderung) */
export function endedAt(campaignId: string): string | null {
  const r = db().prepare("SELECT MIN(created_at) AS at FROM revision WHERE campaign_id = ? AND undone = 0 AND json_extract(state, '$.stage.kind') = 'ENDED'").get(campaignId) as { at: string | null } | undefined;
  return r?.at ?? null;
}

/** Fällige Kampagnen bereinigen (vom Scheduler einmal je Durchlauf aufgerufen, idempotent) */
export function runPrivacyCleanup(now = new Date(), onError: (id: string, e: unknown) => void = (id, e) => console.error('Datenbereinigung fehlgeschlagen:', id, e)): string[] {
  const cfg = privacySettings();
  if (!cfg.days || !(cfg.contact || cfg.notes || cfg.pulse)) return [];
  const done: string[] = [];
  for (const c of listCampaigns()) {
    if (c.broken || c.state.stage.kind !== 'ENDED') continue;
    if (getSetting(`privacyCleaned:${c.id}`)) continue;
    const at = endedAt(c.id);
    if (!at || Date.parse(at) + cfg.days * 86_400_000 > now.getTime()) continue;
    // jede Kampagne für sich: ein Fehler hält die übrigen nicht auf
    try {
      scrubCampaign(c.id, { players: 'ALL', contact: cfg.contact, notes: cfg.notes, pulse: cfg.pulse }, 'System', 'Automatische Datenbereinigung', `${cfg.days} d`);
      setSetting(`privacyCleaned:${c.id}`, now.toISOString());
      done.push(c.id);
    } catch (e) {
      onError(c.id, e);
    }
  }
  return done;
}
