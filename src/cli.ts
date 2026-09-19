#!/usr/bin/env node
import { Command } from 'commander';
import { loadEnvFile } from './registry/load-env-file.js';
import { repoPaths } from './repo-paths.js';
import { applyCommand } from './commands/apply.js';
import { certIssueCommand } from './commands/cert-issue.js';
import { diffCommand } from './commands/diff.js';
import { renderCommand } from './commands/render.js';
import { stackCommand } from './commands/stack.js';
import { validateCommand } from './commands/validate.js';

/**
 * vpsctl: the single entry point for changing the VPS edge.
 *
 * Wiring only. Each command's behaviour lives in its own module so it can be
 * reasoned about, and tested, without going through argument parsing.
 */
// Before anything reads process.env: apps.yml's ${VAR} references and docker
// compose both draw from this one file.
loadEnvFile(repoPaths.composeEnvFile);

const program = new Command();

program
  .name('vpsctl')
  .description('Manage nginx routing, TLS and the edge stack for this VPS')
  .showHelpAfterError();

program
  .command('render')
  .description('render apps.yml to local files; writes nothing else')
  .option('--out <dir>', 'output directory (default: ./rendered)')
  .action((options) => exit(renderCommand(options)));

program
  .command('validate')
  .description('render and run nginx -t in a throwaway container')
  .action(() => exit(validateCommand()));

program
  .command('diff')
  .description('compare rendered config against the baseline, or the running nginx')
  .option('--live', 'compare against `nginx -T` from the running container')
  .action((options) => exit(diffCommand(options)));

program
  .command('apply')
  .description('render, validate, write and reload nginx')
  .option('--app <name>', 'the app that was just deployed; fail if it is not up')
  .option('--dry-run', 'show what would change without writing or reloading')
  .action((options) => exit(applyCommand(options)));

const cert = program.command('cert').description('certificate management');
cert
  .command('issue <app>')
  .description('obtain a certificate for an app, if it does not already have one')
  .option('--dry-run', 'print the certbot command without running it')
  .action((app, options) => exit(certIssueCommand({ app, ...options })));

program
  .command('up')
  .description('start the edge stack')
  .action(() => exit(stackCommand('up')));

program
  .command('down')
  .description('stop the edge stack')
  .action(() => exit(stackCommand('down')));

program
  .command('status')
  .description('show edge stack containers')
  .action(() => exit(stackCommand('status')));

function exit(code: number): never {
  process.exit(code);
}

try {
  program.parse();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
