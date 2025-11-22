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
  salary_raise: number;
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

export type UserWithProfile = User & { profile: Profile | null };

// --- RECOMMENDED DATABASE CLEANUP SCRIPT (V6) ---
// The application code has been updated to work around the "early_departure_minutes"
// error. Running the script below is recommended for long-term database health
// but is no longer critical for the app to function.
//
// Run this script in your Supabase SQL Editor to safely remove old columns.
/*
-- =================================================================
-- V6: SIMPLIFIED DATABASE CLEANUP SCRIPT
-- =================================================================
-- NOTE: The application code has been updated to work even if your database
-- schema is out of date. This script is now for cleanup and long-term
-- database health. Running this is recommended but no longer critical
-- to prevent the "early_departure_minutes" error.
--
-- This script safely removes old, incorrectly named columns from the 'payrolls' table.
-- It is idempotent, meaning it is SAFE TO RUN MULTIPLE TIMES.
-- =================================================================

-- Step 1: Drop the old, incorrectly named 'minutes' column if it exists.
ALTER TABLE public.payrolls DROP COLUMN IF EXISTS early_departure_minutes;

-- Step 2: Drop the old, incorrectly named 'deductions' column if it exists.
ALTER TABLE public.payrolls DROP COLUMN IF EXISTS early_departure_deductions;

-- Step 3: (From previous versions, included for completeness) Ensure all required columns exist.
-- This ensures the schema is correct going forward. It's safe to run this again.
ALTER TABLE public.payrolls
  ADD COLUMN IF NOT EXISTS salary_raise NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lateness_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undertime_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lateness_deductions NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS undertime_deductions NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raise_details JSONB;

-- Step 4: Create essential database functions.

-- Function to auto-create a profile for new users.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (new.id, new.email, 'employee');
  RETURN new;
END;
$$;

-- Function to safely get the current user's role for RLS policies.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN (SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1);
END;
$$;

-- Function to securely delete a user from the auth system.
CREATE OR REPLACE FUNCTION public.delete_auth_user(user_id_to_delete uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM auth.users u WHERE u.id = user_id_to_delete;
  RETURN 'User deleted successfully from auth schema.';
END;
$$;
-- Note: Ensure your 'profiles' table has a foreign key to 'auth.users(id)' with 'ON DELETE CASCADE'.

-- Step 5: Create triggers.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Step 6: Enable Row Level Security (RLS) on all tables.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dtr_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_rules ENABLE ROW LEVEL SECURITY;

-- Step 7: Drop all old policies to ensure a clean slate.
DO $$ DECLARE r RECORD;
BEGIN
    FOR r IN (SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(r.policyname) || ' ON public.' || quote_ident(r.tablename);
    END LOOP;
END $$;

-- Step 8: Create comprehensive RLS policies for all tables.

-- === PROFILES ===
CREATE POLICY "Allow individuals to view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Allow individuals to update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Allow admins to manage all profiles" ON public.profiles FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === DTR ENTRIES ===
CREATE POLICY "Allow individuals to view their own DTR entries" ON public.dtr_entries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individuals to create their own DTR entries" ON public.dtr_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all DTR entries" ON public.dtr_entries FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === PAYROLLS ===
CREATE POLICY "Allow individuals to view their own payrolls" ON public.payrolls FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all payrolls" ON public.payrolls FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === EMPLOYEE SCHEDULES ===
CREATE POLICY "Allow individuals to view their own schedules" ON public.employee_schedules FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all schedules" ON public.employee_schedules FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === EMPLOYEE STATUS (LEAVE) ===
CREATE POLICY "Allow individuals to view their own status" ON public.employee_status FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individuals to create their own status" ON public.employee_status FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow admins to manage all statuses" ON public.employee_status FOR ALL USING (get_my_role() IN ('admin', 'superadmin'));

-- === SALARY RULES ===
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
    // This RPC call requires the `delete_auth_user` function to be created in your database.
    // This function is included in the main database setup script at the top of this file.
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
        console.error('FATAL: Could not restore admin session after user creation attempt.', sessionError.message);
        this.router.navigate(['/login']);
      }
    }
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
      .not('time_in', 'is', null) // Defensively filter out entries without a time_in
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
      return Promise.resolve({ data: [], error: new Error('User not logged in.') });
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_schedules' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_status' }, callback)
      .subscribe();
  }

  unsubscribe(channel: RealtimeChannel) {
    this.supabase.removeChannel(channel);
  }
}