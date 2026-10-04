import 'server-only';
import { flushOutbox, releaseStaleSending, scanDeadlines } from './notify';
import { runDailyBackups } from './autoBackup';
import { recordError } from './health';
import { runPrivacyCleanup } from './privacy';
import { backupDatabase, purgeExpired } from './maintenance';

/**
 * Hintergrundaufgaben im Serverprozess (Benachrichtigungen, Deadlines, Backups, Wartung).
 * Wird einmal über instrumentation.ts gestartet; alle Aufgaben sind idempotent.
 */
const g = globalThis as unknown as { __vfScheduler?: boolean };

/** Führt eine Aufgabe aus; Fehler landen im Log und auf der Health-Seite (NTH2 6.2), nie beim Aufrufer */
export async function runSafe(name: string, fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    console.error('Hintergrundaufgabe fehlgeschlagen:', name, e);
    recordError(`Hintergrundaufgabe ${name}`, e);
    return false;
  }
}

/** Fehler einer einzelnen Kampagne: melden, die übrigen laufen weiter */
const campaignError = (task: string) => (id: string, e: unknown) => {
  console.error('Hintergrundaufgabe fehlgeschlagen:', task, id, e);
  recordError(`Hintergrundaufgabe ${task} ${id}`, e);
};

/**
 * Ein Durchgang der 5-Minuten-Aufgaben. Jede Aufgabe für sich (eine fehlerhafte Kampagne hält weder die übrigen
 * Kampagnen noch Backups, Datenschutz oder Wartung auf).
 */
export async function periodicTasks(now = new Date()) {
  await runSafe('deadlines', () => scanDeadlines(now.getTime(), campaignError('deadlines')));
  await runSafe('backups', () => runDailyBackups(now, campaignError('backups')));
  await runSafe('db-backup', () => backupDatabase(now));
  // Datenschutz (NTH2 6.4): automatische Bereinigung nach Kampagnenende, falls eingestellt
  await runSafe('privacy', () => runPrivacyCleanup(now, campaignError('privacy')));
  await runSafe('purge', () => purgeExpired(now.getTime()));
}

export function startScheduler() {
  if (g.__vfScheduler || process.env.DISABLE_SCHEDULER === '1') return;
  g.__vfScheduler = true;
  releaseStaleSending();
  // Versand jede Minute, Deadlines, Backups und Wartung alle 5 Minuten
  setInterval(() => void runSafe('outbox', () => flushOutbox()), 60_000).unref();
  setInterval(() => void periodicTasks(), 5 * 60_000).unref();
  setTimeout(() => void runSafe('start', () => flushOutbox()), 10_000).unref();
}
