#!/usr/bin/env node
// Creates .env from .env.example with freshly generated MASTER_KEY and SESSION_SECRET.
// Never overwrites an existing .env. Secrets are written to the file only, never printed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (existsSync(envPath)) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}

const template = existsSync(examplePath)
  ? readFileSync(examplePath, 'utf8')
  : 'DATABASE_URL=postgres://gmp:gmp@localhost:54329/gmp\nPUBLIC_URL=http://localhost:3000\nPORT=3000\nMASTER_KEY=\nSESSION_SECRET=\n';

const generated = {
  MASTER_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(48).toString('base64'),
};

let content = template;
for (const [key, value] of Object.entries(generated)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
}

writeFileSync(envPath, content, { mode: 0o600, flag: 'wx' });
console.log('Created .env with a new MASTER_KEY and SESSION_SECRET.');
console.log('IMPORTANT: back up MASTER_KEY. Without it stored credentials cannot be decrypted.');
