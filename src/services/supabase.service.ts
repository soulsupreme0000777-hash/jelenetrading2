import { Injectable, signal, computed, inject } from '@angular/core';
import {
  createClient,
  SupabaseClient,
  User,
  AuthError,
  PostgrestError,
  AuthTokenResponse,
  SignInWithPasswordCredentials,
  RealtimeChannel,
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
  total_hours: number;
  gross_pay: number;
  lateness_minutes: number;
  early_departure_minutes: number;
  lateness_deductions: number;
  early_departure_deductions: number;
  manual_deductions: number;
  net_pay: number;
  created_at: string;
  status: 'Paid' | 'Delayed' | 'Unpaid';
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

export type UserWithProfile = User & { profile: Profile | null };

// --- CRITICAL DATABASE SETUP SCRIPT (V3) ---
// If data is not showing up or you see a "Profile Not Found" error, it means
// your new database is missing critical setup steps.
//
// To fix this permanently, run this entire script in your Supabase project's
// SQL Editor ONE TIME. It is safe to run multiple times.

/*
-- =================================================================
-- V3: COMPLETE SUPABASE DATABASE SETUP SCRIPT
-- =================================================================
-- This script fixes the "infinite recursion" error AND ensures new users
-- get a profile automatically, which is a common issue when migrating databases.
--
-- Run this entire script in your Supabase SQL Editor ONCE.
-- =================================================================

-- Step 1: Create the function to auto-create a profile for new users.
-- This function is called by a trigger when a new user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER -- Allows the function to bypass RLS to insert the profile.
SET search_path = public
AS $$
BEGIN
  -- Insert a new profile record for the new user, defaulting their role to 'employee'.
  -- The user's ID and email are taken from the new user record in auth.users.
  INSERT INTO public.profiles (id, email, role)
  VALUES (new.id, new.email, 'employee');
  RETURN new;
END;
$$;

-- Step 2: Create the trigger that calls the function.
-- This ensures that every time a user is created in the authentication system,
-- their profile is automatically created in the public table.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users; -- Drop old trigger if it exists
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Step 3: Create a helper function to safely get the current user's role.
-- This function is used in RLS policies to avoid infinite recursion.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- It safely queries the profiles table for the role of the currently logged-in user.
  RETURN (SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1);
END;
$$;

-- Step 4: Enable Row Level Security (RLS) on all tables if not already enabled.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dtr_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_rules ENABLE ROW LEVEL SECURITY;

-- Step 5: Drop all old policies to ensure a clean slate.
-- This removes any previous, potentially incorrect RLS rules.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(r.policyname) || ' ON public.' || quote_ident(r.tablename);
    END LOOP;
END $$;


-- Step 6: Create comprehensive RLS policies for all tables.
-- These rules define who can see and modify data.

-- === PROFILES ===
-- Users can see their own profile.
CREATE POLICY "Allow individuals to view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
-- Users can update their own profile (though the UI restricts this, the policy allows it).
CREATE POLICY "Allow individuals to update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
-- Admins can manage all profiles.
CREATE POLICY "Allow admins to manage all profiles" ON public.profiles FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === DTR ENTRIES ===
-- Users can view their own DTR entries.
CREATE POLICY "Allow individuals to view their own DTR entries" ON public.dtr_entries FOR SELECT USING (auth.uid() = user_id);
-- Users can create their own DTR entries (when they clock in/out).
CREATE POLICY "Allow individuals to create their own DTR entries" ON public.dtr_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
-- Admins can manage all DTR entries.
CREATE POLICY "Allow admins to manage all DTR entries" ON public.dtr_entries FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === PAYROLLS ===
-- Users can view their own payrolls.
CREATE POLICY "Allow individuals to view their own payrolls" ON public.payrolls FOR SELECT USING (auth.uid() = user_id);
-- Admins can manage all payrolls.
CREATE POLICY "Allow admins to manage all payrolls" ON public.payrolls FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === EMPLOYEE SCHEDULES ===
-- Users can view their own schedules.
CREATE POLICY "Allow individuals to view their own schedules" ON public.employee_schedules FOR SELECT USING (auth.uid() = user_id);
-- Admins can manage all schedules.
CREATE POLICY "Allow admins to manage all schedules" ON public.employee_schedules FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === EMPLOYEE STATUS (LEAVE) ===
-- Users can view their own status/leave records.
CREATE POLICY "Allow individuals to view their own status" ON public.employee_status FOR SELECT USING (auth.uid() = user_id);
-- Users can create their own status/leave records.
CREATE POLICY "Allow individuals to create their own status" ON public.employee_status FOR INSERT WITH CHECK (auth.uid() = user_id);
-- Admins can manage all statuses.
CREATE POLICY "Allow admins to manage all statuses" ON public.employee_status FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === SALARY RULES ===
-- Salary rules are admin-only.
CREATE POLICY "Allow admins to manage salary rules" ON public.salary_rules FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

*/

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;
  private router = inject(Router);

  // --- STATE SIGNALS ---

  isInitialized = signal(false);
  currentUser = signal<User | null>(null);
  currentUserProfile = signal<Profile | null | undefined>(undefined);
  profileError = signal<string | null>(null);

  currentUserRole = computed<'superadmin' | 'admin' | 'employee' | null>(() => this.currentUserProfile()?.role || null);

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseKey);

    this.supabase.auth.onAuthStateChange((event, session) => {
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

  signInWithPassword(credentials: SignInWithPasswordCredentials): Promise<AuthTokenResponse> {
    return this.supabase.auth.signInWithPassword(credentials);
  }

  signOut() {
    return this.supabase.auth.signOut();
  }

  // --- PROFILE MANAGEMENT ---

  async loadUserProfile(userId: string): Promise<void> {
    this.profileError.set(null);
    try {
      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
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
      .eq('role', 'employee');
  }
  
  updateUserProfile(userId: string, profileData: Partial<Profile>) {
    return this.supabase.from('profiles').update(profileData).eq('id', userId);
  }

  deleteUserAndProfile(userId: string) {
    // --- REQUIRED DATABASE SETUP ---
    // To securely delete a user, we must call a PostgreSQL function in Supabase.
    // The error "Could not find the function public.delete_auth_user" means this
    // function has not been created in your database yet.
    //
    // Please go to your Supabase project's SQL Editor and run the following query ONE TIME:
    /*
    CREATE OR REPLACE FUNCTION delete_auth_user(user_id_to_delete uuid)
    RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      -- This function runs with the permissions of the function owner (postgres),
      -- allowing it to bypass RLS and delete from the auth.users table.
      DELETE FROM auth.users u WHERE u.id = user_id_to_delete;
      
      -- The user's profile in the public.profiles table will be deleted automatically
      -- if you have a foreign key with 'ON DELETE CASCADE' set up.
      
      RETURN 'User deleted successfully from auth schema.';
    END;
    $$;
    */
    // NOTE: Make sure your 'profiles' table has a foreign key constraint
    // to 'auth.users(id)' that is set to 'ON DELETE CASCADE'.
    
    return this.supabase.rpc('delete_auth_user', { user_id_to_delete: userId });
  }

  async createNewUser(payload: NewUserPayload) {
    // 1. Get the current admin session to restore it later.
    const { data: { session: adminSession } } = await this.supabase.auth.getSession();
    if (!adminSession) {
      this.router.navigate(['/login']);
      throw new Error("Admin session not found. Please log in again.");
    }

    try {
      // 2. Create the new user. This signs out the admin and signs in the new user.
      const { data: authData, error: authError } = await this.supabase.auth.signUp({
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

      // 3. The user's profile is often created automatically by a database trigger
      // when a new user signs up in `auth.users`. To fix the "duplicate key" error,
      // we must UPDATE the auto-created profile instead of trying to INSERT a new one.
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
      // 4. ALWAYS restore the admin's session, whether user creation succeeded or failed.
      const { error: sessionError } = await this.supabase.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
      });

      if (sessionError) {
        // This is a critical state. Admin is logged out and session couldn't be restored.
        // Forcing a redirect to login is the safest recovery action.
        console.error('FATAL: Could not restore admin session after user creation attempt.', sessionError);
        this.router.navigate(['/login']);
      }
    }
  }


  // --- DTR (Daily Time Record) ---

  async handleQrCodeLogin(userId: string) {
    // 1. Fetch user's profile
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(); // Use maybeSingle to prevent crash on no rows
    if (profileError) throw profileError;
    if (!profile) throw new Error('User not found.'); // Explicitly handle null profile
    
    // Check for the last DTR entry for today
    const today = new Date().toISOString().slice(0, 10);
    const { data: lastEntry, error: dtrError } = await this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', `${today}T00:00:00.000Z`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dtrError) throw dtrError;

    let dtrEntry: DtrEntry;

    if (!lastEntry || lastEntry.time_out) {
      // Time IN
      const { data: newEntry, error: insertError } = await this.supabase
        .from('dtr_entries')
        .insert({ user_id: userId, time_in: new Date().toISOString() })
        .select()
        .single();
      if (insertError) throw insertError;
      dtrEntry = newEntry;
    } else {
      // Time OUT
      const { data: updatedEntry, error: updateError } = await this.supabase
        .from('dtr_entries')
        .update({ time_out: new Date().toISOString() })
        .eq('id', lastEntry.id)
        .select()
        .single();
      if (updateError) throw updateError;
      dtrEntry = updatedEntry;
    }

    return { profile, dtrEntry };
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
      return Promise.resolve({ data: [], error: new Error('User not logged in.') });
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

  // --- EMPLOYEE STATUS & LEAVE ---

  getStatusesForDate(userIds: string[], date: string) {
    if (userIds.length === 0) return Promise.resolve({ data: [], error: null });
    return this.supabase
      .from('employee_status')
      .select('*')
      .in('user_id', userIds)
      .eq('date', date);
  }

  getStatusesForCurrentUser() {
    const userId = this.currentUser()?.id;
    if (!userId) {
      return Promise.resolve({ data: [], error: new Error('User not logged in.') });
    }
    return this.supabase
      .from('employee_status')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });
  }

  async setEmployeeStatus(
    userId: string,
    status: EmployeeStatus['status'],
    newBalances: Partial<Profile>
  ) {
    // 1. Insert the status log
    const { error: insertError } = await this.supabase
      .from('employee_status')
      .insert({
        user_id: userId,
        status: status,
        date: new Date().toISOString().slice(0, 10),
      });
    if (insertError) throw insertError;

    // 2. Update the profile with new balances
    const { error: updateError } = await this.updateUserProfile(userId, newBalances);
    if (updateError) throw updateError;
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
      return Promise.resolve({ data: [], error: new Error('User not logged in.') });
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

  // --- REALTIME ---
  subscribeToTableChanges(callback: () => void): RealtimeChannel {
    return this.supabase.channel('public-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dtr_entries' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_status' }, callback)
      .subscribe();
  }

  unsubscribe(channel: RealtimeChannel) {
    this.supabase.removeChannel(channel);
  }
}