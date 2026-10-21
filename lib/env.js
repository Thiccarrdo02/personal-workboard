const fs = require('fs');
const path = require('path');

// Auto-load .env.local for local runs (Vercel injects env vars directly).
// scripts/dev.js sets WORKBOARD_SKIP_ENV_FILE so local testing never picks up real secrets.
if (process.env.WORKBOARD_SKIP_ENV_FILE !== '1') {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const k = match[1];
          const v = match[2] ? match[2].trim().replace(/^['"]|['"]$/g, '') : '';
          if (!process.env[k]) process.env[k] = v;
        }
      }
    }
  } catch (e) {}
}
