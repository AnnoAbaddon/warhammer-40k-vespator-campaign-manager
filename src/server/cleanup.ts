import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db';
import { BACKUP_DIR } from './autoBackup';
import { insideDir } from './safePath';

/**
 * Aufräumen beim Löschen einer Kampagne oder Sandbox: alles, was nicht per Fremdschlüssel mitgelöscht wird
 * (Outbox, Discord-Verknüpfungen und -Codes, Push-Abos, Einstellungen je Kampagne, Uploads samt Dateien,
 * automatische Backups auf der Platte).
 */

const SAFE_ID = /^[A-Za-z0-9_-]{6,40}$/;

/** Wird ein Upload noch irgendwo anders verwendet (andere Kampagnen, Vorlagen)? */
function uploadReferenced(uploadId: string, exceptCampaigns: string[]): boolean {
  const marks = exceptCampaigns.map(() => '?').join(',');
  const inRevisions = db()
    .prepare(`SELECT 1 FROM revision WHERE ${exceptCampaigns.length ? `campaign_id NOT IN (${marks}) AND ` : ''}instr(state, ?) > 0 LIMIT 1`)
    .get(...exceptCampaigns, uploadId);
  if (inRevisions) return true;
  for (const table of ['campaign_template', 'map_template']) {
    if (db().prepare(`SELECT 1 FROM ${table} WHERE instr(json, ?) > 0 LIMIT 1`).get(uploadId)) return true;
  }
  return false;
}

/** Datei im Upload-Verzeichnis löschen (nur innerhalb von UPLOAD_DIR) */
function removeUploadFile(rel: string | null) {
  if (!rel) return;
  const root = path.resolve(UPLOAD_DIR) + path.sep;
  const full = path.resolve(UPLOAD_DIR, rel);
  if (!full.startsWith(root)) return;
  fs.rmSync(full, { force: true });
}

/**
 * Löscht Uploads (Zeile und Dateien), sofern sie außerhalb der genannten Kampagnen nicht mehr verwendet werden.
 * Mit `owned: true` (Datenschutz-Löschung, F6) werden Bilder, die zu einer der genannten Kampagnen gehören, auch dann
 * gelöscht, wenn eine andere Kampagne sie noch referenziert – ein fremder Verweis hält die Bilder des Spielers nicht
 * am Leben. Liefert die Zahl gelöschter Uploads.
 */
export function deleteUploads(uploadIds: string[], ownerCampaigns: string[], opts: { owned?: boolean } = {}): number {
  let n = 0;
  for (const id of new Set(uploadIds)) {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) continue;
    const row = db().prepare('SELECT file, thumb, campaign_id FROM upload WHERE id = ?').get(id) as { file: string; thumb: string | null; campaign_id: string | null } | undefined;
    if (!row) continue;
    const own = opts.owned && row.campaign_id !== null && ownerCampaigns.includes(row.campaign_id);
    if (!own && uploadReferenced(id, ownerCampaigns)) continue;
    try {
      removeUploadFile(row.file);
      removeUploadFile(row.thumb);
    } catch (e) {
      console.error('Upload konnte nicht gelöscht werden:', id, e);
    }
    db().prepare('DELETE FROM upload WHERE id = ?').run(id);
    n++;
  }
  return n;
}

/**
 * Restdaten gelöschter Kampagnen entfernen. Aufrufen, nachdem die Kampagnen-Zeilen gelöscht sind (Revisionen,
 * Snapshots, Spielerlinks und Freigaben entfernt die Datenbank über Fremdschlüssel).
 */
export function purgeCampaignData(ids: string[]) {
  const list = ids.filter((id) => SAFE_ID.test(id));
  if (!list.length) return;
  for (const id of list) {
    db().prepare('DELETE FROM outbox WHERE campaign_id = ?').run(id);
    db().prepare('DELETE FROM discord_link WHERE campaign_id = ?').run(id);
    db().prepare('DELETE FROM discord_code WHERE campaign_id = ?').run(id);
    db().prepare('DELETE FROM push_sub WHERE campaign_id = ?').run(id);
    db().prepare('DELETE FROM settings WHERE key IN (?, ?)').run(`discord:${id}`, `privacyCleaned:${id}`);
  }
  // Uploads der Kampagnen (Bilder, die eine Nachfolgekampagne oder Vorlage weiter nutzt, bleiben erhalten)
  const marks = list.map(() => '?').join(',');
  const uploads = (
    db()
      .prepare(`SELECT id FROM upload WHERE campaign_id IN (${marks})`)
      .all(...list) as { id: string }[]
  ).map((r) => r.id);
  deleteUploads(uploads, list);
  for (const id of list) {
    try {
      const dir = insideDir(UPLOAD_DIR, id);
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      // automatische Backups der Kampagne (die Rotation würde sie sonst nie entfernen)
      const backups = insideDir(BACKUP_DIR, id);
      if (backups !== path.resolve(BACKUP_DIR)) fs.rmSync(backups, { recursive: true, force: true });
    } catch (e) {
      console.error('Aufräumen der Dateien fehlgeschlagen:', id, e);
    }
  }
}
