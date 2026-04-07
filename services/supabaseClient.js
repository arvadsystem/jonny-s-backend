import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[security] Error: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.');
}

// Cliente con service_role para operaciones administrativas de Storage (bypass RLS de subida si es necesario)
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
