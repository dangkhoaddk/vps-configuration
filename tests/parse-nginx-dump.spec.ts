import { describe, expect, it } from 'vitest';
import { findDumpedFile, parseNginxDump } from '../src/compare/parse-nginx-dump.js';

/**
 * Shape of real `nginx -T` output: every loaded file, each behind a
 * `# configuration file <path>:` header, including files this project does not
 * own (the image's own nginx.conf and mime.types).
 */
const DUMP = [
  'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok',
  '# configuration file /etc/nginx/nginx.conf:',
  'user  nginx;',
  'worker_processes  auto;',
  '',
  '# configuration file /etc/nginx/mime.types:',
  'types {',
  '    text/html html;',
  '}',
  '',
  '# configuration file /etc/nginx/conf.d/api-ssl.conf:',
  'server {',
  '    listen 443 ssl;',
  '}',
  '',
  '# configuration file /etc/nginx/snippets/monitor.conf:',
  'location = /monitor {',
  '    return 301 /monitor/;',
  '}',
].join('\n');

describe('parseNginxDump', () => {
  it('splits the dump into one entry per configuration file', () => {
    expect([...parseNginxDump(DUMP).keys()]).toEqual([
      '/etc/nginx/nginx.conf',
      '/etc/nginx/mime.types',
      '/etc/nginx/conf.d/api-ssl.conf',
      '/etc/nginx/snippets/monitor.conf',
    ]);
  });

  it('captures a file body without its header line', () => {
    const body = parseNginxDump(DUMP).get('/etc/nginx/conf.d/api-ssl.conf');
    expect(body).toContain('listen 443 ssl;');
    expect(body).not.toContain('# configuration file');
  });

  it('drops the preamble that precedes the first header', () => {
    const all = [...parseNginxDump(DUMP).values()].join('\n');
    expect(all).not.toContain('syntax is ok');
  });

  // nginx dumps an included-twice file twice. Keeping the first copy means a
  // later divergent copy shows up as a parity failure rather than silently
  // overwriting what was compared.
  it('keeps the first copy when a file is dumped more than once', () => {
    const dump = [
      '# configuration file /etc/nginx/conf.d/a.conf:',
      'first;',
      '# configuration file /etc/nginx/conf.d/a.conf:',
      'second;',
    ].join('\n');

    expect(parseNginxDump(dump).get('/etc/nginx/conf.d/a.conf')?.trim()).toBe('first;');
  });

  it('returns an empty map for output with no file headers', () => {
    expect(parseNginxDump('nginx: configuration file test failed').size).toBe(0);
  });
});

describe('findDumpedFile', () => {
  const files = parseNginxDump(DUMP);

  it('matches a relative path against an absolute dumped path', () => {
    expect(findDumpedFile(files, 'conf.d/api-ssl.conf')).toContain('listen 443 ssl;');
  });

  it('matches a snippet outside conf.d', () => {
    expect(findDumpedFile(files, 'snippets/monitor.conf')).toContain('return 301 /monitor/;');
  });

  it('returns undefined for a file the dump does not contain', () => {
    expect(findDumpedFile(files, 'conf.d/nope.conf')).toBeUndefined();
  });

  // Suffix matching must anchor on a path separator, otherwise looking up
  // `conf.d/ssl.conf` would match a dumped `/etc/nginx/conf.d/api-ssl.conf`.
  it('does not match on a partial filename', () => {
    expect(findDumpedFile(files, 'conf.d/ssl.conf')).toBeUndefined();
    expect(findDumpedFile(files, 'ssl.conf')).toBeUndefined();
  });
});
