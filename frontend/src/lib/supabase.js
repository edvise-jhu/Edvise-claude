import { createClient } from '@supabase/supabase-js'

/** Defaults match frontend/.env — env vars override at build time. */
const DEFAULT_SUPABASE_URL = 'https://actkvdwxakexyldfqajw.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjdGt2ZHd4YWtleHlsZGZxYWp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMjQyMjMsImV4cCI6MjA5MTcwMDIyM30.izvIz2thof3pYa5c8yA7orKtk-olW8t2ciKQqfM5eUs'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
