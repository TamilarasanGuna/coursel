// Central configuration. Override any of these with environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 3000,

  // Paths
  root: ROOT,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'app.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  publicDir: path.join(ROOT, 'public'),

  // Auto-poll scheduler (cron syntax; 6 fields = supports seconds).
  // Default: every 30 seconds. The whole roster + all assigned problems are
  // refreshed each run. Overlapping runs are skipped (see runSync's guard), so
  // if a pass takes longer than 30s it simply runs back-to-back rather than
  // piling up. WARNING: against the live LeetCode endpoint this is aggressive
  // and can get the host IP rate-limited/blocked — raise this for big rosters,
  // e.g. POLL_CRON="0 */15 * * * *" (every 15 min).
  pollCron: process.env.POLL_CRON || '*/30 * * * * *',
  pollOnStartup: process.env.POLL_ON_STARTUP !== 'false', // run one pass when server boots

  // Politeness / rate limiting against LeetCode's unofficial GraphQL endpoint.
  // We are a guest on an undocumented API; hammering it gets the host IP blocked.
  requestDelayMs: Number(process.env.LC_DELAY_MS) || 1500, // gap between profile fetches
  maxRetries: Number(process.env.LC_MAX_RETRIES) || 2,

  // Recent-AC list length to pull per student when matching practice problems.
  recentAcLimit: Number(process.env.LC_RECENT_LIMIT) || 20,

  // MOCK mode returns deterministic fake LeetCode data so you can demo the app
  // with no network access. Set LC_MOCK=true to enable.
  mock: process.env.LC_MOCK === 'true',

  // Admin password. When set, the admin dashboard + its APIs require login.
  // Leave empty to keep the admin side open (a warning is logged at startup).
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Data layer: 'sqlite' (local file, default) or 'supabase' (cloud Postgres).
  dbDriver: (process.env.DB_DRIVER || 'sqlite').toLowerCase(),

  // Supabase / Postgres connection. Get these from your Supabase project:
  //   Settings → Database → Connection string (URI)  -> SUPABASE_DB_URL
  //   Settings → API → Project URL / anon / service_role keys
  // Put them in a local .env (never commit). The anon URL+key are also served
  // to the browser for realtime (a later phase); the service key stays server-side.
  supabase: {
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '',
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
  },
};
