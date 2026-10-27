/**
 * Moving ~/.gbrain (or only its persistence directory) onto another directory
 * and leaving a symlink at the recorded path must not refuse writes.
 *
 * The reservation stores the coordination lock path from before the move.
 * realpath then names the link target, so a realpath-equality check threw
 * recovery_required on every worktree lock — the write_refused flood after
 * ~/.gbrain became a symlink to an external volume. The home and persistence
 * directories are the operator's install, so they may be symlinks. A symlink
 * inside persistence/locks is still a substituted lock.
 *
 * Unicode normalization is synthetic: ext4 is normalization-sensitive, so
 * spyOn makes realpath answer with the NFD spelling of an NFC path, which is
 * what APFS does for a non-ASCII volume name. The spy is process-global and
 * restored in finally; GBRAIN_HOME is held across the claim, so this file is
 * serial.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree } from '../src/core/persistence/ownership.ts';
import { physicalRootReservationPath, readPhysicalRootReservation } from '../src/core/persistence/physical-root-record.ts';
import { withEnv } from './helpers/with-env.ts';

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'gbrain-home-symlink-')));
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  fs.rmSync(base, { recursive: true, force: true });
});

const NFC = 'caf\u00e9';
const NFD = NFC.normalize('NFD');

function replaceWithSymlink(path: string, targetParent: string): string {
  const target = join(targetParent, basename(path));
  fs.mkdirSync(targetParent, { recursive: true });
  fs.renameSync(path, target);
  fs.symlinkSync(target, path);
  return target;
}

async function claimed(home: string): Promise<{ sourceId: string; root: string; coordination: string; binding: NonNullable<Awaited<ReturnType<typeof claimWorktree>>> }> {
  const root = join(home, 'checkout');
  const sourceId = `home-symlink-${randomUUID()}`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, 'page.md'), 'Canonical example\n');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root);
  return { sourceId, root, coordination: binding.coordination_path!, binding };
}

test('a symlink at the gbrain home, including a non-ASCII target, keeps the recorded lock', async () => {
  const home = join(base, 'whole-home');
  const volume = join(base, NFD + '-volume');
  await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: undefined }, async () => {
    const claimedHome = await claimed(home);
    const gbrain = join(home, '.gbrain');
    replaceWithSymlink(gbrain, volume);
    expect(fs.realpathSync(claimedHome.coordination)).not.toBe(claimedHome.coordination);
    expect(fs.realpathSync(claimedHome.coordination).normalize('NFC')).toContain(NFC);
    expect(readPhysicalRootReservation(claimedHome.root)?.coordinationPath).toBe(claimedHome.coordination);
    const lock = await acquireWorktree(claimedHome.binding);
    expect(lock).not.toBeNull();
    await lock!.release();
    const { checkCoordinationLockLocation } = await import('../src/commands/doctor/checks/coordination-lock.ts');
    const doctor = await checkCoordinationLockLocation(engine);
    expect(doctor.status).toBe('ok');
    expect(doctor.details).not.toMatchObject({ unstable: expect.anything() });
  });
}, 30_000);

test('a symlink of only the persistence directory keeps the recorded lock', async () => {
  const home = join(base, 'persistence-home');
  await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: undefined }, async () => {
    const claimedHome = await claimed(home);
    replaceWithSymlink(join(home, '.gbrain', 'persistence'), join(base, 'persistence-target'));
    expect(fs.realpathSync(claimedHome.coordination)).not.toBe(claimedHome.coordination);
    const lock = await acquireWorktree(claimedHome.binding);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
}, 30_000);

test('a symlink inside persistence/locks refuses and doctor names the checkout', async () => {
  const home = join(base, 'locks-home');
  await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: undefined }, async () => {
    const claimedHome = await claimed(home);
    replaceWithSymlink(join(home, '.gbrain', 'persistence', 'locks'), join(base, 'locks-target'));
    await expect(acquireWorktree(claimedHome.binding)).rejects.toMatchObject({
      code: 'recovery_required', detail: 'coordination_path_unstable',
    });
    const { checkCoordinationLockLocation } = await import('../src/commands/doctor/checks/coordination-lock.ts');
    const doctor = await checkCoordinationLockLocation(engine);
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain(claimedHome.sourceId);
    expect(doctor.message).toContain('coordination lock recorded at');
    expect(doctor.message).toContain('persistence/locks');
  });
}, 30_000);

test('Unicode normalization of a real lock path is not a substituted lock; a different realpath is', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(base, 'unicode-root-')));
  const lockDir = fs.realpathSync(fs.mkdtempSync(join(base, 'unicode-lock-')));
  const canonical = root;
  const nfc = join(lockDir, `${NFC}.lock`);
  const nfd = nfc.normalize('NFD');
  fs.writeFileSync(nfc, '');
  const record = { version: 1, token: randomUUID(), brainId: randomUUID(), worktreeId: randomUUID(), hostId: randomUUID(),
    root: canonical, coordinationPath: nfc, initialDevice: null, initialInode: null, initialBirth: null };
  const reservation = physicalRootReservationPath(canonical);
  fs.mkdirSync(dirname(reservation), { recursive: true });
  fs.writeFileSync(reservation, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(reservation, 0o600);
  const original = fs.realpathSync;
  const spell = (answered: string) => spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, opts?: unknown) =>
    String(path) === nfc ? answered : original(path, opts as never)) as typeof fs.realpathSync);
  const nfdSpy = spell(nfd);
  try { expect(readPhysicalRootReservation(canonical)?.coordinationPath).toBe(nfc); }
  finally { nfdSpy.mockRestore(); }
  const other = spell(join(canonical, 'elsewhere.lock'));
  try {
    expect(() => readPhysicalRootReservation(canonical)).toThrow(expect.objectContaining({
      code: 'recovery_required', detail: 'coordination_path_unstable',
    }));
  } finally { other.mockRestore(); }
});
