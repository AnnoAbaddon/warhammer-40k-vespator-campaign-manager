import 'server-only';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { db, getSetting, setSetting } from './db';
import { appUrl } from './origin';
import { currentState, getCampaign } from './campaigns';
import { playerTokenFor } from './players';
import { ATTACK_TYPES } from '@/engine/data/vespator';
import { eventName } from '@/engine/customEvents';
import { planetName } from '@/engine/map';
import { sideOf } from '@/engine/playerActions';
import { reminderTarget, type ReminderReason } from '@/engine/reminders';
import type { Battle, CampaignState, NotifyCategory, Player } from '@/engine/types';
import { intlLocale, makeT, type Locale, type T } from '@/i18n/core';
import { contextLocale } from './locale';
import { adminPushSubs, deliverPush, playerPushSubIds, type PushPayload } from './push';
import { confirmLinkPath } from './confirmLink';
import { gmAlerts, overdueAlerts, type GmAlert } from '@/engine/p1';

/**
 * Benachrichtigungen (N1.4): Ausgangs-Warteschlange (`outbox`) mit Wiederholversuchen.
 * Jede Nachricht hat einen eindeutigen Schlüssel – so wird nach Neustarts oder doppelten
 * Prüfläufen nichts zweimal verschickt.
 */

export type Channel = 'DISCORD' | 'EMAIL' | 'PUSH';

interface Msg {
  campaignId: string;
  /** Revision, die die Nachricht ausgelöst hat (für Undo) */
  revision?: number | null;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
  key: string;
}

/** Revision des gerade verarbeiteten Commands (wird von notifyChange gesetzt) */
let currentRevision: number | null = null;

export function enqueue(m: Msg) {
  // Schlüssel je Kampagne – sonst blockieren sich Kampagnen gegenseitig
  db()
    .prepare('INSERT OR IGNORE INTO outbox(campaign_id, channel, recipient, subject, body, dedupe_key, status, attempts, created_at, revision) VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run(m.campaignId, m.channel, m.recipient, m.subject, m.body, `${m.campaignId}:${m.key}`, 'PENDING', new Date().toISOString(), m.revision ?? currentRevision);
}

/** Undo: noch nicht verschickte Nachrichten der zurückgenommenen Revision verwerfen */
export function dropPendingForRevision(campaignId: string, revision: number) {
  db().prepare("DELETE FROM outbox WHERE campaign_id = ? AND revision = ? AND status = 'PENDING'").run(campaignId, revision);
}

// ─── Konfiguration ─────────────────────────────────────────────────────────

export function discordWebhook(campaignId: string): string | null {
  return getSetting(`discord:${campaignId}`);
}
export function setDiscordWebhook(campaignId: string, url: string | null) {
  if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) throw new Error('Das sieht nicht nach einem Discord-Webhook aus (https://discord.com/api/webhooks/…)');
  if (url) setSetting(`discord:${campaignId}`, url);
  else db().prepare('DELETE FROM settings WHERE key = ?').run(`discord:${campaignId}`);
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Ausdrücklich erlaubt: ohne erzwungenes TLS (nur lokales Relay) – STARTTLS wird dann nur genutzt, wenn angeboten */
  insecure?: boolean;
}

/** SMTP_ALLOW_INSECURE=1: unverschlüsselten Versand für alle Konfigurationen erlauben (lokales Relay) */
export const smtpInsecureFromEnv = () => process.env.SMTP_ALLOW_INSECURE === '1';

/**
 * Verbindungsoptionen für nodemailer. Standard (ASVS 12.3): Port 465 mit direktem TLS, sonst STARTTLS erzwungen
 * (`requireTLS`) – ein Angreifer im Netz kann STARTTLS dann nicht wegfiltern und Zugangsdaten oder Mails mitlesen.
 * Mindestens TLS 1.2. Nur mit ausdrücklicher Freigabe (Einstellung oder SMTP_ALLOW_INSECURE=1) darf ohne TLS
 * gesendet werden.
 */
export function smtpTransportOptions(smtp: SmtpConfig, timeoutMs = 10_000) {
  const insecure = !smtp.secure && (!!smtp.insecure || smtpInsecureFromEnv());
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && !insecure,
    tls: { minVersion: 'TLSv1.2' as const },
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: 3 * timeoutMs,
  };
}

/** SMTP global: Einstellungen im Konto, sonst Umgebungsvariablen */
export function smtpConfig(): SmtpConfig | null {
  const raw = getSetting('smtp');
  if (raw) {
    try {
      const c = JSON.parse(raw) as SmtpConfig;
      if (c.host && c.from) return c;
    } catch {}
  }
  const e = process.env;
  if (e.SMTP_HOST && e.SMTP_FROM) return { host: e.SMTP_HOST, port: Number(e.SMTP_PORT ?? 587), secure: e.SMTP_SECURE === '1', user: e.SMTP_USER ?? '', pass: e.SMTP_PASS ?? '', from: e.SMTP_FROM };
  return null;
}
export function setSmtpConfig(c: SmtpConfig | null) {
  if (c) setSetting('smtp', JSON.stringify(c));
  else db().prepare('DELETE FROM settings WHERE key = ?').run('smtp');
}

// ─── Abmeldelink ───────────────────────────────────────────────────────────

function secret(): string {
  const s = getSetting('notifySecret');
  if (s) return s;
  // parallel erzeugte Geheimnisse: das zuerst gespeicherte gewinnt (sonst wären bereits verschickte Abmeldelinks ungültig)
  db().prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('notifySecret', ?)").run(crypto.randomBytes(32).toString('base64url'));
  return getSetting('notifySecret')!;
}
export function unsubscribeSig(campaignId: string, playerId: string): string {
  return crypto.createHmac('sha256', secret()).update(`${campaignId}:${playerId}`).digest('base64url').slice(0, 32);
}
export function checkUnsubscribe(campaignId: string, playerId: string, sig: string): boolean {
  const a = Buffer.from(unsubscribeSig(campaignId, playerId));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Empfänger und Texte ───────────────────────────────────────────────────

/** Sprache der E-Mails: Einstellung des Empfängers, sonst Standard der Kampagne */
const mailLocale = (p: Pick<Player, 'locale'>, st: Pick<CampaignState, 'meta'>): Locale => contextLocale(p.locale, st.meta.locale);
/** Sprache der Discord-Nachrichten: Standard der Kampagne */
const campaignLocale = (st: Pick<CampaignState, 'meta'>): Locale => contextLocale(st.meta.locale);

const wants = (p: Player, cat: NotifyCategory) => p.active && !!p.email?.includes('@') && p.notify?.[cat] !== false;

function playerLink(campaignId: string, p: Player): string {
  const t = playerTokenFor(campaignId, p.id, false);
  return t ? `${appUrl()}/p/${t}` : '';
}

function publicLink(campaignId: string): string {
  const row = getCampaign(campaignId);
  return row?.public_enabled ? `${appUrl()}/v/${row.public_token}` : '';
}

/** Betreff und Text werden je Empfänger in dessen Sprache erzeugt; zusätzlich Web-Push an seine Geräte (NTH2 1.1) */
function mail(
  campaignId: string,
  st: CampaignState,
  p: Player,
  cat: NotifyCategory,
  subject: (t: T, l: Locale) => string,
  text: (t: T, l: Locale) => string,
  key: string,
  opts: { url?: string; extra?: (t: T) => string } = {},
) {
  pushPlayer(campaignId, st, p, cat, subject, text, key, opts.url);
  if (!wants(p, cat)) return;
  // Ohne SMTP wird nichts eingereiht – sonst füllt sich die Warteschlange mit Mails, die nie rausgehen
  if (!smtpConfig()) return;
  const l = mailLocale(p, st);
  const t = makeT(l);
  const link = playerLink(campaignId, p) || publicLink(campaignId);
  const unsub = `${appUrl()}/abmelden/${campaignId}/${p.id}/${unsubscribeSig(campaignId, p.id)}?kategorie=${cat}`;
  const body = `${t('Hallo {name},', { name: p.nickname })}\n\n${text(t, l)}\n\n${opts.extra ? `${opts.extra(t)}\n\n` : ''}${link ? `${t('Zur Kampagne: {link}', { link })}\n\n` : ''}—\n${t('Diese Nachricht abbestellen: {link}', { link: unsub })}`;
  enqueue({ campaignId, channel: 'EMAIL', recipient: p.email, subject: subject(t, l), body, key: `${key}:mail:${p.id}` });
}

// ─── Web-Push (NTH2 1.1) ───────────────────────────────────────────────────

/** Push-Kategorien folgen denselben Einstellungen wie die E-Mails (Profil bzw. Abmeldelink) */
const wantsPush = (p: Player, cat: NotifyCategory) => p.active && p.notify?.[cat] !== false;

function enqueuePush(campaignId: string, subId: string, payload: PushPayload, key: string) {
  const body = JSON.stringify({ ...payload, title: payload.title.slice(0, 120), body: payload.body.slice(0, 400) });
  enqueue({ campaignId, channel: 'PUSH', recipient: subId, subject: payload.title.slice(0, 120), body, key: `${key}:push:${subId}` });
}

/** Push an alle Geräte eines Spielers; liefert die Zahl der Geräte */
function pushPlayer(campaignId: string, st: CampaignState, p: Player, cat: NotifyCategory, subject: (t: T, l: Locale) => string, text: (t: T, l: Locale) => string, key: string, url?: string): number {
  if (!wantsPush(p, cat)) return 0;
  const subs = playerPushSubIds(campaignId, p.id);
  if (!subs.length) return 0;
  const l = mailLocale(p, st);
  const t = makeT(l);
  const token = playerTokenFor(campaignId, p.id, false);
  const target = url ?? (token ? `/p/${token}` : '/');
  for (const id of subs) enqueuePush(campaignId, id, { title: subject(t, l), body: text(t, l), url: target, tag: `${campaignId}:${cat}` }, key);
  return subs.length;
}

const GM_ALERT_TEXT: Record<GmAlert['kind'], [string, string]> = {
  DISPUTED: ['{name}: Einspruch gegen ein Ergebnis', '{battle} – bitte entscheiden.'],
  OVERDUE: ['{name}: Meldung seit 48 h offen', '{battle} – bitte entscheiden.'],
  ORDERS_COMPLETE: ['{name}: Alle Befehle eingegangen', 'Phase {n}: Alle Flotten haben Befehle – die Operationen können aufgedeckt werden.'],
  BATTLES_COMPLETE: ['{name}: Alle Schlachten gemeldet', 'Phase {n}: Alle Schlachten haben ein Ergebnis – weiter mit der Auswertung.'],
};

/** „Handlungsbedarf“ per Push an die Spielleiter-Konten mit Zugriff auf die Kampagne */
export function pushGmAlerts(campaignId: string, st: CampaignState, alerts: GmAlert[]) {
  if (!alerts.length) return;
  const subs = adminPushSubs(campaignId);
  for (const a of alerts) {
    const b = a.battleId ? st.battles.find((x) => x.id === a.battleId) : undefined;
    for (const s of subs) {
      const t = makeT(s.locale);
      const [title, body] = GM_ALERT_TEXT[a.kind];
      enqueuePush(campaignId, s.id, { title: t(title, { name: st.meta.name }), body: t(body, { battle: b ? battleLine(st, b, t) : '', n: a.phase ?? '' }), url: `/admin/c/${campaignId}`, tag: `${campaignId}:gm` }, a.key);
    }
  }
}

function discord(campaignId: string, text: string, key: string) {
  if (!discordWebhook(campaignId)) return;
  // Discord-Nachrichten verlinken nie private Spielerlinks
  const link = publicLink(campaignId);
  enqueue({ campaignId, channel: 'DISCORD', recipient: 'webhook', subject: '', body: `${text}${link ? `\n<${link}>` : ''}`, key: `${key}:discord` });
}

const battleLine = (st: CampaignState, b: Battle, t: T) => {
  const A = st.alliances.find((a) => a.id === b.attackerAllianceId)?.name;
  const D = st.alliances.find((a) => a.id === b.defenderAllianceId)?.name;
  return t('{battle} auf {planet}: {a} gegen {d}', { battle: b.attackType ? ATTACK_TYPES[b.attackType].name : t('Entscheidungsschlacht'), planet: b.planetId ? planetName(b.planetId) : '–', a: A, d: D });
};

/** Leitet aus dem Vorher/Nachher eines Commands die Nachrichten ab */
export function notifyChange(campaignId: string, rev: number, before: CampaignState, after: CampaignState) {
  currentRevision = rev;
  try {
    notifyChangeInner(campaignId, rev, before, after);
  } finally {
    currentRevision = null;
  }
}

function notifyChangeInner(campaignId: string, rev: number, before: CampaignState, after: CampaignState) {
  const name = after.meta.name;
  const players = after.players;
  const phase = after.stage.kind === 'PHASE' ? after.stage.phase : null;
  const dt = makeT(campaignLocale(after));

  // Neue Phase
  if (after.stage.kind === 'PHASE' && (before.stage.kind !== 'PHASE' || before.stage.phase !== after.stage.phase)) {
    const ph = after.phases.find((p) => p.number === phase);
    const dl = (t: T, l: Locale) =>
      ph?.opsDeadline ? ` ${t('Befehle bis {date}.', { date: new Date(ph.opsDeadline).toLocaleString(intlLocale(l), { timeZone: after.meta.timezone, dateStyle: 'short', timeStyle: 'short' }) })}` : '';
    discord(campaignId, `**${name}** – ${dt('Phase {n} beginnt.', { n: phase })}${dl(dt, campaignLocale(after))}`, `phase:${phase}`);
    for (const p of players)
      mail(
        campaignId,
        after,
        p,
        'PHASE',
        (t) => t('{name}: Phase {n} beginnt', { name, n: phase }),
        (t, l) => `${t('Phase {n} hat begonnen. Zeit für neue Befehle.', { n: phase })}${dl(t, l)}`,
        `phase:${phase}`,
      );
  }

  // Operationen aufgedeckt – nur beim Aufdecken selbst (nicht bei späterem Entbündeln o. Ä.)
  const wasRevealed = before.phases.find((x) => x.number === phase)?.flags.revealed ?? false;
  const revealedNow = !!phase && !wasRevealed && !!after.phases.find((x) => x.number === phase)?.flags.revealed;
  const newBattles = revealedNow ? after.battles.filter((b) => !before.battles.some((x) => x.id === b.id) && b.kind === 'CAMPAIGN') : [];
  if (revealedNow && !newBattles.length) discord(campaignId, `**${name}** – ${dt('Operationen aufgedeckt – in dieser Phase kommt es zu keiner Schlacht.')}`, `reveal:${phase}`);
  if (newBattles.length && phase) {
    discord(campaignId, `**${name}** – ${dt('Operationen aufgedeckt:')}\n${newBattles.map((b) => `• ${battleLine(after, b, dt)}`).join('\n')}`, `reveal:${phase}:${newBattles.map((b) => b.id).join(',')}`);
    for (const p of players) {
      const mine = newBattles.filter((b) => sideOf(after, b, p.id) === 'DEFENDER');
      if (mine.length)
        mail(
          campaignId,
          after,
          p,
          'PERSONAL',
          (t) => t('{name}: Du wirst angegriffen', { name }),
          (t) => mine.map((b) => battleLine(after, b, t)).join('\n'),
          `attacked:${mine.map((b) => b.id).join(',')}`,
        );
    }
    for (const p of players)
      mail(
        campaignId,
        after,
        p,
        'PHASE',
        (t) => t('{name}: Operationen aufgedeckt', { name }),
        (t) => newBattles.map((b) => battleLine(after, b, t)).join('\n'),
        `reveal:${phase}`,
      );
  }

  for (const b of after.battles) {
    const old = before.battles.find((x) => x.id === b.id);
    // Ergebnis bestätigt/eingetragen
    if (b.victor && !old?.victor) {
      const winner = after.alliances.find((a) => a.id === (b.victor === 'ATTACKER' ? b.attackerAllianceId : b.defenderAllianceId))?.name;
      const v = (t: T) => (b.victor === 'DRAW' ? t('Unentschieden') : t('{name} siegt', { name: winner }));
      discord(campaignId, `**${name}** – ${battleLine(after, b, dt)} → ${v(dt)}${b.vp ? ` (${b.vp.attacker}:${b.vp.defender} VP)` : ''}`, `result:${b.id}:${rev}`);
      for (const p of players)
        mail(
          campaignId,
          after,
          p,
          'RESULTS',
          (t) => t('{name}: neues Ergebnis', { name }),
          (t) => `${battleLine(after, b, t)} → ${v(t)}`,
          `result:${b.id}:${rev}`,
        );
    }
    // Ergebnis zur Bestätigung
    if (b.draft && b.draft.status === 'PENDING' && (!old?.draft || old.draft.at !== b.draft.at)) {
      const by = sideOf(after, b, b.draft.byPlayerId);
      const draft = b.draft;
      for (const p of players)
        if (sideOf(after, b, p.id) && sideOf(after, b, p.id) !== by)
          mail(
            campaignId,
            after,
            p,
            'PERSONAL',
            (t) => t('{name}: Ergebnis bestätigen', { name }),
            (t) => t('Für „{battle}“ wurde ein Ergebnis gemeldet ({a}:{d} VP). Bitte bestätigen oder widersprechen.', { battle: battleLine(after, b, t), a: draft.update.vp?.attacker, d: draft.update.vp?.defender }),
            `confirm:${b.id}:${draft.at}`,
            confirmOpts(campaignId, b.id, p.id, draft.at),
          );
    }
    // Terminvorschlag
    for (const prop of b.proposals ?? []) {
      if ((old?.proposals ?? []).some((x) => x.id === prop.id)) continue;
      for (const p of players) {
        const s = sideOf(after, b, p.id);
        if (s && s !== prop.side)
          mail(
            campaignId,
            after,
            p,
            'PERSONAL',
            (t) => t('{name}: Terminvorschlag', { name }),
            (t) => t('Für „{battle}“ gibt es einen Terminvorschlag. Bitte einen Termin bestätigen oder neue vorschlagen.', { battle: battleLine(after, b, t) }),
            `proposal:${prop.id}`,
          );
      }
    }
  }

  // Handlungsbedarf der Spielleitung (Push an die SL-Konten)
  pushGmAlerts(campaignId, after, gmAlerts(before, after));

  // Events
  for (const e of after.events) {
    if (e.status === 'APPLIED' && before.events.find((x) => x.id === e.id)?.status !== 'APPLIED') {
      const ev = eventName(e);
      discord(campaignId, `**${name}** – ${dt('Event: {event}', { event: ev })}`, `event:${e.id}:${rev}`);
      for (const p of players)
        mail(
          campaignId,
          after,
          p,
          'RESULTS',
          (t) => t('{name}: Event {event}', { name, event: ev }),
          (t) => t('Das Event „{event}“ ist eingetreten.', { event: ev }),
          `event:${e.id}:${rev}`,
        );
    }
  }

  // Kampagnenende
  if (after.stage.kind === 'ENDED' && before.stage.kind !== 'ENDED') {
    const w = after.alliances.find((a) => a.id === after.result?.winnerAllianceId)?.name;
    discord(campaignId, w ? dt('**{name}** ist beendet – {winner} erobert die Vespator Front!', { name, winner: w }) : dt('**{name}** ist beendet.', { name }), 'ended');
    for (const p of players)
      mail(
        campaignId,
        after,
        p,
        'RESULTS',
        (t) => t('{name}: Kampagne beendet', { name }),
        (t) => (w ? t('{winner} hat die Kampagne gewonnen.', { winner: w }) : t('Die Kampagne ist beendet.')),
        'ended',
      );
  }
}

/** NTH2 1.5: Einmal-Link zum direkten Bestätigen/Widersprechen (in E-Mail und Push) */
function confirmOpts(campaignId: string, battleId: string, playerId: string, draftAt: string): { url?: string; extra?: (t: T) => string } {
  // F13: der Einmal-Link ist an den gültigen Spielerlink gebunden – ohne Spielerlink gibt es keinen
  if (!playerTokenFor(campaignId, playerId, false)) return {};
  const path = confirmLinkPath(campaignId, battleId, playerId, draftAt);
  return { url: path, extra: (t: T) => t('Direkt bestätigen oder widersprechen (ohne Anmeldung, nur einmal gültig): {link}', { link: `${appUrl()}${path}` }) };
}

// ─── Erinnern-Knopf (NTH2 2.7) ──────────────────────────────────────────────

/** Mindestabstand zwischen zwei Erinnerungen zur selben Schlacht */
export const REMIND_COOLDOWN_MS = 30 * 60_000;

const REMIND_TEXT: Record<ReminderReason, string> = {
  CONFIRM: 'Für „{battle}“ wartet ein gemeldetes Ergebnis auf deine Bestätigung.',
  DECISION: 'Für „{battle}“ fehlt noch die Outcome-Entscheidung deiner Seite.',
  SCHEDULE: 'Für „{battle}“ steht noch kein Termin fest. Bitte einen Termin vorschlagen oder annehmen.',
  CLASH: 'Der Termin für „{battle}“ überschneidet sich mit einer anderen Schlacht. Bitte einen neuen Termin abstimmen.',
  DEFENDER: 'Für „{battle}“ fehlt noch ein Verteidiger aus deiner Allianz.',
  ATTACKER: 'Für „{battle}“ fehlt noch ein Angreifer aus deiner Allianz.',
};

export type RemindResult = { ok: true; mails: number; push: number; discord: boolean; names: string[] } | { ok: false; error: string };

/**
 * Gezielte Erinnerung an die säumigen Spieler einer Schlacht (Aufgabe aus reminderTarget): E-Mail an jeden, der
 * persönliche Nachrichten nicht abbestellt hat; wer so nicht erreichbar ist, wird im Discord-Kanal genannt.
 */
export function remindBattle(campaignId: string, battleId: string, now = Date.now()): RemindResult {
  const st = currentState(campaignId).state;
  const b = st.battles.find((x) => x.id === battleId);
  if (!b) return { ok: false, error: 'Schlacht nicht gefunden' };
  const target = reminderTarget(st, b);
  if (!target) return { ok: false, error: 'Für diese Schlacht gibt es nichts zu erinnern' };
  const recent = db()
    .prepare('SELECT 1 FROM outbox WHERE campaign_id = ? AND dedupe_key LIKE ? AND created_at > ? LIMIT 1')
    .get(campaignId, `${campaignId}:remind:${battleId}:%`, new Date(now - REMIND_COOLDOWN_MS).toISOString());
  if (recent) return { ok: false, error: 'Zu dieser Schlacht wurde gerade erst erinnert – bitte später noch einmal' };
  const name = st.meta.name;
  const key = `remind:${battleId}:${now}`;
  const players = target.playerIds.map((id) => st.players.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const smtp = !!smtpConfig();
  const byMail = players.filter((p) => smtp && wants(p, 'PERSONAL'));
  const byPush = players.filter((p) => wantsPush(p, 'PERSONAL') && playerPushSubIds(campaignId, p.id).length > 0);
  const confirmFor = (p: Player) => (target.reason === 'CONFIRM' && b.draft ? confirmOpts(campaignId, b.id, p.id, b.draft.at) : {});
  for (const p of new Set([...byMail, ...byPush]))
    mail(
      campaignId,
      st,
      p,
      'PERSONAL',
      (t) => t('{name}: Erinnerung vom Warmaster', { name }),
      (t) => t(REMIND_TEXT[target.reason], { battle: battleLine(st, b, t) }),
      key,
      confirmFor(p),
    );
  const rest = players.filter((p) => !byMail.includes(p) && !byPush.includes(p));
  let viaDiscord = false;
  if (rest.length && discordWebhook(campaignId)) {
    const dt = makeT(campaignLocale(st));
    discord(campaignId, `**${name}** – ${dt('Erinnerung an {names}:', { names: rest.map((p) => p.nickname).join(', ') })} ${dt(REMIND_TEXT[target.reason], { battle: battleLine(st, b, dt) })}`, key);
    viaDiscord = true;
  }
  if (!byMail.length && !byPush.length && !viaDiscord) return { ok: false, error: 'Kein Versandweg: Die Spieler haben keine E-Mail-Adresse (oder persönliche Nachrichten abbestellt) und es gibt keinen Discord-Webhook' };
  return { ok: true, mails: byMail.length, push: byPush.length, discord: viaDiscord, names: players.map((p) => p.nickname) };
}

/**
 * Deadline-Erinnerungen 48 h und 12 h vorher – nur an Spieler mit offenen Aufgaben. Jede Kampagne einzeln: ein
 * Fehler in einer Kampagne hält die übrigen nicht auf (gemeldet über onError).
 */
export function scanDeadlines(now = Date.now(), onError: (id: string, e: unknown) => void = (id, e) => console.error('Deadlines fehlgeschlagen:', id, e)) {
  const rows = db().prepare('SELECT id FROM campaign WHERE archived = 0 AND sandbox_of IS NULL').all() as { id: string }[];
  for (const { id } of rows) {
    let st: CampaignState;
    try {
      st = currentState(id).state;
    } catch {
      continue;
    }
    try {
      scanCampaignDeadlines(id, st, now);
    } catch (e) {
      onError(id, e);
    }
  }
}

/** Test-Hook: Ausnahme je Kampagne simulieren (Isolation der Hintergrundaufgaben) */
export const deadlineHooks: { before?: (campaignId: string) => void } = {};

function scanCampaignDeadlines(id: string, st: CampaignState, now: number) {
  deadlineHooks.before?.(id);
  if (st.stage.kind !== 'PHASE') return;
  // NTH2 1.1: Meldungen, die seit über 48 h unbestätigt sind, als Handlungsbedarf an die Spielleitung
  pushGmAlerts(id, st, overdueAlerts(st, now));
  const phase = st.stage.phase;
  const ph = st.phases.find((p) => p.number === phase);
  if (!ph) return;
  const dt = makeT(campaignLocale(st));
  const name = st.meta.name;
  const windowOf = (iso: string | null) => {
    if (!iso) return null;
    const left = new Date(iso).getTime() - now;
    return left <= 0 ? null : left <= 12 * 3600_000 ? '12h' : left <= 48 * 3600_000 ? '48h' : null;
  };
  // Befehle
  const wOps = st.stage.step === 'OPS' ? windowOf(ph.opsDeadline) : null;
  if (wOps) {
    const open = st.fleets.filter((f) => !f.reserve && f.planetId && !ph.operations.some((o) => o.fleetId === f.id && !o.isDefault));
    const hOps = wOps === '12h' ? '12' : '48';
    if (open.length) discord(id, `**${name}** – ${dt('noch {h} Stunden für Befehle (Phase {n}).', { h: hOps, n: phase })}`, `dl:ops:${phase}:${wOps}:${ph.opsDeadline}`);
    for (const p of st.players) {
      const mine = open.filter((f) => f.commanders[String(phase)] === p.id);
      if (mine.length)
        mail(
          id,
          st,
          p,
          'DEADLINES',
          (t) => t('{name}: Befehl fehlt', { name }),
          (t) => t('Deine Flotte(n) {fleets} haben noch keinen Befehl. Deadline in {h} Stunden.', { fleets: mine.map((f) => f.name).join(', '), h: hOps }),
          `dl:ops:${phase}:${wOps}:${ph.opsDeadline}`,
        );
    }
  }
  // Schlachten
  const wBat = ['OPS', 'REVEAL', 'EDIFICES', 'BATTLES'].includes(st.stage.step) ? windowOf(ph.battlesDeadline) : null;
  if (wBat) {
    // Schlachten mit gemeldetem Ergebnis warten nur noch auf Bestätigung – keine Erinnerung
    const open = st.battles.filter((b) => b.phaseNumber === phase && b.status === 'SCHEDULED' && !b.draft);
    const hBat = wBat === '12h' ? '12' : '48';
    if (open.length) discord(id, `**${name}** – ${dt('noch {h} Stunden für {n} offene Schlacht(en).', { h: hBat, n: open.length })}`, `dl:bat:${phase}:${wBat}:${ph.battlesDeadline}`);
    for (const p of st.players) {
      const mine = open.filter((b) => sideOf(st, b, p.id));
      if (mine.length)
        mail(
          id,
          st,
          p,
          'DEADLINES',
          (t) => t('{name}: Schlacht noch offen', { name }),
          (t) => `${mine.map((b) => battleLine(st, b, t)).join('\n')}\n${t('Deadline in {h} Stunden.', { h: hBat })}`,
          `dl:bat:${phase}:${wBat}:${ph.battlesDeadline}`,
        );
    }
  }
}

// ─── Versand ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 8;
/** Zeitlimit für ausgehende Anfragen (Discord, Push) – ein hängender Dienst blockiert sonst den ganzen Versand */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/** Nach einem Neustart hängengebliebene Sendungen wieder freigeben */
export function releaseStaleSending() {
  db().prepare("UPDATE outbox SET status = 'PENDING' WHERE status = 'SENDING'").run();
}

export async function flushOutbox(limit = 50) {
  const g = globalThis as unknown as { __vfFlushing?: boolean };
  if (g.__vfFlushing) return;
  g.__vfFlushing = true;
  try {
    const now = new Date().toISOString();
    const rows = db()
      .prepare("SELECT id, campaign_id, channel, recipient, subject, body, attempts FROM outbox WHERE status = 'PENDING' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?")
      .all(MAX_ATTEMPTS, now, limit) as { id: number; campaign_id: string; channel: Channel; recipient: string; subject: string; body: string; attempts: number }[];
    if (!rows.length) return;
    const smtp = smtpConfig();
    const transport = smtp
      ? nodemailer.createTransport(smtpTransportOptions(smtp, OUTBOUND_TIMEOUT_MS))
      : null;
    for (const r of rows) {
      // atomar beanspruchen – ein paralleler Versand (andere Bundle-Kopie, Aktion) überspringt die Zeile
      if (db().prepare("UPDATE outbox SET status = 'SENDING' WHERE id = ? AND status = 'PENDING'").run(r.id).changes !== 1) continue;
      try {
        if (r.channel === 'DISCORD') {
          const url = discordWebhook(r.campaign_id);
          if (!url) throw new Error('Kein Discord-Webhook konfiguriert');
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: r.body.slice(0, 1900), allowed_mentions: { parse: [] } }),
            redirect: 'error',
            signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
          });
          if (res.status === 429) {
            // Discord-Rate-Limit: später erneut, ohne den Versuch zu zählen
            const retry = Number((await res.json().catch(() => ({}))).retry_after ?? 5);
            db()
              .prepare("UPDATE outbox SET status = 'PENDING', next_attempt_at = ? WHERE id = ?")
              .run(new Date(Date.now() + Math.max(1, retry) * 1000).toISOString(), r.id);
            continue;
          }
          if (!res.ok) throw new Error(`Discord ${res.status}`);
        } else if (r.channel === 'PUSH') {
          const res = await deliverPush(r.recipient, r.body);
          if (res.kind === 'MISSING' || res.kind === 'GONE') {
            // erloschenes Abonnement (404/410) oder gesperrter Spielerlink: nicht wiederholen
            db()
              .prepare("UPDATE outbox SET status = 'SKIPPED', attempts = attempts + 1, last_error = ? WHERE id = ?")
              .run(res.kind === 'GONE' ? 'Push-Abonnement abgelaufen – entfernt' : 'Push-Abonnement nicht mehr vorhanden – übersprungen', r.id);
            continue;
          }
          if (res.kind === 'RETRY') {
            db()
              .prepare("UPDATE outbox SET status = 'PENDING', next_attempt_at = ? WHERE id = ?")
              .run(new Date(Date.now() + res.afterSeconds * 1000).toISOString(), r.id);
            continue;
          }
          if (res.kind === 'ERROR') throw new Error(`Push-Dienst ${res.status}`);
        } else {
          if (!transport || !smtp) {
            // ältere Einträge aus der Zeit ohne SMTP: klar markieren und überspringen statt endlos zu wiederholen
            db().prepare("UPDATE outbox SET status = 'SKIPPED', last_error = ? WHERE id = ?").run('SMTP ist nicht eingerichtet – übersprungen', r.id);
            continue;
          }
          await transport.sendMail({ from: smtp.from, to: r.recipient, subject: r.subject, text: r.body });
        }
        db().prepare("UPDATE outbox SET status = 'SENT', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), r.id);
      } catch (e) {
        // exponentieller Abstand: 1, 2, 4, 8 … Minuten
        const failed = r.attempts + 1 >= MAX_ATTEMPTS;
        const next = new Date(Date.now() + 2 ** r.attempts * 60_000).toISOString();
        db()
          .prepare('UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?')
          .run(failed ? 'FAILED' : 'PENDING', e instanceof Error ? e.message : String(e), next, r.id);
      }
    }
  } finally {
    g.__vfFlushing = false;
  }
}

export function outboxStatus(campaignId: string, limit = 20) {
  return db().prepare('SELECT id, channel, recipient, subject, status, attempts, last_error, created_at, sent_at FROM outbox WHERE campaign_id = ? ORDER BY id DESC LIMIT ?').all(campaignId, limit) as {
    id: number;
    channel: Channel;
    recipient: string;
    subject: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    sent_at: string | null;
  }[];
}

export function retryOutbox(campaignId: string) {
  db().prepare("UPDATE outbox SET status = 'PENDING', attempts = 0, next_attempt_at = NULL WHERE campaign_id = ? AND status = 'FAILED'").run(campaignId);
}

/** Testnachricht über Discord bzw. an eine E-Mail-Adresse */
/** F10: Test-E-Mails je Konto begrenzen (5 pro Stunde) – der Club-SMTP ist kein Versandrelais */
const testMails = new Map<string, number[]>();
export function testMailLimited(key: string, now = Date.now(), max = 5): boolean {
  const list = (testMails.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= max) {
    testMails.set(key, list);
    return true;
  }
  list.push(now);
  testMails.set(key, list);
  return false;
}

export function sendTest(campaignId: string, email: string | null) {
  const st = currentState(campaignId).state;
  const key = `test:${Date.now()}`;
  const t = makeT(campaignLocale(st));
  if (email) {
    if (!smtpConfig()) throw new Error('SMTP ist nicht eingerichtet – bitte zuerst den E-Mail-Versand konfigurieren');
    enqueue({ campaignId, channel: 'EMAIL', recipient: email, subject: t('{name}: Testnachricht', { name: st.meta.name }), body: t('Wenn du das liest, funktioniert der E-Mail-Versand.'), key });
  } else discord(campaignId, `**${st.meta.name}** – ${t('Testnachricht: Der Discord-Versand funktioniert.')}`, key);
}

/** Sprache der Abmeldeseite: die des Spielers, sonst Standard der Kampagne */
export function unsubscribeLocale(campaignId: string, p: Pick<Player, 'locale'>): Locale {
  try {
    return mailLocale(p, currentState(campaignId).state);
  } catch {
    return contextLocale(p.locale);
  }
}

export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = ['PHASE', 'RESULTS', 'DEADLINES', 'PERSONAL'];

/** Kategorien für einen Abmeldelink – nur bekannte Werte (oder 'ALL'), sonst null */
export function unsubscribeCategories(category: unknown): NotifyCategory[] | null {
  if (category === 'ALL') return [...NOTIFY_CATEGORIES];
  return NOTIFY_CATEGORIES.includes(category as NotifyCategory) ? [category as NotifyCategory] : null;
}

/** Einzelnen Spieler von einer Kategorie abmelden (für die Abmeldeseite) */
export function playerForUnsubscribe(campaignId: string, playerId: string): Player | null {
  try {
    return currentState(campaignId).state.players.find((p) => p.id === playerId) ?? null;
  } catch {
    return null;
  }
}
