// npm run set-logo -- path/to/logo.png   (uses DATA_DIR / DB_PATH like the app; run it against the real data deliberately)
import { setBrandLogo } from '../src/brand_logo.js';
const f = process.argv[2]; if (!f) { console.error('usage: npm run set-logo -- path/to/logo.png'); process.exit(2); }
try { console.log(await setBrandLogo(f)); } catch (e) { console.error('failed:', e.message); process.exit(1); }
