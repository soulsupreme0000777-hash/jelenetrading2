


import { Injectable, signal, inject, computed } from '@angular/core';
import { Router } from '@angular/router';
import {
  createClient,
  SupabaseClient,
  User,
  AuthError,
  PostgrestError,
  Session,
} from '@supabase/supabase-js';
import { environment } from '../environments/environment';

export interface NewUserPayload {
  email: string;
  password: string;
  imageFile: File | null;
  profileData: {
    first_name: string | null;
    last_name: string | null;
    age: number | null;
    mobile_number: string | null;
    position: string | null;
    hourly_rate: number | null;
    role: 'superadmin' | 'admin' | 'employee' | null;
  };
}

export interface UserWithProfile extends User {
  profile: Profile;
}

export interface Profile {
  id: string; // Foreign key to auth.users.id
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  hourly_rate: number | null;
  avatar_url: string | null;
  age: number | null;
  mobile_number: string | null;
  role: 'superadmin' | 'admin' | 'employee' | null;
  email: string | null; // The user's email, synced from auth.users
  status: 'active' | 'inactive';
}

export interface DtrEntry {
  id: number;
  user_id: string;
  time_in: string; // ISO 8601 timestamp
  time_out: string | null; // ISO 8601 timestamp
  profiles?: Profile; // for joins
}

export interface Payroll {
  id: number;
  user_id: string;
  pay_period_start: string;
  pay_period_end: string;
  total_hours: number;
  gross_pay: number;
  deductions: number;
  net_pay: number;
  status: 'pending' | 'processing' | 'paid';
  profiles?: Profile; // for joins
}

export interface Department {
  id: number;
  name: string;
  default_hourly_rate: number;
  work_start_time: string; // 'HH:mm' format
  work_end_time: string; // 'HH:mm' format
  lateness_deduction_per_minute: number;
  grace_period_minutes: number;
}

export interface PayrollPreviewItem {
  user_id: string;
  profile: Profile;
  total_hours: number;
  gross_pay: number;
  auto_lateness_deductions: number; 
  deductions: number; // Final deductions, can be manually edited
  net_pay: number;
}

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;
  private readonly router: Router = inject(Router);

  currentUser = signal<User | null | undefined>(undefined);
  currentUserProfile = signal<Profile | null | undefined>(undefined);
  currentUserRole = computed<'superadmin' | 'admin' | 'employee' | null>(() => this.currentUserProfile()?.role ?? null);
  profileError = signal<string | null>(null);
  isInitialized = signal(false);

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseKey);

    this.supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      this.currentUser.set(user);

      if (user) {
        // Fetch profile without blocking auth flow. 
        // The UI will reactively update when the profile is ready.
        this.fetchUserProfile(user.id);
      } else {
        this.currentUserProfile.set(null);
      }

      if (event === 'SIGNED_OUT') {
        this.router.navigate(['/login']);
      }
      
      // Mark service as initialized to unblock auth guards and startup logic.
      if (!this.isInitialized()) {
        this.isInitialized.set(true);
      }
    });
  }
  
  private async fetchUserProfile(userId: string): Promise<void> {
    this.profileError.set(null);
    try {
      const { data, error, status } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      
      if (error && status !== 406) throw error;
      
      this.currentUserProfile.set(data as Profile);
    } catch (error: any) {
      this.profileError.set(error.message);
      this.currentUserProfile.set(null);
    }
  }
  
  async getProfileForCurrentUser(): Promise<{ data: Profile | null, error: PostgrestError | null }> {
    const user = this.currentUser();
    if (!user) throw new Error('User not authenticated.');
    return this.supabase.from('profiles').select('*').eq('id', user.id).single();
  }

  async updateProfileForCurrentUser(profileData: Partial<Profile>): Promise<{ data: Profile | null, error: PostgrestError | null }> {
    const user = this.currentUser();
    if (!user) throw new Error('User not authenticated.');
    
    const { data, error } = await this.supabase
      .from('profiles')
      .update(profileData)
      .eq('id', user.id)
      .select()
      .single();
      
    if (data) {
        this.currentUserProfile.set(data);
    }
    
    return { data, error };
  }

  signInWithPassword(credentials: { email: string, password: string }): Promise<{ data: { user: User | null, session: Session | null }, error: AuthError | null }> {
    return this.supabase.auth.signInWithPassword(credentials);
  }

  signOut(): Promise<{ error: AuthError | null }> {
    return this.supabase.auth.signOut();
  }

  async getOpenDtrEntry(): Promise<{ data: DtrEntry | null, error: PostgrestError | null }> {
    const user = this.currentUser();
    if (!user) throw new Error('User not authenticated.');
    
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', user.id)
      .is('time_out', null)
      .maybeSingle();
  }

  async getDtrHistoryForCurrentUser(): Promise<{ data: DtrEntry[] | null, error: PostgrestError | null }> {
    const user = this.currentUser();
    if (!user) throw new Error('User not authenticated.');
    
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', user.id)
      .order('time_in', { ascending: false });
  }

  async clockIn(): Promise<{ data: DtrEntry | null, error: PostgrestError | null }> {
    const user = this.currentUser();
    if (!user) throw new Error('User not authenticated.');

    return this.supabase
      .from('dtr_entries')
      .insert({ user_id: user.id, time_in: new Date().toISOString() })
      .select()
      .single();
  }

  async clockOut(entryId: number): Promise<{ data: DtrEntry | null, error: PostgrestError | null }> {
    return this.supabase
      .from('dtr_entries')
      .update({ time_out: new Date().toISOString() })
      .eq('id', entryId)
      .select()
      .single();
  }

  async getPayrollsForCurrentUser(): Promise<{ data: Payroll[] | null, error: PostgrestError | null }> {
      const user = this.currentUser();
      if (!user) throw new Error('User not authenticated.');
      
      return this.supabase
        .from('payrolls')
        .select('*')
        .eq('user_id', user.id)
        .order('pay_period_end', { ascending: false });
  }
  
  async getAllDepartments(): Promise<{ data: Department[] | null, error: PostgrestError | null }> {
      return this.supabase.from('departments').select('*').order('name');
  }

  async getAllUsersWithProfiles(): Promise<{ data: Profile[] | null, error: PostgrestError | null }> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('status', 'active') // Only fetch active users
      .order('last_name', { ascending: true });

    if (error) {
      console.error('Error fetching users with profiles:', error);
      const detailedMessage = `Failed to fetch employee data. Check your RLS policies on the 'profiles' table. Original error: ${error.message}`;
      const readableError = { ...error, message: detailedMessage };
      return { data: null, error: readableError as any };
    }
    
    return { data, error };
  }
  
  async getAllDtrEntries(): Promise<{ data: (DtrEntry & { profiles: Profile })[] | null, error: PostgrestError | null }> {
    const { data, error } = await this.supabase
      .from('dtr_entries')
      .select('*, profiles(*)')
      .order('time_in', { ascending: false });

    return { data: data as any, error };
  }
  
  async getAllPayrolls(): Promise<{ data: (Payroll & { profiles: Profile })[] | null, error: PostgrestError | null }> {
    const { data, error } = await this.supabase
      .from('payrolls')
      .select('*, profiles(*)')
      .order('pay_period_end', { ascending: false });

    return { data: data as any, error };
  }

  async createNewUser(payload: NewUserPayload): Promise<{ user: User, profile: Profile, qrData: string }> {
    // This function performs all actions as the currently authenticated admin.
    // It relies on RLS policies that allow admins to create profiles and upload avatars.

    // Preserve admin session, as signUp temporarily changes the auth state.
    const { data: { session: adminSession } } = await this.supabase.auth.getSession();
    if (!adminSession) {
      throw new Error("Admin not authenticated. Cannot create user.");
    }

    const { data: authData, error: authError } = await this.supabase.auth.signUp({
      email: payload.email,
      password: payload.password,
    });

    if (authError) throw new Error(`Failed to create user account: ${authError.message}`);
    if (!authData.user) throw new Error('User creation failed: The user account was not created in Supabase Auth.');

    const user = authData.user;

    // Immediately restore the admin session.
    const { error: restoreError } = await this.supabase.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
    });
    if (restoreError) {
        this.router.navigate(['/login']); // Force re-login for safety
        throw new Error("Critical error: User auth record was created, but admin session could not be restored. Please log in again.");
    }

    // With admin privileges restored, create the user's profile and avatar.
    let avatar_url: string | null = null;
    try {
      if (payload.imageFile) {
        const filePath = `${user.id}/${Date.now()}_${payload.imageFile.name}`;
        const { error: uploadError } = await this.supabase.storage
          .from('avatars')
          .upload(filePath, payload.imageFile);

        if (uploadError) {
          throw new Error(`Avatar upload failed: ${uploadError.message}. (Hint: Check Storage RLS policies for admins.)`);
        }
        
        const { data: urlData } = this.supabase.storage.from('avatars').getPublicUrl(filePath);
        avatar_url = urlData.publicUrl;
      }

      // This assumes a DB trigger has already created a basic profile row upon user signup.
      const { profileData } = payload;
      const profileToUpdate = {
        email: user.email,
        avatar_url,
        first_name: profileData.first_name,
        last_name: profileData.last_name,
        age: profileData.age,
        mobile_number: profileData.mobile_number,
        position: profileData.position,
        hourly_rate: profileData.hourly_rate,
        role: profileData.role,
        status: 'active' as const,
      };

      const { data: updatedProfile, error: profileError } = await this.supabase
        .from('profiles')
        .update(profileToUpdate)
        .eq('id', user.id)
        .select()
        .single();

      if (profileError) {
        throw new Error(`Profile update failed: ${profileError.message}. (Hint: Check RLS 'update' policies on the 'profiles' table for admins.)`);
      }
      
      if (!updatedProfile) {
        throw new Error('Profile data was not returned after update. A database trigger to auto-create a profile for new users might be missing.');
      }

      const qrData = JSON.stringify({ userId: user.id, email: user.email });
      
      return { user, profile: updatedProfile, qrData };

    } catch (error) {
        console.error("Error during post-signup processing:", error);
        throw error;
    }
  }

  async createDepartment(departmentData: Omit<Department, 'id'>): Promise<{ data: Department | null, error: PostgrestError | null }> {
    return this.supabase
      .from('departments')
      .insert(departmentData)
      .select()
      .single();
  }
  
  async updateDepartment(id: number, departmentData: Partial<Omit<Department, 'id'>>): Promise<{ data: Department | null, error: PostgrestError | null }> {
    return this.supabase
      .from('departments')
      .update(departmentData)
      .eq('id', id)
      .select()
      .single();
  }

  async deleteDepartment(id: number): Promise<{ error: PostgrestError | null }> {
    return this.supabase.from('departments').delete().eq('id', id);
  }

  async updateUserProfile(userId: string, profileData: Partial<Profile>): Promise<{ data: Profile | null, error: PostgrestError | null }> {
    const { data, error } = await this.supabase
      .from('profiles')
      .update(profileData)
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) {
      return { data: null, error };
    }
    
    if (!data) {
      // This handles the "zero rows found" case from .maybeSingle().
      const notFoundError: PostgrestError = {
        name: 'PostgrestError',
        message: 'Update successful, but failed to retrieve the updated profile. RLS policies may be preventing access.',
        details: `No profile found for user ID ${userId} after update.`,
        hint: 'Check that your RLS SELECT policy allows admins to view the profiles they have just updated.',
        code: 'PGRST116' // Not found
      };
      return { data: null, error: notFoundError };
    }
    
    return { data, error: null };
  }

  async getAllOpenDtrEntries(): Promise<{ data: DtrEntry[] | null, error: PostgrestError | null }> {
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .is('time_out', null);
  }

  async getDtrEntriesForPeriod(startDate: string, endDate: string): Promise<{ data: (DtrEntry & { profiles: Profile })[] | null, error: PostgrestError | null }> {
    const { data, error } = await this.supabase
      .from('dtr_entries')
      .select('*, profiles(*)')
      .gte('time_in', startDate)
      .lte('time_out', endDate)
      .not('time_out', 'is', null);
  
    return { data: data as any, error };
  }

  async finalizePayrolls(payrollsToCreate: Omit<Payroll, 'id' | 'profiles'>[]): Promise<{ data: Payroll[] | null, error: PostgrestError | null }> {
    return this.supabase
      .from('payrolls')
      .insert(payrollsToCreate)
      .select();
  }

  async handleQrCodeLogin(userId: string): Promise<{ profile: Profile, dtrEntry: DtrEntry }> {
    // This securely calls a database function (RPC) to handle the logic.
    // The 'handle_qr_scan' function must be created in your Supabase SQL Editor.
    const { data, error } = await this.supabase.rpc('handle_qr_scan', {
      user_id_input: userId
    });

    if (error) {
      // Make the error from the RPC function more user-friendly.
      if (error.message.includes('User profile not found')) {
        throw new Error('User profile not found. The QR code may be invalid or the employee may no longer be active.');
      }
      throw new Error(`An error occurred during QR scan: ${error.message}`);
    }

    if (!data || !data.profile || !data.dtrEntry) {
        throw new Error('Received an invalid response from the server after QR scan.');
    }
    
    return data;
  }
  
  async deleteDtrEntry(id: number): Promise<{ error: PostgrestError | null }> {
    return this.supabase.from('dtr_entries').delete().eq('id', id);
  }
}