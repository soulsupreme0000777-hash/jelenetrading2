import { Injectable, signal, computed, inject } from '@angular/core';
import {
  createClient,
  SupabaseClient,
  PostgrestError,
  // FIX: The type keyword in type-only imports was causing module resolution errors in this environment.
  // Reverting to standard imports to ensure the compiler can find the necessary type definitions from Supabase.
  // The types below are commented out because they are reported as not being exported from the module,
  // which suggests a problem with the Supabase JS library version or environment setup.
  // We will use `any` as a workaround.
  // User,
  // AuthError,
  // AuthResponse,
  // SignInWithPasswordCredentials,
  // RealtimeChannel,
  // Session,
  // AuthChangeEvent,
} from '@supabase/supabase-js';
import { environment } from '../environments/environment';
import { Router } from '@angular/router';

// --- TYPE DEFINITIONS ---

export interface Profile {
  id: string; // user id
  employee_id?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  age?: number | null;
  mobile_number?: string | null;
  branch?: 'cabanatuan' | 'solano' | null;
  position?: 'branch officer' | 'team leader' | 'regular staff' | null;
  daily_rate?: number | null;
  role?: 'admin' | 'employee' | 'superadmin' | null;
  created_at?: string;
  hire_date?: string | null;
  birth_date?: string | null;
  day_off_balance?: number | null;
  sil_balance?: number | null;
  avatar_url?: string | null;
  is_deleted?: boolean;
  position_id?: number | null;
  branch_id?: number | null;
}

export interface DtrEntry {
  id: number;
  user_id: string;
  time_in: string | null;
  time_out: string | null;
  created_at: string;
}

export interface EmployeeSchedule {
  id: number;
  user_id: string;
  date: string; // YYYY-MM-DD format
  work_start_time: string; // HH:mm:ss format
  work_end_time: string; // HH:mm:ss format
  created_at: string;
}

export interface EmployeeStatus {
  id: number;
  user_id: string;
  date: string; // YYYY-MM-DD format
  status: 'day_off' | 'service_incentive_leave' | 'emergency_leave';
  created_at: string;
}

export interface Payroll {
  id: number;
  user_id: string;
  pay_period_start: string;
  pay_period_end: string;
  gross_pay: number;
  lateness_minutes: number;
  undertime_minutes: number;
  lateness_deductions: number;
  undertime_deductions: number;
  manual_deductions: number;
  net_pay: number;
  created_at: string;
  status: 'Paid' | 'Delayed' | 'Unpaid';
  raise_details?: { name: string; amount: number }[] | null;
}

export interface SalaryRule {
  id: number;
  name: string;
  description: string | null;
  raise_percentage: number;
  start_date: string;
  end_date: string;
  is_active: boolean;
  created_at: string;
}

export interface NewUserPayload {
  email: string;
  password?: string;
  profileData: Partial<Profile>;
}

export interface CompanySetting {
    id: number;
    setting_key: string;
    setting_value: any;
    description: string | null;
}

export interface Position {
    id: number;
    name: string;
}

export interface Branch {
    id: number;
    name: string;
}

export interface PositionRate {
    id: number;
    position_id: number;
    branch_id: number;
    daily_rate: number;
    positions?: { name: string }; // For joins
    branches?: { name: string }; // For joins
}


// FIX: Using `any` as User type is not available from import.
export type UserWithProfile = any & { profile: Profile | null };

// --- FULL DATABASE SETUP SCRIPT (V9.1) ---
// Run this complete script in your Supabase SQL Editor.
// It's safe to run multiple times.
/*
-- =================================================================
-- V9.1: DYNAMIC PAYROLL SETTINGS & SQL SYNTAX FIX
-- =================================================================
-- This is a complete, idempotent setup script.
-- FIX: Replaces all instances of `TIMESTAMPTZ` with the explicit `TIMESTAMP WITH TIME ZONE`
-- to resolve the `syntax error at or near "WITH"` error reported by the user.
-- It also updates default settings to be more comprehensive for the new dynamic payroll system.
-- =================================================================

-- Step 1: Add the `is_deleted` column for soft deletes (if not already present).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Drop old/deprecated columns from the 'payrolls' table.
ALTER TABLE public.payrolls DROP COLUMN IF EXISTS early_departure_minutes;
ALTER TABLE public.payrolls DROP COLUMN IF EXISTS early_departure_deductions;
ALTER TABLE public.payrolls DROP COLUMN IF EXISTS total_hours;

-- Step 3: Ensure all other required columns exist on all tables.
ALTER TABLE public.payrolls
  ADD COLUMN IF NOT EXISTS gross_pay NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lateness_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undertime_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lateness_deductions NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undertime_deductions NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_deductions NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raise_details JSONB;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Step 4: Create a table for company-wide payroll settings.
CREATE TABLE IF NOT EXISTS public.company_settings (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value JSONB,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Step 5: Create tables for dynamic positions and branches.
CREATE TABLE IF NOT EXISTS public.positions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.branches (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Step 6: Create a join table for position rates per branch.
CREATE TABLE IF NOT EXISTS public.position_rates (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  position_id BIGINT REFERENCES public.positions(id) ON DELETE CASCADE,
  branch_id BIGINT REFERENCES public.branches(id) ON DELETE CASCADE,
  daily_rate NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(position_id, branch_id)
);

-- Step 7: Refactor profiles table to use foreign keys for positions and branches.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS position_id BIGINT REFERENCES public.positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES public.branches(id) ON DELETE SET NULL;

-- Step 8: Create essential database functions.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO public.profiles (id, email, role) VALUES (new.id, new.email, 'employee'); RETURN new; END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN (SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1); END;
$$;

CREATE OR REPLACE FUNCTION public.delete_auth_user(user_id_to_delete uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN DELETE FROM auth.users u WHERE u.id = user_id_to_delete; RETURN 'User deleted successfully from auth schema.'; END;
$$;

-- Step 9: Create triggers.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Step 10: Enable Row Level Security (RLS) on all tables.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dtr_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.position_rates ENABLE ROW LEVEL SECURITY;

-- Step 11: Drop all old policies to ensure a clean slate.
DO $$ DECLARE r RECORD;
BEGIN FOR r IN (SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public') LOOP EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(r.policyname) || ' ON public.' || quote_ident(r.tablename); END LOOP; END $$;

-- Step 12: Create comprehensive RLS policies for all tables.
CREATE POLICY "Allow individuals to view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = id AND is_deleted = false);
CREATE POLICY "Allow individuals to update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Allow admins to manage all profiles" ON public.profiles FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow individuals to view their own DTR entries" ON public.dtr_entries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individuals to create their own DTR entries" ON public.dtr_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all DTR entries" ON public.dtr_entries FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow individuals to view their own payrolls" ON public.payrolls FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all payrolls" ON public.payrolls FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow individuals to view their own schedules" ON public.employee_schedules FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all schedules" ON public.employee_schedules FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow individuals to view their own status" ON public.employee_status FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individuals to create their own status" ON public.employee_status FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all statuses" ON public.employee_status FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow admins to manage salary rules" ON public.salary_rules FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

CREATE POLICY "Allow admins to manage company settings" ON public.company_settings FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));
CREATE POLICY "Allow authenticated users to read positions and branches" ON public.positions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Allow admins to manage positions" ON public.positions FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));
CREATE POLICY "Allow authenticated users to read positions and branches" ON public.branches FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Allow admins to manage branches" ON public.branches FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));
CREATE POLICY "Allow authenticated users to read rates" ON public.position_rates FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Allow admins to manage rates" ON public.position_rates FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- Step 13: Set up Storage RLS
DROP POLICY IF EXISTS "Allow public read access to avatars" ON storage.objects;
CREATE POLICY "Allow public read access to avatars" ON storage.objects FOR SELECT USING ( bucket_id = 'avatars' );
DROP POLICY IF EXISTS "Allow admins to manage all avatars" ON storage.objects;
CREATE POLICY "Allow admins to manage all avatars" ON storage.objects FOR ALL USING ( bucket_id = 'avatars' AND get_my_role() IN ('admin', 'superadmin') ) WITH CHECK ( bucket_id = 'avatars' AND get_my_role() IN ('admin', 'superadmin') );

-- Step 14: Insert default company settings.
INSERT INTO public.company_settings (setting_key, setting_value, description) VALUES
  ('late_rate_per_minute', '1.60', 'Deduction per minute for lateness or undertime.'),
  ('grace_period_minutes', '15', 'Grace period in minutes before lateness is counted.'),
  ('birth_month_bonus', '{"branch officer": 1200, "team leader": 1000, "regular staff": 500}', 'Bonus if birthday falls within pay period, per position.')
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  description = EXCLUDED.description;


-- Step 15: Populate default positions, branches, and rates.
INSERT INTO public.positions (name) VALUES ('branch officer'), ('team leader'), ('regular staff') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.branches (name) VALUES ('cabanatuan'), ('solano') ON CONFLICT (name) DO NOTHING;

WITH pos AS (SELECT id, name FROM public.positions),
     bra AS (SELECT id, name FROM public.branches)
INSERT INTO public.position_rates (position_id, branch_id, daily_rate) VALUES
  ((SELECT id FROM pos WHERE name = 'branch officer'), (SELECT id FROM bra WHERE name = 'cabanatuan'), 575),
  ((SELECT id FROM pos WHERE name = 'team leader'), (SELECT id FROM bra WHERE name = 'cabanatuan'), 565),
  ((SELECT id FROM pos WHERE name = 'regular staff'), (SELECT id FROM bra WHERE name = 'cabanatuan'), 560),
  ((SELECT id FROM pos WHERE name = 'branch officer'), (SELECT id FROM bra WHERE name = 'solano'), 550),
  ((SELECT id FROM pos WHERE name = 'team leader'), (SELECT id FROM bra WHERE name = 'solano'), 500),
  ((SELECT id FROM pos WHERE name = 'regular staff'), (SELECT id FROM bra WHERE name = 'solano'), 500)
ON CONFLICT (position_id, branch_id) DO NOTHING;

*/

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;
  private router = inject(Router);

  // --- STATE SIGNALS ---

  isInitialized = signal(false);
  // FIX: Using `any` as User type is not available from import.
  currentUser = signal<any | null>(null);
  currentUserProfile = signal<Profile | null | undefined>(undefined);
  profileError = signal<string | null>(null);

  currentUserRole = computed<'superadmin' | 'admin' | 'employee' | null>(() => this.currentUserProfile()?.role || null);

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseKey);

    // FIX: Add explicit types to the callback parameters to ensure type safety.
    // FIX: Cast auth client to `any` to bypass "property does not exist" errors, likely due to a typings issue.
    (this.supabase.auth as any).onAuthStateChange((event: any, session: any | null) => {
      this.currentUserProfile.set(undefined); // Set to undefined to show loading state
      if (session) {
        this.currentUser.set(session.user);
        if (session.user) {
          this.loadUserProfile(session.user.id);
        } else {
          this.currentUserProfile.set(null);
        }
      } else {
        this.currentUser.set(null);
        this.currentUserProfile.set(null);
      }
      this.isInitialized.set(true);
    });
  }

  // --- AUTHENTICATION ---

  // FIX: Use `any` for types as they are not available from import.
  signInWithPassword(credentials: any): Promise<any> {
    // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
    return (this.supabase.auth as any).signInWithPassword(credentials);
  }

  signOut() {
    // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
    return (this.supabase.auth as any).signOut();
  }

  // --- PROFILE MANAGEMENT ---

  async loadUserProfile(userId: string): Promise<void> {
    this.profileError.set(null);
    try {
      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .eq('is_deleted', false)
        .maybeSingle(); 

      if (profileError) {
        // This handles actual database errors, like network issues or RLS violations.
        throw profileError;
      }
      
      if (!profile) {
        // This is a specific, critical state: user exists in auth, but not in profiles.
        // This is the most likely cause of the "data not showing" issue if RLS is fixed.
        throw new Error('Profile Not Found: Your user account exists, but a corresponding profile is missing in the database. Your administrator needs to run the complete database setup script located in the comments of the src/services/supabase.service.ts file to fix this.');
      }

      this.currentUserProfile.set(profile);

    } catch (error: any) {
      let message = error.message || 'An unknown error occurred while fetching your profile.';
      if (typeof message === 'string' && message.includes('infinite recursion')) {
          message = 'Database permission error: An "infinite recursion" was detected. This is caused by a misconfigured security policy. Please ask your administrator to apply the fix located in the comments of the src/services/supabase.service.ts file.';
      }
      this.profileError.set(message);
      this.currentUserProfile.set(null); // Set to null on any error to stop loading and show the error message.
    }
  }

  async getAllUsersWithProfiles() {
    return this.supabase
      .from('profiles')
      .select('*')
      .eq('role', 'employee')
      .eq('is_deleted', false);
  }
  
  updateUserProfile(userId: string, profileData: Partial<Profile>) {
    return this.supabase.from('profiles').update(profileData).eq('id', userId);
  }

  softDeleteUsers(userIds: string[]) {
    return this.supabase.from('profiles').update({ is_deleted: true }).in('id', userIds);
  }

  getDeletedUsersWithProfiles() {
    return this.supabase.from('profiles').select('*').eq('is_deleted', true);
  }
  
  recoverUsers(userIds: string[]) {
    return this.supabase.from('profiles').update({ is_deleted: false }).in('id', userIds);
  }
  
  permanentlyDeleteUser(userId: string) {
    // This RPC call requires the `delete_auth_user` function to be created in your database.
    // This function is included in the main database setup script at the top of this file.
    return this.supabase.rpc('delete_auth_user', { user_id_to_delete: userId });
  }

  async createNewUser(payload: NewUserPayload) {
    // 1. Get the current admin session to restore it later.
    // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
    const { data: { session: adminSession } } = await (this.supabase.auth as any).getSession();
    if (!adminSession) {
      this.router.navigate(['/login']);
      throw new Error("Admin session not found. Please log in again.");
    }
  
    try {
      // 2. Create the new user. This signs out the admin and signs in the new user.
      // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
      const { data: authData, error: authError } = await (this.supabase.auth as any).signUp({
        email: payload.email,
        password: payload.password!,
      });
  
      if (authError) {
        throw authError;
      }
      if (!authData.user) {
        throw new Error('User creation succeeded but no user data was returned.');
      }
      
      const user = authData.user;
  
      // 3. CRUCIAL FIX: Immediately restore the admin's session BEFORE attempting to update the profile.
      // This ensures the subsequent database call is made with admin privileges.
      // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
      const { error: sessionError } = await (this.supabase.auth as any).setSession({
          access_token: adminSession.access_token,
          refresh_token: adminSession.refresh_token,
      });
  
      if (sessionError) {
          // If session restoration fails, we're in a bad state. The new user might be logged in.
          // Throw a specific error. The 'finally' block will attempt restoration again.
          console.error('CRITICAL: Could not restore admin session immediately after user creation.', sessionError.message);
          throw new Error('Admin session could not be restored. The new user was created, but their profile needs to be updated manually.');
      }
  
      // 4. Now that the admin session is restored, update the auto-created profile.
      const profileToUpdate = {
        ...payload.profileData,
        email: user.email, // Also ensure the profile email is in sync.
      };
  
      const { error: profileError } = await this.supabase
        .from('profiles')
        .update(profileToUpdate)
        .eq('id', user.id);
  
      if (profileError) {
        console.error('CRITICAL: User was created in auth, but profile update failed:', profileError.message, { fullError: profileError });
        // The `finally` block will restore the admin session. We throw to notify the caller.
        throw profileError;
      }
  
      const qrData = JSON.stringify({ userId: user.id, email: user.email });
  
      // Construct the full profile object to return, which the component expects.
      const returnedProfile = {
        ...payload.profileData,
        id: user.id,
        email: user.email,
      };
      
      return { user, profile: returnedProfile as Profile, qrData };
  
    } catch (error) {
      // Re-throw any error to be handled by the calling component.
      throw error;
    } finally {
      // 5. ALWAYS restore the admin's session, whether user creation succeeded or failed.
      // This is a safety net. If the session was already restored in the try block, this is harmless.
      // If an error occurred before that, this ensures the admin is logged back in.
      // FIX: Cast auth client to `any` to bypass "property does not exist" errors.
      const { error: sessionError } = await (this.supabase.auth as any).setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
      });
  
      if (sessionError) {
        // This is a critical state. Admin is logged out and session couldn't be restored.
        // Forcing a redirect to login is the safest recovery action.
        console.error('FATAL: Could not restore admin session in finally block.', sessionError.message);
        this.router.navigate(['/login']);
      }
    }
  }

  async uploadAvatar(userId: string, file: File): Promise<string> {
    const fileExt = file.name.split('.').pop();
    // Use a timestamp to ensure the URL is always unique, preventing caching issues.
    const filePath = `${userId}/${Date.now()}.${fileExt}`;

    const { error: uploadError } = await this.supabase
      .storage
      .from('avatars')
      .upload(filePath, file);

    if (uploadError) {
      throw uploadError;
    }

    const { data } = this.supabase
      .storage
      .from('avatars')
      .getPublicUrl(filePath);

    return data.publicUrl;
  }


  // --- DTR (Daily Time Record) ---

  /**
   * Returns robust, timezone-aware date/time information for the current moment in PST.
   */
  private getTodayPSTBounds(): { startOfDay: string; endOfDay: string; nowPST: Date } {
    const timeZone = 'Asia/Manila';
    const now = new Date();
    // Create a Date object that accurately reflects the current time in the Philippines.
    const nowPST = new Date(now.toLocaleString('en-US', { timeZone }));

    // Use Intl.DateTimeFormat to reliably get date components for the target timezone.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);

    const year = parts.find(p => p.type === 'year')!.value;
    const month = parts.find(p => p.type === 'month')!.value;
    const day = parts.find(p => p.type === 'day')!.value;
    const todayPstStr = `${year}-${month}-${day}`;
    
    // Construct ISO-8601 strings with timezone offset for accurate database queries.
    const startOfDay = `${todayPstStr}T00:00:00.000+08:00`;
    const endOfDay = `${todayPstStr}T23:59:59.999+08:00`;

    return { startOfDay, endOfDay, nowPST };
  }

  async handleQrCodeLogin(userId: string) {
    // 1. Fetch user's profile
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) throw new Error('User not found.');
    
    // 2. Determine current time in PST for all operations using the robust method.
    const { startOfDay, endOfDay, nowPST } = this.getTodayPSTBounds();

    // Fetch schedule for today to enforce it.
    const todayStr = nowPST.toISOString().slice(0, 10);
    const { data: schedule, error: scheduleError } = await this.supabase
      .from('employee_schedules')
      .select('id') // We only need to know if a schedule exists
      .eq('user_id', userId)
      .eq('date', todayStr)
      .maybeSingle();
    if (scheduleError) throw scheduleError;

    // 3. Fetch all DTR entries for today (in PST)
    const { data: todaysEntries, error: dtrError } = await this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay)
      .order('created_at', { ascending: true });

    if (dtrError) throw dtrError;

    const entryCount = todaysEntries.length;
    const lastEntry = todaysEntries[entryCount - 1];
    
    let dtrEntry: DtrEntry;
    let status: string;
    const nowIsoString = nowPST.toISOString();

    if (entryCount === 0) {
      // Enforce schedule for the first clock-in of the day.
      if (!schedule) {
        throw new Error('Clock-in rejected: You are not scheduled to work today.');
      }
      // Action 1: First scan of the day - Clock-In for Work
      status = 'CLOCK_IN_WORK';
      const { data, error } = await this.supabase
        .from('dtr_entries')
        .insert({ user_id: userId, time_in: nowIsoString })
        .select()
        .single();
      if (error) throw error;
      dtrEntry = data;

    } else if (entryCount === 1 && lastEntry.time_in && !lastEntry.time_out) {
      // Action 2: Second scan - Clock-Out for Break
      // Add a 1-hour restriction to prevent accidental double-scans
      const timeInDate = new Date(lastEntry.time_in);
      const timeDifferenceMs = nowPST.getTime() - timeInDate.getTime();
      const oneHourInMs = 3600 * 1000;

      if (timeDifferenceMs < oneHourInMs) {
        throw new Error('Time out rejected, this is still not the time for your break time');
      }

      status = 'CLOCK_OUT_BREAK';
      const { data, error } = await this.supabase
        .from('dtr_entries')
        .update({ time_out: nowIsoString })
        .eq('id', lastEntry.id)
        .select()
        .single();
      if (error) throw error;
      dtrEntry = data;

    } else if (entryCount === 1 && lastEntry.time_in && lastEntry.time_out) {
      // Action 3: Third scan - Clock-In from Break
      status = 'CLOCK_IN_BREAK';
       const { data, error } = await this.supabase
        .from('dtr_entries')
        .insert({ user_id: userId, time_in: nowIsoString })
        .select()
        .single();
      if (error) throw error;
      dtrEntry = data;

    } else if (entryCount === 2 && lastEntry.time_in && !lastEntry.time_out) {
      // Action 4: Fourth scan - Clock-Out for the Day
      status = 'CLOCK_OUT_DAY';
      const { data, error } = await this.supabase
        .from('dtr_entries')
        .update({ time_out: nowIsoString })
        .eq('id', lastEntry.id)
        .select()
        .single();
      if (error) throw error;
      dtrEntry = data;
    } else {
      // All other cases are invalid (e.g., 5th scan after clocking out for the day)
      // Add a 3-hour lockout period to prevent accidental scans long after a shift ends.
      if (entryCount === 2 && lastEntry.time_out) {
        const timeOutDate = new Date(lastEntry.time_out);
        const timeDifferenceMs = nowPST.getTime() - timeOutDate.getTime();
        const threeHoursInMs = 3 * 3600 * 1000;

        if (timeDifferenceMs > threeHoursInMs) {
          throw new Error('Clock-in rejected. It has been more than 3 hours since you clocked out.');
        }
      }
      
      throw new Error('You have already completed all your time entries for today.');
    }

    return { profile, dtrEntry, status };
  }


  getAllDtrEntries() {
    return this.supabase
      .from('dtr_entries')
      .select(`
        *,
        profiles (
          first_name,
          last_name
        )
      `)
      .order('time_in', { ascending: false });
  }

  getDtrHistoryForCurrentUser() {
    const userId = this.currentUser()?.id;
    if (!userId) {
      return Promise.resolve({ data: [], error: new Error('User not logged in.') as any });
    }
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', userId)
      .order('time_in', { ascending: false });
  }

  async getDtrEntriesForDateRange(startDate: string, endDate: string) {
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .not('time_in', 'is', null) // Defensively filter out entries without a time_in
      .gte('time_in', startDate)
      .lte('time_in', endDate);
  }
  
  async getDtrEntriesForUsersInDateRange(userIds: string[], startDate: string, endDate: string) {
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .in('user_id', userIds)
      .not('time_in', 'is', null)
      .gte('time_in', startDate)
      .lte('time_in', endDate);
  }

  async getLatestDtrEntriesForToday(userIds: string[]) {
    if (userIds.length === 0) return { data: [], error: null };
    // This RPC function fetches the latest DTR entry for today for each user ID passed.
    // Assumes an RPC function `get_latest_dtr_for_today` exists in Supabase.
    // If not, this needs to be implemented in Supabase SQL editor.
    // `CREATE OR REPLACE FUNCTION get_latest_dtr_for_today(user_ids uuid[]) ...`
    return this.supabase.rpc('get_latest_dtr_for_today', { user_ids: userIds });
  }

  // --- EMPLOYEE SCHEDULES ---

  getSchedulesForDateRange(userIds: string[], startDate: string, endDate: string) {
    return this.supabase
      .from('employee_schedules')
      .select('*')
      .in('user_id', userIds)
      .gte('date', startDate)
      .lte('date', endDate);
  }
  
  upsertSchedules(schedules: Omit<EmployeeSchedule, 'id' | 'created_at'>[]) {
    return this.supabase
      .from('employee_schedules')
      .upsert(schedules, { onConflict: 'user_id, date' });
  }

  deleteSchedules(schedules: { userId: string; date: string }[]) {
    if (schedules.length === 0) {
      return Promise.resolve([]);
    }
    const deletePromises = schedules.map(s =>
      this.supabase.from('employee_schedules').delete().match({ user_id: s.userId, date: s.date })
    );
    return Promise.all(deletePromises);
  }

  // --- EMPLOYEE STATUS & LEAVE ---

  getStatusesForDate(userIds: string[], date: string) {
    if (userIds.length === 0) return Promise.resolve({ data: [], error: null });
    return this.supabase
      .from('employee_status')
      .select('*')
      .in('user_id', userIds)
      .eq('date', date);
  }
  
  getStatusesForDateRange(userId: string, startDate: string, endDate: string) {
    return this.supabase
      .from('employee_status')
      .select('*')
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate);
  }
  
  getAllStatusesForDateRange(userIds: string[], startDate: string, endDate: string) {
    return this.supabase
      .from('employee_status')
      .select('*')
      .in('user_id', userIds)
      .gte('date', startDate)
      .lte('date', endDate);
  }


  getStatusesForCurrentUser() {
    const userId = this.currentUser()?.id;
    if (!userId) {
      return Promise.resolve({ data: [], error: new Error('User not logged in.') as any });
    }
    return this.supabase
      .from('employee_status')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });
  }

  async requestLeaveAndUpdateBalance(
    userId: string,
    leaveRequests: { date: string; status: EmployeeStatus['status'] }[],
    balanceUpdates: Partial<Profile>
  ) {
    // 1. Insert the status logs
    const { error: insertError } = await this.supabase
      .from('employee_status')
      .insert(leaveRequests.map(req => ({ ...req, user_id: userId })));
      
    if (insertError) throw insertError;

    // 2. Update the profile with new balances if there are any
    if (Object.keys(balanceUpdates).length > 0) {
      const { error: updateError } = await this.updateUserProfile(userId, balanceUpdates);
      if (updateError) {
        // Attempt to roll back status insert - not truly atomic but better than nothing
        const datesToDelete = leaveRequests.map(req => req.date);
        await this.supabase.from('employee_status').delete().eq('user_id', userId).in('date', datesToDelete);
        throw updateError;
      }
    }
  }


  // --- SALARY RULES ---
  getAllSalaryRules() {
    return this.supabase.from('salary_rules').select('*').order('created_at', { ascending: false });
  }
  
  getActiveSalaryRules() {
    return this.supabase.from('salary_rules').select('*').eq('is_active', true);
  }

  createSalaryRule(rule: Omit<SalaryRule, 'id' | 'created_at'>) {
    return this.supabase.from('salary_rules').insert(rule);
  }

  updateSalaryRule(id: number, rule: Partial<SalaryRule>) {
    return this.supabase.from('salary_rules').update(rule).eq('id', id);
  }

  deleteSalaryRule(id: number) {
    return this.supabase.from('salary_rules').delete().eq('id', id);
  }


  // --- PAYROLL ---
  getAllPayrolls() {
    return this.supabase
      .from('payrolls')
      .select(`
        *,
        profiles (
          first_name,
          last_name
        )
      `)
      .order('created_at', { ascending: false });
  }
  
  getPayrollsForCurrentUser() {
    const userId = this.currentUser()?.id;
    if (!userId) {
      return Promise.resolve({ data: [], error: new Error('User not logged in.') as any });
    }
    return this.supabase.from('payrolls').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  }

  async runPayrollForEmployees(payrolls: Omit<Payroll, 'id' | 'created_at' | 'status'>[]) {
    const payrollsToInsert = payrolls.map(p => ({
      ...p,
      status: 'Paid' as const,
    }));
    return this.supabase.from('payrolls').insert(payrollsToInsert);
  }
  
  updatePayrollStatus(payrollId: number, status: 'Paid' | 'Delayed' | 'Unpaid') {
    return this.supabase.from('payrolls').update({ status }).eq('id', payrollId).select().single();
  }

  // --- DYNAMIC SETTINGS & RATES ---
  getCompanySettings() {
    return this.supabase.from('company_settings').select('*');
  }

  async updateCompanySettings(settings: { key: string; value: any }[]) {
    const updates = settings.map(s => 
      this.supabase
        .from('company_settings')
        .update({ setting_value: s.value })
        .eq('setting_key', s.key)
    );
    const results = await Promise.all(updates);
    const errorResult = results.find(r => r.error);
    if (errorResult) {
      throw errorResult.error;
    }
    return results;
  }
  
  getPositions() {
    return this.supabase.from('positions').select('*');
  }

  getBranches() {
    return this.supabase.from('branches').select('*');
  }
  
  getPositionRates() {
    return this.supabase.from('position_rates').select(`
      *,
      positions (name),
      branches (name)
    `);
  }

  upsertPositionRate(rate: Partial<PositionRate>) {
    return this.supabase.from('position_rates').upsert(rate, { onConflict: 'position_id, branch_id' });
  }


  // --- REALTIME ---
  // FIX: Use `any` for RealtimeChannel as it is not available from import.
  subscribeToTableChanges(callback: () => void): any {
    return this.supabase.channel('public-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dtr_entries' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_schedules' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_status' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'company_settings' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'position_rates' }, callback)
      .subscribe();
  }

  // FIX: Use `any` for RealtimeChannel as it is not available from import.
  unsubscribe(channel: any) {
    this.supabase.removeChannel(channel);
  }
}