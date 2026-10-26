// Temporary folders for tests. They all sit in one folder per test process, removed when the
// process exits, so test runs leave nothing behind in the system temp folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = mkdtempSync(join(tmpdir(), 'aures-test-'));
process.on('exit', () => rmSync(parent, { recursive: true, force: true }));

export const tempDir = (prefix: string): Promise<string> => mkdtemp(join(parent, prefix));
