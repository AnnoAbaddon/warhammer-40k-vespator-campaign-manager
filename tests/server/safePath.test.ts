import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideDir } from '@/server/safePath';

describe('insideDir', () => {
  const base = path.resolve('some-base');

  it('löst Pfade innerhalb des Verzeichnisses auf', () => {
    expect(insideDir(base, 'abc123')).toBe(path.join(base, 'abc123'));
    expect(insideDir(base, 'abc123', '2026-10-01T03-00-00-000.zip')).toBe(path.join(base, 'abc123', '2026-10-01T03-00-00-000.zip'));
    expect(insideDir(base)).toBe(base);
  });

  it('wirft bei Pfaden außerhalb', () => {
    expect(() => insideDir(base, '..')).toThrow('Ungültiger Pfad');
    expect(() => insideDir(base, '../other')).toThrow('Ungültiger Pfad');
    expect(() => insideDir(base, 'a', '../../x')).toThrow('Ungültiger Pfad');
    expect(() => insideDir(base, path.resolve('/etc'))).toThrow('Ungültiger Pfad');
    expect(() => insideDir(base, '..' + path.sep + path.basename(base) + '-evil')).toThrow('Ungültiger Pfad');
  });
});
