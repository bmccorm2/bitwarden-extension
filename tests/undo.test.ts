import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { latestUndo, pushUndo } from '../src/lib/vault';
import type { RawCipher } from '../src/lib/types';

const cipher = (id: string, name: string) =>
  ({ id, type: 1, name, revisionDate: 'r', key: null, login: { fido2Credentials: [{ x: 1 }] } }) as unknown as RawCipher;

describe('undo store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('keeps a deep copy of the original, newest first', async () => {
    const c = cipher('a', '2.old');
    await pushUndo('update', c);
    c.name = 'mutated';
    await pushUndo('trash', cipher('a', '2.newer'));
    const e = await latestUndo('a');
    expect(e?.op).toBe('trash');
    expect(e?.cipher.name).toBe('2.newer');
    const all = (await fakeBrowser.storage.local.get('undo')).undo as { cipher: RawCipher }[];
    expect(all[1]!.cipher.name).toBe('2.old');
    expect(all[1]!.cipher.login?.fido2Credentials).toEqual([{ x: 1 }]);
    expect(await latestUndo('missing')).toBeNull();
  });

  it('keeps only the last 100', async () => {
    for (let i = 0; i < 105; i++) await pushUndo('update', cipher(`id${i}`, `2.${i}`));
    const all = (await fakeBrowser.storage.local.get('undo')).undo as { id: string }[];
    expect(all).toHaveLength(100);
    expect(all[0]!.id).toBe('id104');
    expect(all[99]!.id).toBe('id5');
  });
});
