// npm run editor:check - starts the isolated harness (fixture story, real routes and renderer, no auth, in-memory DB), drives the editor in headless Chrome, prints PASS/FAIL, screenshots to ./tmp-editor-check/
import { spawn } from 'node:child_process'; import { mkdirSync, existsSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.resolve('tmp-editor-check'); mkdirSync(out, { recursive: true });
if (!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) { console.error('Google Chrome was not found at the default macOS path; edit tools/editor-check/drive.mjs.'); process.exit(2); }
const srv = spawn(process.execPath, [path.join(here, 'harness.mjs')], { stdio: 'inherit' }); await new Promise(r => setTimeout(r, 2500));
const drv = spawn(process.execPath, [path.join(here, 'drive.mjs'), out], { stdio: 'inherit' }); drv.on('exit', () => { srv.kill(); process.exit(0); });
