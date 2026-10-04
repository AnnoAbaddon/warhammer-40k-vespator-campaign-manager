import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db, getSetting, setSetting } from './db';
import { buildBackupZip, importBackup } from './backup';
import { insideDir } from './safePath';

/**
 * Automatische Backups (N5.1): täglich ein Komplett-ZIP je Kampagne unter `backups/`,
 * die letzten 14 bleiben erhalten. Wiederherstellung immer als neue Kampagne.
 */
export const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(/*turbopackIgnore: true*/ DATA_DIR, 'backups');
export const KEEP = 14;
const SAFE = /^[A-Za-z0-9_-]{6,40}$/;
const FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-manuell)?\.zip$/;
const KEEP_MANUAL = 5;

function dirOf(campaignId: string) {
  if (!SAFE.test(campaignId)) throw new Error('Ungültige Kampagne');
  return insideDir(BACKUP_DIR, campaignId);
}

export function backupCampaign(campaignId: string, manual = false): { file: string; size: number } {
  const dir = dirOf(campaignId);
  fs.mkdirSync(dir, { recursive: true });
  const { zip } = buildBackupZip(campaignId);
  const file = `${new Date().toISOString().slice(0, 23).replace(/[:.]/g, '-')}${manual ? '-manuell' : ''}.zip`;
  const tmp = insideDir(dir, `.${file}.tmp`);
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, insideDir(dir, file));
  // Rotation getrennt: 14 tägliche, 5 manuelle – manuelle Sicherungen verdrängen die täglichen nicht
  const all = listBackups(campaignId);
  const daily = all.filter((b) => !b.file.includes('-manuell'));
  const hand = all.filter((b) => b.file.includes('-manuell'));
  for (const old of [...daily.slice(KEEP), ...hand.slice(KEEP_MANUAL)]) fs.rmSync(insideDir(dir, old.file), { force: true });
  return { file, size: zip.byteLength };
}

export function listBackups(campaignId: string): { file: string; size: number; at: string }[] {
  const dir = dirOf(campaignId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(insideDir(dir, f));
      return { file: f, size: st.size, at: st.mtime.toISOString() };
    });
}

/** Stellt ein Backup als neue Kampagne wieder her und liefert deren ID */
export function restoreBackup(campaignId: string, file: string, author: string | null = null): string {
  if (!FILE.test(file)) throw new Error('Ungültige Datei');
  const bytes = fs.readFileSync(insideDir(dirOf(campaignId), file));
  const name = (db().prepare('SELECT name FROM campaign WHERE id = ?').get(campaignId) as { name: string } | undefined)?.name ?? 'Kampagne';
  // F4: die Kopie startet ohne Leseansicht (nicht in der Hall of Fame) – veröffentlichen ist eine bewusste Entscheidung
  return importBackup(new Uint8Array(bytes), `${name} (Wiederherstellung ${file.slice(0, 10)})`, { author, action: 'Backup wiederhergestellt', detail: `${name} · ${file}`, publicEnabled: false });
}

/** Kalendertag in Ortszeit des Servers (TZ) – passend zur Stundenprüfung (03:00 Serverzeit) */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Alle Kampagnen sichern (einmal täglich ab 03:00 Serverzeit); liefert true, wenn ein Lauf stattfand.
 * Jede Kampagne einzeln: ein Fehler stoppt die übrigen nicht, wird auf der Health-Seite gemeldet und beim nächsten
 * Durchgang wiederholt (der Tag gilt erst als erledigt, wenn alle gesichert sind; bereits heute gesicherte
 * Kampagnen werden dabei übersprungen). Archivierte Kampagnen ändern sich nicht mehr: gesichert wird nur, solange es
 * seit dem Archivieren noch kein Backup gibt.
 */
export function runDailyBackups(now = new Date(), onError: (id: string, e: unknown) => void = defaultBackupError): boolean {
  const today = localDay(now);
  if (now.getHours() < 3 || getSetting('backupLastDay') === today) return false;
  // Sandboxes (NTH2 2.1) sind Wegwerf-Kopien und werden nicht gesichert
  const rows = db().prepare('SELECT id, archived, updated_at FROM campaign WHERE sandbox_of IS NULL').all() as { id: string; archived: number; updated_at: string }[];
  let failed = 0;
  for (const { id, archived, updated_at } of rows) {
    try {
      const list = listBackups(id);
      if (list.some((b) => !b.file.includes('-manuell') && localDay(new Date(b.at)) === today)) continue;
      if (archived && list.some((b) => b.at >= updated_at)) continue;
      backupCampaign(id);
    } catch (e) {
      failed++;
      onError(id, e);
    }
  }
  // erst nach einem vollständigen Lauf markieren – Abstürze oder Fehler werden beim nächsten Durchgang nachgeholt
  if (!failed) setSetting('backupLastDay', today);
  return true;
}

function defaultBackupError(id: string, e: unknown) {
  console.error('Backup fehlgeschlagen:', id, e);
}
