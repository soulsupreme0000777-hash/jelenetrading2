import { Injectable, signal, computed, inject } from '@angular/core';
import {
  createClient,
  SupabaseClient,
  PostgrestError,
  // FIX: Types not available in the user's Supabase version.
  // AuthChangeEvent,
  // Session,
  // User,
  // RealtimeChannel,
} from '@supabase/supabase-js';
import { environment } from '../environments/environment';

// --- Type Definitions based on Database Schema ---

export interface Profile {
  id: string; // UUID
  employee_id?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  age?: number | null;
  mobile_number?: string | null;
  daily_rate?: number | null;
  role: 'admin' | 'superadmin' | 'employee';
  created_at: string; // timestamp with time zone
  hire_date?: string | null; // date
  birth_date?: string | null; // date
  day_off_balance?: number;
  sil_balance?: number;
  avatar_url?: string | null;
  is_deleted: boolean;
  position_id?: number | null;
  branch_id?: number | null;
  branch?: string | null;
  position?: string | null;
}

export interface DtrEntry {
  id: number;
  user_id: string;
  time_in?: string | null;
  time_out?: string | null;
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
  status: 'Paid' | 'Delayed' | 'Unpaid';
  raise_details?: any[] | null; // JSONB
  created_at: string;
  salary_raise: number; // For backward compatibility if needed
}

export interface EmployeeSchedule {
  id: number;
  user_id: string;
  date: string; // date
  work_start_time: string; // time
  work_end_time: string; // time;
}

export interface EmployeeStatus {
  id: number;
  user_id: string;
  date: string;
  status: 'day_off' | 'service_incentive_leave' | 'emergency_leave';
}

export interface SalaryRule {
  id: number;
  name: string;
  description?: string | null;
  raise_amount: number;
  start_date: string;
  end_date: string;
  is_active: boolean;
}

export interface CompanySetting {
  id: number;
  setting_key: string;
  setting_value: any; // JSONB
  description?: string | null;
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
}

// FIX: Using `any` as User type is not available from import.
export type UserWithProfile = any & { profile: Profile | null };

export type NewUserPayload = {
  email: string;
  password: string;
  profileData: Partial<Profile>;
};

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;

  // --- State Signals ---
  isInitialized = signal(false);
  // FIX: Using `any` as Session type is not available from import.
  session = signal<any | null>(null);
  // FIX: Using `any` as User type is not available from import.
  currentUser = signal<any | null>(null);
  currentUserProfile = signal<Profile | null | undefined>(undefined);
  profileError = signal<string | null>(null);
  
  currentUserRole = computed(() => this.currentUserProfile()?.role || null);

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseKey);

    // FIX: The type definitions for the user's Supabase version appear to be incorrect. Casting to 'any' to bypass the compile-time error for 'onAuthStateChange'.
    (this.supabase.auth as any).onAuthStateChange(
      // FIX: Using `any` for event and session as types are not available from import.
      (event: any, session: any | null) => {
        this.session.set(session);
        const user = session?.user ?? null;
        this.currentUser.set(user);
        
        if (user) {
          // Fire-and-forget the profile load. The component will react to its loading state.
          this.loadUserProfile(user.id);
        } else {
          this.currentUserProfile.set(null);
        }
        
        // This signal is crucial for the auth guard to work correctly. It should
        // fire after the auth state is known, but not wait for the profile.
        this.isInitialized.set(true); 
      }
    );
  }

  // --- Auth ---
  async signInWithPassword(credentials: { email: string; password: string }) {
    // The project uses Supabase JS v2; the correct method is `signInWithPassword`.
    // The previous implementation incorrectly used `signIn`, which is for OAuth or from an older version, causing a runtime error.
    // Casting to 'any' bypasses potential type mismatches from CDN imports, consistent with other auth methods in this file.
    return (this.supabase.auth as any).signInWithPassword(credentials);
  }

  async signOut() {
    // FIX: The type definitions for the user's Supabase version appear to be incorrect. Casting to 'any' to bypass the compile-time error for 'signOut'.
    return (this.supabase.auth as any).signOut();
  }

  // --- Profiles ---
  async loadUserProfile(userId: string): Promise<void> {
    this.profileError.set(null);
    this.currentUserProfile.set(undefined); // Set to loading state
    try {
      const { data, error } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (error) throw error;
      this.currentUserProfile.set(data as Profile);
    } catch (e: any) {
      this.profileError.set(e.message || 'Failed to load user profile.');
      this.currentUserProfile.set(null);
    }
  }
  
  async updateUserProfile(userId: string, profileData: Partial<Profile>) {
    return this.supabase.from('profiles').update(profileData).eq('id', userId);
  }

  async getAllUsersWithProfiles() {
    return this.supabase.from('profiles').select('*').eq('is_deleted', false);
  }

  async getDeletedUsersWithProfiles() {
    return this.supabase.from('profiles').select('*').eq('is_deleted', true);
  }

  async createNewUser(payload: NewUserPayload) {
    // The project uses Supabase JS v2, where `signUp` expects an object with email and password.
    // FIX: The type definitions for the user's Supabase version appear to be incorrect. Casting to 'any' to bypass the compile-time error for 'signUp', consistent with other fixes in this file.
    const { data: authData, error: authError } = await (this.supabase.auth as any).signUp({
      email: payload.email,
      password: payload.password
    });
    if (authError) throw authError;
    if (!authData.user) throw new Error('User not created.');

    const { data: profileData, error: profileError } = await this.supabase
      .from('profiles')
      .update(payload.profileData)
      .eq('id', authData.user.id)
      .select()
      .single();
    if (profileError) throw profileError;

    return {
      user: authData.user,
      profile: profileData as Profile,
      qrData: JSON.stringify({ userId: authData.user.id, email: authData.user.email }),
    };
  }
  
  async softDeleteUsers(userIds: string[]) {
    return this.supabase.from('profiles').update({ is_deleted: true }).in('id', userIds);
  }

  async recoverUsers(userIds: string[]) {
    return this.supabase.from('profiles').update({ is_deleted: false }).in('id', userIds);
  }

  async permanentlyDeleteUser(userId: string) {
    return this.supabase.rpc('delete_auth_user', { user_id_to_delete: userId });
  }

  // --- Storage (Avatars) ---
  async uploadAvatar(userId: string, file: File): Promise<string> {
    const filePath = `${userId}/${Date.now()}`;
    const { error: uploadError } = await this.supabase.storage.from('avatars').upload(filePath, file);
    if (uploadError) throw uploadError;
    
    const { data } = this.supabase.storage.from('avatars').getPublicUrl(filePath);
    return data.publicUrl;
  }

  // --- DTR & Schedules ---
  async getDtrHistoryForCurrentUser() {
    const user = this.currentUser();
    if (!user) return { data: [], error: null };
    return this.supabase.from('dtr_entries').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  }
  
  async getDtrEntriesForDateRange(start: string, end: string) {
    return this.supabase.from('dtr_entries').select('*').gte('time_in', start).lt('time_in', end);
  }

  async getDtrEntriesForUsersInDateRange(userIds: string[], start: string, end: string) {
    return this.supabase.from('dtr_entries').select('*').in('user_id', userIds).gte('time_in', start).lt('time_in', end);
  }

  async getSchedulesForDateRange(userIds: string[], startDate: string, endDate: string) {
    return this.supabase.from('employee_schedules').select('*').in('user_id', userIds).gte('date', startDate).lte('date', endDate);
  }
  
  async upsertSchedules(schedules: Omit<EmployeeSchedule, 'id' | 'created_at'>[]) {
    return this.supabase.from('employee_schedules').upsert(schedules, { onConflict: 'user_id, date' });
  }

  async deleteSchedules(schedules: { userId: string, date: string }[]) {
    const deletePromises = schedules.map(s => 
        this.supabase.from('employee_schedules').delete().match({ user_id: s.userId, date: s.date })
    );
    return Promise.all(deletePromises);
  }

  // --- Leave & Status ---
  async getStatusesForDate(userIds: string[], date: string) {
    return this.supabase.from('employee_status').select('*').in('user_id', userIds).eq('date', date);
  }
  
  async getAllStatusesForDateRange(userIds: string[], startDate: string, endDate: string) {
    return this.supabase.from('employee_status').select('*').in('user_id', userIds).gte('date', startDate).lte('date', endDate);
  }

  async getStatusesForDateRange(userId: string, startDate: string, endDate: string) {
    return this.supabase.from('employee_status').select('*').eq('user_id', userId).gte('date', startDate).lte('date', endDate);
  }
  
  async requestLeaveAndUpdateBalance(userId: string, leaveRequests: {date: string, status: EmployeeStatus['status']}[], balanceUpdates: Partial<Profile>) {
    const { error: leaveError } = await this.supabase.from('employee_status').insert(leaveRequests.map(lr => ({ ...lr, user_id: userId })));
    if (leaveError) throw leaveError;
    const { error: balanceError } = await this.updateUserProfile(userId, balanceUpdates);
    if (balanceError) throw balanceError;
  }

  // --- Payroll & Settings ---
  async getAllPayrolls() {
    return this.supabase.from('payrolls').select('*, profiles:profiles(first_name, last_name)');
  }
  
  async getPayrollsForCurrentUser() {
    const user = this.currentUser();
    if (!user) return { data: [], error: null };
    return this.supabase.from('payrolls').select('*').eq('user_id', user.id).order('pay_period_end', { ascending: false });
  }
  
  async updatePayrollStatus(payrollId: number, status: Payroll['status']) {
    return this.supabase.from('payrolls').update({ status }).eq('id', payrollId);
  }

  async runPayrollForEmployees(payrolls: Partial<Payroll>[]) {
    return this.supabase.from('payrolls').insert(payrolls);
  }

  async getCompanySettings() {
    return this.supabase.from('company_settings').select('*');
  }

  async updateCompanySettings(settings: { key: string, value: any }[]) {
    const updates = settings.map(s => 
      this.supabase.from('company_settings').update({ setting_value: s.value }).eq('setting_key', s.key)
    );
    return Promise.all(updates);
  }
  
  async getAllSalaryRules() {
    return this.supabase.from('salary_rules').select('*').order('created_at', { ascending: false });
  }

  async getActiveSalaryRules() {
    return this.supabase.from('salary_rules').select('*').eq('is_active', true);
  }

  async createSalaryRule(ruleData: Omit<SalaryRule, 'id'>) {
    return this.supabase.from('salary_rules').insert([ruleData]);
  }

  async updateSalaryRule(id: number, ruleData: Partial<SalaryRule>) {
    return this.supabase.from('salary_rules').update(ruleData).eq('id', id);
  }

  async deleteSalaryRule(id: number) {
    return this.supabase.from('salary_rules').delete().eq('id', id);
  }

  // --- General Lookups ---
  async getPositions() {
    return this.supabase.from('positions').select('*');
  }

  async getBranches() {
    return this.supabase.from('branches').select('*');
  }

  async getPositionRates() {
    return this.supabase.from('position_rates').select('*');
  }

  async upsertPositionRates(rates: Omit<PositionRate, 'id'>[]) {
    return this.supabase.from('position_rates').upsert(rates, { onConflict: 'position_id, branch_id' });
  }
  
  async updateAllEmployeeDailyRates() {
    return this.supabase.rpc('update_all_employee_daily_rates');
  }

  // --- Time Clock ---
  async handleQrCodeLogin(userId: string) {
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileError) throw new Error('Employee profile not found.');
    
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    const { data: todaysEntries, error: dtrError } = await this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay)
      .order('created_at', { ascending: true });
    
    if (dtrError) throw dtrError;

    const lastEntry = todaysEntries[todaysEntries.length - 1];

    if (!lastEntry || lastEntry.time_out) {
      // Clocking in (either first of day or after break)
      const { data: newEntry, error } = await this.supabase
        .from('dtr_entries')
        .insert({ user_id: userId, time_in: now.toISOString() })
        .select()
        .single();
      if (error) throw error;
      const status = todaysEntries.length === 0 ? 'CLOCK_IN_WORK' : 'CLOCK_IN_BREAK';
      return { profile, dtrEntry: newEntry, status };
    } else {
      // Clocking out (either for break or for the day)
      const { data: updatedEntry, error } = await this.supabase
        .from('dtr_entries')
        .update({ time_out: now.toISOString() })
        .eq('id', lastEntry.id)
        .select()
        .single();
      if (error) throw error;
      const status = todaysEntries.length === 1 ? 'CLOCK_OUT_BREAK' : 'CLOCK_OUT_DAY';
      return { profile, dtrEntry: updatedEntry, status };
    }
  }

  // --- Realtime ---
  // FIX: Using `any` as RealtimeChannel type is not available from import.
  subscribeToTableChanges(callback: () => void): any {
    const channel = this.supabase
      .channel('public:profiles')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => callback())
      .subscribe();
    return channel;
  }

  // FIX: Using `any` as RealtimeChannel type is not available from import.
  unsubscribe(channel: any) {
    this.supabase.removeChannel(channel);
  }
}