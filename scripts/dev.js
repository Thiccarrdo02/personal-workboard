// Local development server with throwaway storage and a test PIN.
//   npm run dev  →  http://localhost:8123, PIN 2468
// Board data lives in .data/dev-workboard.json, so testing never touches the
// real cloud board, and .env.local secrets are not loaded.
const path = require('path');

process.env.WORKBOARD_SKIP_ENV_FILE = '1';
process.env.STORAGE_BACKEND = 'file';
process.env.STORAGE_FILE = process.env.STORAGE_FILE || path.join(__dirname, '..', '.data', 'dev-workboard.json');
process.env.APP_PASSWORD = process.env.APP_PASSWORD || '2468';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'local-dev-secret';
process.env.PORT = process.env.PORT || '8123';

require('../server');
