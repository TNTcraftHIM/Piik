import { writeServerLicenseNotices } from './package-licenses.mjs';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const root = process.cwd();
const output = process.argv[2] || 'THIRD-PARTY-NOTICES.txt';
const goarch = process.argv[3] || 'amd64';

try {
  writeServerLicenseNotices(root, resolve(output), 'go', { goos: 'linux', goarch });
  console.log(`Generated ${output} for linux/${goarch}`);
} catch (e) {
  console.warn('License generation failed:', e.message);
  writeFileSync(output, 'Third-party license notices unavailable.\n');
}
