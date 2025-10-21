import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, DtrEntry, Profile, Payroll } from '../../services/supabase.service';
import { FormsModule } from '@angular/forms';
import { DatePipe, CurrencyPipe } from '@angular/common';

type EmployeeTab = 'dtr' | 'profile' | 'payroll';

@Component({
  selector: 'app-employee-dashboard',
  templateUrl: './employee-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, CurrencyPipe]
})
export class EmployeeDashboardComponent {
  private readonly supabaseService = inject(SupabaseService);
  // FIX: Explicitly type `router` to `Router` to fix type inference issues.
  private readonly router: Router = inject(Router);

  user = this.supabaseService.currentUser;
  userEmail = computed(() => this.user()?.email || 'Employee');
  
  activeTab = signal<EmployeeTab>('dtr');

  // Signals for DTR
  dtrHistory = signal<DtrEntry[]>([]);
  dtrLoading = signal(true);
  dtrError = signal<string | null>(null);
  clockingInProgress = signal(false);
  openDtrEntry = signal<DtrEntry | null>(null);
  isClockedIn = computed(() => !!this.openDtrEntry());

  // Signals for Profile
  profile = signal<Profile | null>(null);
  profileLoading = signal(true);
  profileError = signal<string | null>(null);
  profileMessage = signal<{type: 'success' | 'error', text: string} | null>(null);
  profileUpdateInProgress = signal(false);
  
  // Writable signals for profile form
  firstName = signal('');
  lastName = signal('');

  // Signals for Payroll
  payrolls = signal<Payroll[]>([]);
  payrollsLoading = signal(true);
  payrollsError = signal<string | null>(null);
  logoutError = signal<string | null>(null);

  constructor() {
    this.loadDtrData();
    this.loadProfileData();

    effect(() => {
      // When profile data is loaded, populate the form signals
      if (this.profile()) {
        this.firstName.set(this.profile()?.first_name || '');
        this.lastName.set(this.profile()?.last_name || '');
      }
    });

    effect(() => {
      const currentTab = this.activeTab();
      if (currentTab === 'payroll' && this.payrolls().length === 0) {
        this.loadPayrolls();
      }
    });
  }
  
  setActiveTab(tab: EmployeeTab): void {
    this.activeTab.set(tab);
  }

  async loadDtrData(): Promise<void> {
    this.dtrLoading.set(true);
    this.dtrError.set(null);
    try {
      const { data: openEntry, error: openEntryError } = await this.supabaseService.getOpenDtrEntry();
      if (openEntryError && (openEntryError as any).code !== 'PGRST116') throw openEntryError; // Ignore "exact one row" error
      this.openDtrEntry.set(openEntry);

      const { data: history, error: historyError } = await this.supabaseService.getDtrHistoryForCurrentUser();
      if (historyError) throw historyError;
      this.dtrHistory.set(history as DtrEntry[]);

    } catch (e: any) {
      this.dtrError.set(`Failed to load time data: ${e.message}`);
    } finally {
      this.dtrLoading.set(false);
    }
  }

  async loadProfileData(): Promise<void> {
    this.profileLoading.set(true);
    this.profileError.set(null);
    try {
      const { data, error } = await this.supabaseService.getProfileForCurrentUser();
      if (error) throw error;
      this.profile.set(data as Profile);
    } catch (e: any) {
      this.profileError.set(`Failed to load profile: ${e.message}`);
    } finally {
      this.profileLoading.set(false);
    }
  }

  async loadPayrolls(): Promise<void> {
    this.payrollsLoading.set(true);
    this.payrollsError.set(null);
    try {
      const { data, error } = await this.supabaseService.getPayrollsForCurrentUser();
      if (error) throw error;
      this.payrolls.set(data as Payroll[]);
    } catch(e: any) {
      this.payrollsError.set(`Failed to load payrolls: ${e.message}`);
    } finally {
      this.payrollsLoading.set(false);
    }
  }

  async onUpdateProfile(): Promise<void> {
    this.profileUpdateInProgress.set(true);
    this.profileMessage.set(null);
    try {
      const { data, error } = await this.supabaseService.updateProfileForCurrentUser({
        first_name: this.firstName(),
        last_name: this.lastName()
      });
      if (error) {
        console.error('Error updating current user profile:', error);
        throw new Error(error.message);
      }
      this.profile.set(data as Profile); // Update local state with returned data
      this.profileMessage.set({ type: 'success', text: 'Profile updated successfully!' });
    } catch (e: any) {
      this.profileMessage.set({ type: 'error', text: `Failed to update profile: ${e.message}` });
    } finally {
      this.profileUpdateInProgress.set(false);
    }
  }

  async toggleClock(): Promise<void> {
    this.clockingInProgress.set(true);
    this.dtrError.set(null);

    try {
      if (this.isClockedIn()) {
        const entryToClose = this.openDtrEntry();
        if (entryToClose?.id) {
          await this.supabaseService.clockOut(entryToClose.id);
          this.openDtrEntry.set(null);
        }
      } else {
        const { data } = await this.supabaseService.clockIn();
        this.openDtrEntry.set(data as DtrEntry);
      }
      await this.loadDtrData();
    } catch (e: any) {
       this.dtrError.set(`An error occurred: ${e.message}`);
    } finally {
      this.clockingInProgress.set(false);
    }
  }

  async onLogout(): Promise<void> {
    this.logoutError.set(null);
    try {
      const { error } = await this.supabaseService.signOut();
      if (error) throw error;
      this.router.navigate(['/login']);
    } catch (e: any) {
      this.logoutError.set(`Failed to log out: ${e.message}`);
    }
  }
}