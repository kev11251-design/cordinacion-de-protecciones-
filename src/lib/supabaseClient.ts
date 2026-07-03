import { createClient } from '@supabase/supabase-js';

const meta = import.meta as any;
const env = (typeof import.meta !== 'undefined' && meta && meta.env) ? meta.env : process.env;

const supabaseUrl = env.VITE_SUPABASE_URL || 'https://filhixiqebdfrdeurhwo.supabase.co';
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpbGhpeGlxZWJkZnJkZXVyaHdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMzU2NDEsImV4cCI6MjA5ODYxMTY0MX0.guXycFuQ53VtUfvhQrPm9u3-zlCuG1aWhw0FW_hEyM4';

// Clean up URL in case it has trailing slash or /rest/v1
const cleanUrl = supabaseUrl.replace(/\/rest\/v1\/?$/, '').trim();

export const supabase = createClient(cleanUrl, supabaseAnonKey);
