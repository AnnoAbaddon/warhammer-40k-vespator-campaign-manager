import 'server-only';
import path from 'node:path';

/**
 * Pfad innerhalb eines Basisverzeichnisses: löst die Teile auf und wirft, wenn das Ergebnis das Verzeichnis
 * verlässt (z. B. durch „..“ oder einen absoluten Pfad). Für alle Dateipfade, die IDs oder Dateinamen enthalten.
 */
export function insideDir(base: string, ...parts: string[]): string {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Ungültiger Pfad');
  return full;
}
