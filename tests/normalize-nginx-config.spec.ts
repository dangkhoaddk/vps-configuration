import { describe, expect, it } from 'vitest';
import { normalizeNginxConfig, stripInlineComment } from '../src/render/normalize-nginx-config.js';

describe('stripInlineComment', () => {
  it('removes a trailing comment', () => {
    expect(stripInlineComment('    server spa-api:3000; # points at the API')).toBe(
      '    server spa-api:3000; ',
    );
  });

  it('removes a whole-line comment', () => {
    expect(stripInlineComment('# --- Rate Limiting ---')).toBe('');
  });

  it('leaves a line with no comment alone', () => {
    expect(stripInlineComment('    listen 443 ssl;')).toBe('    listen 443 ssl;');
  });

  // The reason this is a character scan rather than a /#.*$/ replace. No current
  // config has a quoted #, but add_header and map values are where one appears
  // first, and truncating such a line would corrupt the parity comparison
  // instead of failing it.
  it('keeps a # inside a double-quoted value', () => {
    const line = '    add_header Content-Security-Policy "img-src #fff" always;';
    expect(stripInlineComment(line)).toBe(line);
  });

  it('keeps a # inside a single-quoted value', () => {
    const line = "    proxy_set_header X-Tag 'build#42';";
    expect(stripInlineComment(line)).toBe(line);
  });

  it('strips a comment that follows a quoted value', () => {
    expect(stripInlineComment('    add_header X-A "v" always; # note')).toBe(
      '    add_header X-A "v" always; ',
    );
  });

  it('handles an escaped quote without losing track of quoting', () => {
    const line = '    add_header X-A "say \\"hi\\" #1" always;';
    expect(stripInlineComment(line)).toBe(line);
  });
});

describe('normalizeNginxConfig', () => {
  it('drops comments, blank lines and trailing whitespace', () => {
    const input = ['# header comment', '', 'listen 443 ssl;   ', '   ', 'http2 on; # inline'].join(
      '\n',
    );
    expect(normalizeNginxConfig(input)).toBe(['listen 443 ssl;', 'http2 on;'].join('\n'));
  });

  it('preserves indentation, which makes a failing diff readable', () => {
    expect(normalizeNginxConfig('location / {\n    proxy_pass http://x;\n}')).toBe(
      'location / {\n    proxy_pass http://x;\n}',
    );
  });

  // Order is semantically significant in nginx: location matching, add_header
  // inheritance, and first-listed-server-becomes-default all depend on it. A
  // normalizer that sorted would pass a reordering that changed behavior.
  it('does not reorder directives', () => {
    const a = normalizeNginxConfig('add_header X-A "1";\nadd_header X-B "2";');
    const b = normalizeNginxConfig('add_header X-B "2";\nadd_header X-A "1";');
    expect(a).not.toBe(b);
  });
});
