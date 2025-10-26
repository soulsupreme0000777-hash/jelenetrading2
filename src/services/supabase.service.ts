import { Injectable, signal, computed, inject } from '@angular/core';
import {
  createClient,
  SupabaseClient,
  User,
  AuthError,
  PostgrestError,
  AuthTokenResponse,
  SignInWithPasswordCredentials,
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
  position?: string | null;
  daily_rate?: number | null;
  avatar_url?: string | null;
  role?: 'admin' | 'employee' | 'superadmin' | null;
  status?: 'active' | 'inactive' | null;
  department_id?: number | null;
  departments?: Department | null; // For joined data
  created_at?: string;
}

export interface DtrEntry {
  id: number;
  user_id: string;
  time_in: string | null;
  time_out: string | null;
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

export interface Department {
  id: number;
  name: string;
  work_start_time?: string; // e.g., '09:00:00'
  work_end_time?: string;   // e.g., '18:00:00'
  grace_period_minutes?: number;
  deduction_rate_per_minute?: number;
}

export interface NewUserPayload {
  email: string;
  password?: string;
  imageFile: File | null;
  profileData: Partial<Profile>;
}

export type UserWithProfile = User & { profile: Profile | null };

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;
  private router = inject(Router);

  // --- STATE SIGNALS ---

  isInitialized = signal(false);
  currentUser = signal<User | null>(null);
  currentUserProfile = signal<Profile | null>(null);
  profileError = signal<string | null>(null);

  currentUserRole = computed<'superadmin' | 'admin' | 'employee' | null>(() => this.currentUserProfile()?.role || null);

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseKey);

    this.supabase.auth.onAuthStateChange((event, session) => {
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
      // 1. Get the profile
      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (profileError) throw profileError;

      // 2. Get the department if department_id exists
      let department: Department | null = null;
      if (profile && profile.department_id) {
        const { data: deptData, error: deptError } = await this.supabase
          .from('departments')
          .select('*')
          .eq('id', profile.department_id)
          .single();
        if (deptError) {
          console.warn(`Could not fetch department for user ${userId}:`, deptError.message);
        } else {
          department = deptData;
        }
      }
      
      // 3. Combine them and set the signal
      const profileWithDepartment = {
        ...profile,
        departments: department,
      };
      this.currentUserProfile.set(profileWithDepartment);

    } catch (error: any) {
      this.profileError.set(error.message);
      this.currentUserProfile.set(null);
    }
  }

  async getAllUsersWithProfiles() {
    // 1. Get all departments first to create a lookup map.
    const { data: departments, error: deptError } = await this.supabase.from('departments').select('*');
    if (deptError) {
      // Propagate the error in the expected format.
      return { data: null, error: deptError };
    }
    const departmentsMap = new Map((departments || []).map(d => [d.id, d]));

    // 2. Get all active profiles.
    const { data: profiles, error: profileError } = await this.supabase.from('profiles').select('*').eq('status', 'active');
    if (profileError) {
      return { data: null, error: profileError };
    }
    if (!profiles) {
      return { data: [], error: null };
    }

    // 3. Manually "join" the department data to each profile.
    const profilesWithDepartments = profiles.map(p => ({
      ...p,
      departments: p.department_id ? departmentsMap.get(p.department_id) || null : null
    }));

    // 4. Return the combined data in the expected Supabase response format.
    return { data: profilesWithDepartments, error: null };
  }
  
  updateUserProfile(userId: string, profileData: Partial<Profile>) {
    return this.supabase.from('profiles').update(profileData).eq('id', userId);
  }

  async createNewUser(payload: NewUserPayload) {
    // 1. Create the user
    const { data: authData, error: authError } = await this.supabase.auth.signUp({
      email: payload.email,
      password: payload.password!,
    });
    if (authError) throw authError;
    if (!authData.user) throw new Error('User creation failed.');
    
    const user = authData.user;
    
    // 2. Upload avatar if it exists
    let avatarUrl: string | null = null;
    if (payload.imageFile) {
      const filePath = `avatars/${user.id}/${payload.imageFile.name}`;
      const { error: uploadError } = await this.supabase.storage
        .from('avatars')
        .upload(filePath, payload.imageFile);
      if (uploadError) console.error('Error uploading avatar:', uploadError);
      
      const { data: urlData } = this.supabase.storage.from('avatars').getPublicUrl(filePath);
      avatarUrl = urlData.publicUrl;
    }

    // 3. Create the profile
    const profileToInsert = {
      ...payload.profileData,
      id: user.id,
      email: user.email,
      avatar_url: avatarUrl,
    };
    
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .insert(profileToInsert)
      .select()
      .single();
    if (profileError) {
      console.error('Error creating profile, user was created but profile failed:', profileError);
      throw profileError;
    }
    
    const qrData = JSON.stringify({ userId: user.id, email: user.email });

    return { user, profile, qrData };
  }


  // --- DTR (Daily Time Record) ---

  async handleQrCodeLogin(userId: string) {
    // 1. Fetch user's profile
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (profileError) throw new Error('User not found.');
    if (profile.status !== 'active') throw new Error('User account is inactive.');

    // 2. Check for the last DTR entry for today
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

  // --- DEPARTMENTS ---

  getAllDepartments() {
    return this.supabase.from('departments').select('*');
  }

  createDepartment(department: Partial<Department>) {
    return this.supabase.from('departments').insert(department);
  }

  updateDepartment(id: number, department: Partial<Department>) {
    return this.supabase.from('departments').update(department).eq('id', id);
  }

  deleteDepartment(id: number) {
    return this.supabase.from('departments').delete().eq('id', id);
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
}