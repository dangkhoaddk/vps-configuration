import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNoOp, syncConfigFiles } from '../src/nginx/write-config-files.js';
import { hostPathFor } from '../src/paths.js';

/**
 * This module deletes files on a production host, so its behaviour is pinned
 * rather than assumed.
 */

let root: string;
let paths: { nginxConfDir: string; snippetsDir: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vpsctl-test-'));
  paths = { nginxConfDir: join(root, 'conf'), snippetsDir: join(root, 'snippets') };
  mkdirSync(paths.nginxConfDir, { recursive: true });
  mkdirSync(paths.snippetsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

describe('hostPathFor', () => {
  it('routes conf.d and snippets to their separate host directories', () => {
    expect(hostPathFor('conf.d/api-ssl.conf', paths)).toBe(join(paths.nginxConfDir, 'api-ssl.conf'));
    expect(hostPathFor('snippets/monitor.conf', paths)).toBe(join(paths.snippetsDir, 'monitor.conf'));
  });

  it('refuses a path it has no mapping for', () => {
    expect(() => hostPathFor('somewhere/else.conf', paths)).toThrow(/no host location/);
  });
});

describe('syncConfigFiles', () => {
  it('creates files that do not exist', () => {
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths);

    expect(plan.created).toEqual(['conf.d/a.conf']);
    expect(readFileSync(join(paths.nginxConfDir, 'a.conf'), 'utf8')).toBe('server {}\n');
  });

  it('reports identical content as unchanged and rewrites nothing', () => {
    const content = files({ 'conf.d/a.conf': 'server {}\n' });
    syncConfigFiles(content, paths);
    const plan = syncConfigFiles(content, paths);

    expect(plan.unchanged).toEqual(['conf.d/a.conf']);
    expect(isNoOp(plan)).toBe(true);
  });

  it('updates a file whose content changed', () => {
    syncConfigFiles(files({ 'conf.d/a.conf': 'old\n' }), paths);
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'new\n' }), paths);

    expect(plan.updated).toEqual(['conf.d/a.conf']);
    expect(readFileSync(join(paths.nginxConfDir, 'a.conf'), 'utf8')).toBe('new\n');
  });

  // Replaces `rm -f ./nginx/conf/default.conf` from the deploy script, generalised.
  it('removes a .conf file the renderer no longer produces', () => {
    writeFileSync(join(paths.nginxConfDir, 'stale.conf'), 'server {}\n');
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths);

    expect(plan.removed).toEqual([join(paths.nginxConfDir, 'stale.conf')]);
    expect(readdirSync(paths.nginxConfDir)).toEqual(['a.conf']);
  });

  // nginx only auto-includes *.conf, so anything else is not ours to delete.
  it('leaves non-.conf files alone', () => {
    writeFileSync(join(paths.nginxConfDir, 'notes.txt'), 'operator notes\n');
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths);

    expect(plan.removed).toEqual([]);
    expect(readdirSync(paths.nginxConfDir).sort()).toEqual(['a.conf', 'notes.txt']);
  });

  it('prunes the snippets directory too', () => {
    writeFileSync(join(paths.snippetsDir, 'monitor.conf'), 'location {}\n');
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths);

    expect(plan.removed).toEqual([join(paths.snippetsDir, 'monitor.conf')]);
  });

  describe('dry run', () => {
    it('reports what would change without writing', () => {
      const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths, {
        dryRun: true,
      });

      expect(plan.created).toEqual(['conf.d/a.conf']);
      expect(readdirSync(paths.nginxConfDir)).toEqual([]);
    });

    it('reports what would be removed without removing it', () => {
      writeFileSync(join(paths.nginxConfDir, 'stale.conf'), 'server {}\n');
      const plan = syncConfigFiles(files({}), paths, { dryRun: true });

      expect(plan.removed).toEqual([join(paths.nginxConfDir, 'stale.conf')]);
      expect(readdirSync(paths.nginxConfDir)).toEqual(['stale.conf']);
    });
  });

  // A trailing slash in .env used to make the directory lookup miss, leaving the
  // expected-files set empty so the prune deleted everything in the directory,
  // including files written moments earlier in the same call.
  it('handles a configured directory with a trailing slash', () => {
    const slashed = { nginxConfDir: `${paths.nginxConfDir}/`, snippetsDir: `${paths.snippetsDir}/` };
    const content = files({ 'conf.d/a.conf': 'server {}\n', 'snippets/m.conf': 'location {}\n' });

    const plan = syncConfigFiles(content, slashed);

    expect(plan.removed).toEqual([]);
    expect(readFileSync(join(paths.nginxConfDir, 'a.conf'), 'utf8')).toBe('server {}\n');
    expect(readFileSync(join(paths.snippetsDir, 'm.conf'), 'utf8')).toBe('location {}\n');
  });

  it('handles a non-normalised directory path', () => {
    const messy = {
      nginxConfDir: join(paths.nginxConfDir, '..', 'conf'),
      snippetsDir: paths.snippetsDir,
    };
    syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), messy);
    const plan = syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), messy);

    expect(plan.removed).toEqual([]);
    expect(plan.unchanged).toEqual(['conf.d/a.conf']);
  });

  it('creates a missing target directory', () => {
    rmSync(paths.nginxConfDir, { recursive: true });
    syncConfigFiles(files({ 'conf.d/a.conf': 'server {}\n' }), paths);

    expect(readFileSync(join(paths.nginxConfDir, 'a.conf'), 'utf8')).toBe('server {}\n');
  });
});
