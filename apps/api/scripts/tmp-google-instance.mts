import { config } from 'dotenv';
config({ path: '.env' });
const { spawn } = await import('node:child_process');
const p = spawn('node', ['--env-file-if-exists=../../.env', 'dist/main.js'], {
  cwd: 'apps/api',
  env: {
    ...process.env,
    API_PORT: '4001',
    API_URL: 'http://localhost:4001',
    WEB_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    NJP_E2E: '1',
  },
  stdio: 'ignore',
});
p.unref();
console.log('started 4001');
