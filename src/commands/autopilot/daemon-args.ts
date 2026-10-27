/**
 * Runtime flags for an installed autopilot daemon.
 *
 * `gbrain autopilot --install` rewrites the wrapper, the launchd plist and the
 * systemd unit. The daemon command used to be a fixed `autopilot --repo <path>`,
 * so a later install dropped `--no-worker` (and `--interval` / `--inline`)
 * whether the operator passed them to `--install` or had edited them onto the
 * plist ProgramArguments / unit ExecStart. The wrapper's exec line is the
 * command every supervisor actually runs; the plist and the unit carry the
 * same flags. The wrapper does not forward "$@", so a supervisor that also
 * passes the flags cannot apply them twice.
 *
 * `--json` on `--install` is the consent-refusal format, not a daemon mode,
 * so it is kept only when the installed command already had it.
 */
import { execSync } from '../../core/spawn.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BOOLEAN_FLAGS = new Set(['--no-worker', '--inline', '--json']);

export interface DaemonArgSources {
  installArgs?: readonly string[];
  plist?: string | null;
  unit?: string | null;
  wrapper?: string | null;
  script?: string | null;
  /** Set when a separate launchd/systemd jobs worker is installed. */
  managedWorkerPath?: string | null;
}

export interface ResolvedDaemonArgs {
  args: string[];
  /** Operator log line, or null when the daemon command gains no flags. */
  note: string | null;
}

interface Collected {
  interval: string | null;
  flags: Set<string>;
}

function blank(): Collected {
  return { interval: null, flags: new Set() };
}

/** Split a shell snippet into words. Separators never become tokens. */
export function shellWords(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  const split = new Set([' ', '\t', '\n', '\r', '<', '>', '|', '&', ';']);
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'" && input.slice(i, i + 4) === "'\\''") {
        cur += "'";
        i += 3;
        continue;
      }
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === "'") { quote = "'"; continue; }
    if (c === '"') { quote = '"'; continue; }
    if (c === '\\' && i + 1 < input.length) { cur += input[++i]; continue; }
    if (split.has(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function collect(argv: readonly string[], allowJson: boolean, into: Collected): boolean {
  let hit = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--repo') { i++; continue; }
    if (token === '--interval') {
      const value = argv[++i];
      if (value && /^[0-9]{1,7}$/.test(value)) {
        const n = Number(value);
        if (n > 0) { into.interval = String(n); hit = true; }
      }
      continue;
    }
    if (token === '--json' && !allowJson) continue;
    if (BOOLEAN_FLAGS.has(token)) { into.flags.add(token); hit = true; }
  }
  return hit;
}

function canonical(into: Collected): string[] {
  const out: string[] = [];
  if (into.interval) out.push('--interval', into.interval);
  if (into.flags.has('--json')) out.push('--json');
  if (into.flags.has('--inline')) out.push('--inline');
  if (into.flags.has('--no-worker')) out.push('--no-worker');
  return out;
}

/** Allowlisted daemon flags in stable order. Anything else is dropped. */
export function sanitizeDaemonArgs(argv: readonly string[]): string[] {
  const into = blank();
  collect(argv, true, into);
  return canonical(into);
}

/** Shell-safe suffix (`''` or ` --no-worker --interval 600`). No metacharacters. */
export function formatDaemonArgTail(args: readonly string[]): string {
  const safe = sanitizeDaemonArgs(args);
  return safe.length ? ` ${safe.join(' ')}` : '';
}

/**
 * systemd ExecStart. Unchanged when there are no flags (paths with spaces
 * stay unquoted, matching the historical unit). With flags, a path that
 * contains whitespace or quotes is quoted so the flags stay separate argv.
 */
export function systemdExecStart(program: string, args: readonly string[]): string {
  const tail = formatDaemonArgTail(args);
  if (!tail) return program;
  const quoted = /[\s"]/.test(program) ? `"${program.replace(/"/g, '\\"')}"` : program;
  return `${quoted}${tail}`;
}

export function argvFromPlist(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) return [];
  const out: string[] = [];
  for (const match of block[1].matchAll(/<string>([^<]*)<\/string>/g)) {
    out.push(...shellWords(unescapeXml(match[1]).trim()));
  }
  return out;
}

export function argvFromUnit(unit: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  return line ? shellWords(line.trim()) : [];
}

export function argvFromWrapper(wrapper: string): string[] {
  const out: string[] = [];
  for (const line of wrapper.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('exec ')) continue;
    out.push(...shellWords(trimmed.slice('exec '.length)));
  }
  return out;
}

export function argvFromScript(script: string): string[] {
  const out: string[] = [];
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.push(...shellWords(trimmed));
  }
  return out;
}

export function resolveAutopilotDaemonArgs(sources: DaemonArgSources): ResolvedDaemonArgs {
  const preserved = blank();
  let hadPreserved = false;
  const texts: Array<[string, (text: string) => string[]]> = [];
  if (sources.script) texts.push([sources.script, argvFromScript]);
  if (sources.unit) texts.push([sources.unit, argvFromUnit]);
  if (sources.plist) texts.push([sources.plist, argvFromPlist]);
  if (sources.wrapper) texts.push([sources.wrapper, argvFromWrapper]);
  for (const [text, parse] of texts) {
    if (collect(parse(text), true, preserved)) hadPreserved = true;
  }

  const fromInstall = blank();
  const hadInstall = collect(sources.installArgs ?? [], false, fromInstall);
  if (fromInstall.interval) preserved.interval = fromInstall.interval;
  for (const flag of fromInstall.flags) preserved.flags.add(flag);

  const managed = sources.managedWorkerPath || null;
  if (managed) preserved.flags.add('--no-worker');

  const args = canonical(preserved);
  const why: string[] = [];
  if (hadInstall) why.push('from this --install command');
  if (hadPreserved) why.push('kept from the installed service');
  if (managed) why.push(`a managed jobs worker is installed at ${managed}`);
  return { args, note: args.length ? `Daemon flags: ${args.join(' ')} (${why.join('; ')}).` : null };
}

export interface TextFs {
  read(path: string): string | null;
  list(dir: string): string[];
}

const nodeTextFs: TextFs = {
  read(path) {
    try { return readFileSync(path).subarray(0, 256 * 1024).toString('utf8'); } catch { return null; }
  },
  list(dir) {
    try { return readdirSync(dir); } catch { return []; }
  },
};

const KNOWN_WORKER_REL = [
  'Library/LaunchAgents/com.gbrain.worker.plist',
  'Library/LaunchAgents/com.user.gbrain-worker.plist',
  '.config/systemd/user/gbrain-worker.service',
];

function serviceFileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

function isAutopilotOrServeName(name: string): boolean {
  return name === 'com.gbrain.autopilot.plist'
    || name.startsWith('com.gbrain.autopilot.')
    || name === 'com.gbrain.serve.plist'
    || name === 'gbrain-autopilot.service'
    || name.startsWith('gbrain-autopilot-')
    || name === 'gbrain-serve.service';
}

/** A jobs worker unit: `gbrain` plus `jobs work` or `jobs supervisor`. */
export function looksLikeManagedWorker(text: string): boolean {
  const flat = text.replace(/<[^>]+>/g, '\n');
  return /gbrain/i.test(flat) && /\bjobs\b/.test(flat) && /\b(?:work|supervisor)\b/.test(flat);
}

function looksLikeAutopilot(text: string): boolean {
  return /autopilot-run\.sh/.test(text) || /Description=GBrain Autopilot/.test(text) || /com\.gbrain\.autopilot/.test(text);
}

function knownWorkerFile(text: string | null): boolean {
  if (!text?.trim()) return false;
  if (looksLikeManagedWorker(text)) return true;
  if (looksLikeAutopilot(text)) return false;
  return /ProgramArguments|ExecStart|\[Service\]/.test(text);
}

function under(root: string, ...parts: string[]): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- root is the operator HOME or a fixed systemd directory; parts are constant service-relative names or a single directory entry matched to ^[A-Za-z0-9._-]+$
  return join(root, ...parts);
}

/**
 * A launchd/systemd jobs worker installed beside autopilot.
 * Known names (`com.gbrain.worker`, `com.user.gbrain-worker`, `gbrain-worker.service`)
 * count when the file is a service definition. Any other agent/unit counts
 * only when its text is a gbrain jobs worker. Autopilot and serve are skipped.
 */
export function findManagedWorkerService(
  home: string,
  fs: TextFs = nodeTextFs,
  etcPath = '/etc/systemd/system/gbrain-worker.service',
): string | null {
  const known = [...KNOWN_WORKER_REL.map((rel) => under(home, rel)), etcPath];
  for (const path of known) {
    if (knownWorkerFile(fs.read(path))) return path;
  }
  const dirs = [under(home, 'Library', 'LaunchAgents'), under(home, '.config', 'systemd', 'user')];
  for (const dir of dirs) {
    for (const name of fs.list(dir)) {
      if (!serviceFileName(name) || isAutopilotOrServeName(name)) continue;
      if (!name.endsWith('.plist') && !name.endsWith('.service')) continue;
      const path = under(dir, name);
      if (known.includes(path)) continue;
      const text = fs.read(path);
      if (text && looksLikeManagedWorker(text)) return path;
    }
  }
  return null;
}

function readCrontab(): string | null {
  try {
    const out = execSync('crontab -l 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = String(out).split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return trimmed.includes('autopilot-run.sh') || (trimmed.includes('gbrain autopilot') && !trimmed.includes('--status'));
    });
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

export interface AutopilotJobPaths {
  wrapperPath: string;
  launchdLabel: string;
  systemdUnit: string;
  startScriptPath: string;
}

/**
 * Read the installed plist, unit, wrapper, start script and crontab.
 * `crontab: null` skips the live crontab (tests). The default reads it.
 */
export function readInstalledDaemonArgSources(
  installArgs: readonly string[],
  job: AutopilotJobPaths,
  opts: { home?: string; fs?: TextFs; crontab?: string | null; etcWorkerPath?: string } = {},
): ResolvedDaemonArgs {
  const fs = opts.fs ?? nodeTextFs;
  const home = opts.home ?? (process.env.HOME || homedir());
  const label = serviceFileName(job.launchdLabel) ? job.launchdLabel : '';
  const unitName = serviceFileName(job.systemdUnit) ? job.systemdUnit : '';
  const plist = label ? fs.read(under(home, 'Library', 'LaunchAgents', `${label}.plist`)) : null;
  const unit = unitName ? fs.read(under(home, '.config', 'systemd', 'user', unitName)) : null;
  const wrapper = fs.read(job.wrapperPath);
  const script = fs.read(job.startScriptPath);
  const crontab = opts.crontab === undefined ? readCrontab() : opts.crontab;
  const managedWorkerPath = findManagedWorkerService(home, fs, opts.etcWorkerPath ?? '/etc/systemd/system/gbrain-worker.service');
  const scriptText = [script, crontab].filter((part) => part && part.trim()).join('\n');
  return resolveAutopilotDaemonArgs({
    installArgs,
    plist,
    unit,
    wrapper,
    script: scriptText || null,
    managedWorkerPath,
  });
}
