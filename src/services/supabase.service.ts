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

// --- Type Definitions ---

// FIX: Add NewUserPayload type for creating new users.
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

// FIX: Add UserWithProfile type.
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
  status: 'active' | 'inactive'; // NEW: For soft deletes
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
  // NEW: Fields for dynamic work hours and lateness deductions
  work_start_time: string; // 'HH:mm' format
  work_end_time: string; // 'HH:mm' format
  lateness_deduction_per_minute: number;
  grace_period_minutes: number;
}

// NEW: Type for the payroll calculation preview
export interface PayrollPreviewItem {
  user_id: string;
  profile: Profile;
  total_hours: number;
  gross_pay: number;
  // NEW: Calculated lateness deductions
  auto_lateness_deductions: number; 
  deductions: number; // Final deductions, can be manually edited
  net_pay: number;
}

// IMPORTANT: Replace with your own Supabase project details.
// You can get these from your Supabase project settings > API
const SUPABASE_URL = 'https://lzpinyrabienqvttrysp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6cGlueXJhYmllbnF2dHRyeXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA5MDc5NjYsImV4cCI6MjA3NjQ4Mzk2Nn0.j4V8ZvNJKxwrd6MRc2P1CigcKTS3ZB7Yxuh345lkusM';


@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private supabase: SupabaseClient;
  // FIX: Explicitly type `router` to `Router` to fix type inference issues.
  private readonly router: Router = inject(Router);

  // --- State Signals ---
  currentUser = signal<User | null | undefined>(undefined);
  currentUserProfile = signal<Profile | null | undefined>(undefined);
  // NEW: Centralized signal for the user's role
  currentUserRole = computed<'superadmin' | 'admin' | 'employee' | null>(() => this.currentUserProfile()?.role ?? null);
  profileError = signal<string | null>(null);
  isInitialized = signal(false);

  constructor() {
    // FIX: Removed check for placeholder Supabase credentials as they have been provided.
    // This check was causing a TypeScript error due to non-overlapping types.
    
    this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    this.supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      this.currentUser.set(user);

      if (user) {
        // Fire-and-forget the profile fetch. 
        // The rest of the app is reactive and will show a loading state until the profile is available.
        // This prevents a slow or hanging profile fetch from blocking the entire auth flow.
        this.fetchUserProfile(user.id);
      } else {
        this.currentUserProfile.set(null);
      }

      if (event === 'SIGNED_OUT') {
        this.router.navigate(['/login']);
      }
      
      // Mark the service as initialized immediately. This unblocks guards and other startup logic.
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
    // It relies on updated RLS policies that allow admins to create profiles and upload avatars for other users.

    // 1. Get the admin's current session to restore it after signUp changes the auth state.
    const { data: { session: adminSession } } = await this.supabase.auth.getSession();
    if (!adminSession) {
      throw new Error("Admin not authenticated. Cannot create user.");
    }

    // 2. Sign up the new user. This is expected to NOT return a session if email confirmation is on.
    // It will temporarily change the auth state of the client.
    const { data: authData, error: authError } = await this.supabase.auth.signUp({
      email: payload.email,
      password: payload.password,
    });

    if (authError) {
      throw new Error(`Failed to create user account: ${authError.message}`);
    }
    if (!authData.user) {
      throw new Error('User creation failed: The user account was not created in Supabase Auth.');
    }

    const user = authData.user;

    // 3. CRITICAL: Restore the admin session immediately.
    const { error: restoreError } = await this.supabase.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
    });
    if (restoreError) {
        this.router.navigate(['/login']); // Force re-login for safety
        throw new Error("Critical error: User auth record was created, but your admin session could not be restored. Please log in again.");
    }

    // 4. NOW, authenticated as an admin again, upload the avatar for the new user.
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

      // 5. As an admin, UPDATE the profile for the new user.
      // This assumes a database trigger has already created a basic profile row upon user signup.
      const { profileData } = payload;
      const profileToUpdate = {
        // NOTE: 'id' is used in .eq() and not in the update payload.
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
        throw new Error('Profile data was not returned after update. This usually means a database trigger to auto-create a profile for new users is missing.');
      }

      // 6. Prepare QR code data.
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
  
  // NEW: Update a department
  async updateDepartment(id: number, departmentData: Partial<Omit<Department, 'id'>>): Promise<{ data: Department | null, error: PostgrestError | null }> {
    return this.supabase
      .from('departments')
      .update(departmentData)
      .eq('id', id)
      .select()
      .single();
  }

  // NEW: Delete a department
  async deleteDepartment(id: number): Promise<{ error: PostgrestError | null }> {
    return this.supabase.from('departments').delete().eq('id', id);
  }

  // NEW: Update any user's profile (for admins)
  async updateUserProfile(userId: string, profileData: Partial<Profile>): Promise<{ data: Profile | null, error: PostgrestError | null }> {
     const { data, error } = await this.supabase
      .from('profiles')
      .update(profileData)
      .eq('id', userId)
      .select();

    if (error) {
      return { data: null, error };
    }
    if (!data || data.length === 0) {
      // Create a PostgrestError-like object for consistency if no row was found.
      const notFoundError: PostgrestError = {
        message: 'Cannot find the profile to update. RLS policies may be preventing access.',
        details: `No profile found for user ID ${userId}`,
        hint: 'Check if the row exists and if your RLS policies allow you to see it.',
        code: 'PGRST116' // Mimicking the original "not found" error code
      };
      return { data: null, error: notFoundError };
    }
    return { data: data[0], error: null };
  }


  async getProfileById(userId: string): Promise<{ data: Profile | null, error: PostgrestError | null }> {
    return this.supabase.from('profiles').select('*').eq('id', userId).single();
  }

  async getOpenDtrEntryForUser(userId: string): Promise<{ data: DtrEntry | null, error: PostgrestError | null }> {
    return this.supabase
      .from('dtr_entries')
      .select('*')
      .eq('user_id', userId)
      .is('time_out', null)
      .maybeSingle();
  }
  
  async clockInForUser(userId: string): Promise<{ data: DtrEntry | null, error: PostgrestError | null }> {
    return this.supabase
      .from('dtr_entries')
      .insert({ user_id: userId, time_in: new Date().toISOString() })
      .select()
      .single();
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
    // 1. Fetch profile to ensure the user exists
    const { data: profile, error: profileError } = await this.getProfileById(userId);
    if (profileError || !profile) {
      throw new Error('User profile not found.');
    }

    // 2. Check for an open DTR entry for that user
    const { data: openEntry, error: openEntryError } = await this.getOpenDtrEntryForUser(userId);
    // We can ignore the "PGRST116" error, which just means no row was found.
    // Any other error should be thrown.
    if (openEntryError && (openEntryError as any).code !== 'PGRST116') {
      throw openEntryError;
    }

    // 3. Decide whether to clock in or clock out
    if (openEntry) {
      // User is already clocked in, so clock them out
      const { data: closedEntry, error: clockOutError } = await this.clockOut(openEntry.id);
      if (clockOutError) throw clockOutError;
      return { profile, dtrEntry: closedEntry! };
    } else {
      // User is clocked out, so clock them in
      const { data: newEntry, error: clockInError } = await this.clockInForUser(userId);
      if (clockInError) throw clockInError;
      return { profile, dtrEntry: newEntry! };
    }
  }
}