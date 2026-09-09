import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Server-side Supabase client using the SERVICE ROLE key.
 * This bypasses Row Level Security, which is correct here because this
 * backend is the trusted server managing WhatsApp sessions on behalf of
 * users - never expose this client or key to the browser.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'public' },
});
