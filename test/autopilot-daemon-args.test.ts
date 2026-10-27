/**
 * `gbrain autopilot --install` used to rewrite the daemon command as
 * `autopilot --repo <path>` and drop `--no-worker` (passed on the install
 * command, or already in the launchd plist / systemd unit / wrapper).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argvFromPlist,
  argvFromUnit,
  findManagedWorkerService,
  formatDaemonArgTail,
  looksLikeManagedWorker,
  readInstalledDaemonArgSources,
  resolveAutopilotDaemonArgs,
  sanitizeDaemonArgs,
  type TextFs,
} from '../src/commands/autopilot/daemon-args.ts';
import { execStartProgram, unitWrapperPath } from '../src/commands/autopilot/jobs.ts';
import { generateLaunchdPlist, generateSystemdUnit, migrateSystemdUnitToRestartAlways, writeWrapperScript } from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

function memFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): TextFs {
  return {
    read: (path) => (Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null),
    list: (dir) => dirs[dir] ?? [],
  };
}

function plist(args: string[]): string {
  const strings = args.map((arg) => `    <string>${arg}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key><array>
${strings}
  </array>
</dict></plist>`;
}

describe('resolveAutopilotDaemonArgs', () => {
  test('flags passed to --install are kept, and install-only flags are not', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install', '--repo', '/brain', '--target', 'macos', '--force', '--no-worker', '--inline', '--interval', '600'],
    });
    expect(resolved.args).toEqual(['--interval', '600', '--inline', '--no-worker']);
    expect(resolved.note).toContain('from this --install command');
  });

  test('--json on --install is the consent format, not a daemon flag', () => {
    const resolved = resolveAutopilotDaemonArgs({ installArgs: ['--install', '--json', '--no-worker'] });
    expect(resolved.args).toEqual(['--no-worker']);
    expect(resolved.args).not.toContain('--json');
  });

  test('a non-numeric --interval is dropped instead of being copied into the shell script', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install', '--interval', '60; touch /tmp/pwned', '--no-worker'],
    });
    expect(resolved.args).toEqual(['--no-worker']);
    expect(formatDaemonArgTail(resolved.args)).toBe(' --no-worker');
    expect(formatDaemonArgTail(['--interval', '$(touch /tmp/pwned)'])).toBe('');
  });

  test('an installed plist ProgramArguments --no-worker survives a reinstall that does not repeat it', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install', '--repo', '/brain'],
      plist: plist(['/Users/me/.gbrain/autopilot-run.sh', '--no-worker']),
    });
    expect(resolved.args).toEqual(['--no-worker']);
    expect(resolved.note).toContain('kept from the installed service');
  });

  test('a plist that invokes gbrain directly still yields its daemon flags', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install'],
      plist: plist(['/usr/local/bin/gbrain', 'autopilot', '--repo', '/brain', '--interval', '600', '--no-worker']),
    });
    expect(resolved.args).toEqual(['--interval', '600', '--no-worker']);
  });

  test('this install\'s --interval wins, and a preserved --no-worker stays', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install', '--interval', '60'],
      unit: 'ExecStart=/Users/me/.gbrain/autopilot-run.sh --interval 300 --no-worker\n',
    });
    expect(resolved.args).toEqual(['--interval', '60', '--no-worker']);
    expect(resolved.note).toContain('from this --install command');
    expect(resolved.note).toContain('kept from the installed service');
  });

  test('wrapper exec lines and a crontab line are read, including a preserved --json', () => {
    const wrapper = [
      '#!/bin/bash',
      "exec '/usr/bin/gbrain' autopilot --repo '/brain' --json --no-worker",
      'exec "$_resolved" autopilot --repo \'/brain\' --json --no-worker',
    ].join('\n');
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install'],
      wrapper,
      script: "*/5 * * * * '/Users/me/.gbrain/autopilot-run.sh' --inline >> /tmp/autopilot.log 2>&1",
    });
    expect(resolved.args).toEqual(['--json', '--inline', '--no-worker']);
  });

  test('a managed jobs worker selects --no-worker when the install did not', () => {
    const resolved = resolveAutopilotDaemonArgs({
      installArgs: ['--install'],
      managedWorkerPath: '/Users/me/Library/LaunchAgents/com.gbrain.worker.plist',
    });
    expect(resolved.args).toEqual(['--no-worker']);
    expect(resolved.note).toContain('com.gbrain.worker.plist');
  });

  test('no flags and no managed worker leaves the historical command unchanged', () => {
    const resolved = resolveAutopilotDaemonArgs({ installArgs: ['--install', '--repo', '/brain', '--force'] });
    expect(resolved.args).toEqual([]);
    expect(resolved.note).toBeNull();
    expect(formatDaemonArgTail([])).toBe('');
  });
});

describe('managed worker detection', () => {
  const home = '/Users/me';
  const agents = `${home}/Library/LaunchAgents`;
  const worker = `${agents}/com.gbrain.worker.plist`;
  const serve = `${agents}/com.gbrain.serve.plist`;
  const custom = `${agents}/com.example.jobs.plist`;

  test('com.gbrain.worker and a custom jobs-supervisor plist count; serve does not', () => {
    const workerText = plist(['/usr/local/bin/gbrain', 'jobs', 'work', '--queue', 'default']);
    const serveText = plist(['/Users/me/.gbrain/serve-run.sh']);
    const customText = '[Service]\nExecStart=/usr/local/bin/gbrain jobs supervisor\n';
    expect(looksLikeManagedWorker(workerText)).toBe(true);
    expect(looksLikeManagedWorker(serveText)).toBe(false);
    expect(looksLikeManagedWorker(customText)).toBe(true);
    const fs = memFs(
      { [worker]: workerText, [serve]: serveText, [custom]: customText },
      { [agents]: ['com.gbrain.worker.plist', 'com.gbrain.serve.plist', 'com.example.jobs.plist'] },
    );
    expect(findManagedWorkerService(home, fs, `${home}/missing.service`)).toBe(worker);
  });

  test('a custom name is found when the well-known worker plist is absent', () => {
    const customText = plist(['/usr/bin/gbrain', 'jobs', 'supervisor']);
    const fs = memFs(
      { [custom]: customText, [serve]: plist(['/Users/me/.gbrain/serve-run.sh']) },
      { [agents]: ['com.gbrain.serve.plist', 'com.example.jobs.plist'] },
    );
    expect(findManagedWorkerService(home, fs, `${home}/missing.service`)).toBe(custom);
  });

  test('the documented system unit counts', () => {
    const etc = '/etc/systemd/system/gbrain-worker.service';
    const fs = memFs({ [etc]: 'ExecStart=/usr/bin/gbrain jobs supervisor\n' }, { [agents]: [] });
    expect(findManagedWorkerService(home, fs, etc)).toBe(etc);
  });
});

describe('service definition shape', () => {
  test('launchd lists each flag as its own ProgramArgument and systemd appends them to ExecStart', () => {
    const args = ['--interval', '600', '--no-worker'];
    const plistText = generateLaunchdPlist('/Users/me/.gbrain/autopilot-run.sh', '/Users/me', undefined, args);
    expect(argvFromPlist(plistText)).toEqual(['/Users/me/.gbrain/autopilot-run.sh', '--interval', '600', '--no-worker']);
    expect(plistText).toContain('<string>--no-worker</string>');

    const plain = generateLaunchdPlist('/Users/me/.gbrain/autopilot-run.sh', '/Users/me');
    expect(plain).toContain('<string>/Users/me/.gbrain/autopilot-run.sh</string>\n  </array>');
    expect(plain).not.toContain('--no-worker');

    const unit = generateSystemdUnit('/Users/me/.gbrain/autopilot-run.sh', undefined, args);
    expect(unit).toContain('ExecStart=/Users/me/.gbrain/autopilot-run.sh --interval 600 --no-worker\n');
    expect(argvFromUnit(unit)).toEqual(['/Users/me/.gbrain/autopilot-run.sh', '--interval', '600', '--no-worker']);
    expect(unitWrapperPath(unit)).toBe('/Users/me/.gbrain/autopilot-run.sh');

    const plainUnit = generateSystemdUnit('/Users/me/.gbrain/autopilot-run.sh');
    expect(plainUnit).toContain('ExecStart=/Users/me/.gbrain/autopilot-run.sh\n');
  });

  test('ExecStart program path keeps internal spaces and drops only trailing flags', () => {
    const spaced = '/Users/me/My Brain/.gbrain/autopilot-run.sh';
    expect(execStartProgram(`${spaced} --interval 600 --no-worker`)).toBe(spaced);
    expect(execStartProgram(spaced)).toBe(spaced);
    expect(execStartProgram(`"${spaced}" --no-worker`)).toBe(spaced);
    expect(unitWrapperPath(`ExecStart=${spaced} --no-worker\n`)).toBe(spaced);
  });

  test('a spaced program is quoted once flags are added, and the unit parser still finds it', () => {
    const spaced = '/Users/me/My Brain/.gbrain/autopilot-run.sh';
    const unit = generateSystemdUnit(spaced, undefined, ['--no-worker']);
    expect(unit).toContain(`ExecStart="${spaced}" --no-worker\n`);
    expect(unitWrapperPath(unit)).toBe(spaced);
    expect(sanitizeDaemonArgs(argvFromUnit(unit))).toEqual(['--no-worker']);
  });
});

describe('readInstalledDaemonArgSources', () => {
  test('re-reads a hand-edited plist and a worker service without being passed --no-worker again', () => {
    const home = '/Users/me';
    const agents = `${home}/Library/LaunchAgents`;
    const wrapper = `${home}/.gbrain/autopilot-run.sh`;
    const plistPath = `${agents}/com.gbrain.autopilot.plist`;
    const worker = `${agents}/com.gbrain.worker.plist`;
    const fs = memFs({
      [wrapper]: "#!/bin/bash\nexec '/usr/bin/gbrain' autopilot --repo '/brain'\n",
      [plistPath]: plist([wrapper, '--interval', '600']),
      [worker]: plist(['/usr/bin/gbrain', 'jobs', 'work']),
    }, { [agents]: ['com.gbrain.autopilot.plist', 'com.gbrain.worker.plist'] });
    const resolved = readInstalledDaemonArgSources(['--install'], {
      wrapperPath: wrapper,
      launchdLabel: 'com.gbrain.autopilot',
      systemdUnit: 'gbrain-autopilot.service',
      startScriptPath: `${home}/.gbrain/start-autopilot.sh`,
    }, { home, fs, crontab: null, etcWorkerPath: `${home}/missing.service` });
    expect(resolved.args).toEqual(['--interval', '600', '--no-worker']);
  });
});

describe('writeWrapperScript bakes daemon flags', () => {
  test('both exec lines carry the flags, and bash runs gbrain with them once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-daemon-args-'));
    const bin = mkdtempSync(join(tmpdir(), 'gbrain-daemon-args-bin-'));
    const repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\necho "ARGS:$*"\nexit 0\n', { mode: 0o755 });
    try {
      let wrapperPath = '';
      await withEnv({ HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` }, async () => {
        wrapperPath = writeWrapperScript(repo, 'linux-cron', undefined, ['--no-worker', '--interval', '600', '--interval', '60;rm']);
      });
      const src = readFileSync(wrapperPath, 'utf8');
      expect(src).not.toContain('"$@"');
      const execs = src.split('\n').filter((line) => line.trimStart().startsWith('exec '));
      expect(execs).toHaveLength(2);
      for (const line of execs) {
        expect(line).toContain(`autopilot --repo '${repo}' --interval 600 --no-worker`);
        expect(line).not.toContain('rm');
      }
      const run = spawnSync('bash', [wrapperPath], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15_000 });
      expect(run.status).toBe(0);
      const hits = run.stdout.split('\n').filter((line) => line.startsWith('ARGS:'));
      expect(hits).toEqual([`ARGS:autopilot --repo ${repo} --interval 600 --no-worker`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('migrateSystemdUnitToRestartAlways keeps daemon flags', () => {
  test('rewriting Restart=on-failure does not drop ExecStart flags', async () => {
    if (process.platform !== 'linux') return;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-daemon-args-unit-'));
    const unitDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    const program = join(home, '.gbrain', 'autopilot-run.sh');
    const unitPath = join(unitDir, 'gbrain-autopilot.service');
    writeFileSync(unitPath, `[Unit]
Description=GBrain Autopilot
[Service]
ExecStart=${program} --no-worker --interval 600
Restart=on-failure
StandardOutput=append:%h/.gbrain/autopilot.log
StandardError=append:%h/.gbrain/autopilot.err
`);
    try {
      let result = { rewritten: false, reason: '' };
      await withEnv({ HOME: home }, async () => {
        result = migrateSystemdUnitToRestartAlways();
      });
      expect(result).toEqual({ rewritten: true, reason: 'rewritten' });
      const next = readFileSync(unitPath, 'utf8');
      expect(next).toContain('Restart=always');
      expect(next).toContain(`ExecStart=${program} --interval 600 --no-worker`);
      expect(unitWrapperPath(next)).toBe(program);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
