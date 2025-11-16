import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, DtrEntry, Payroll, Profile } from '../../services/supabase.service';
import { FormsModule } from '@angular/forms';
import { DatePipe, CurrencyPipe } from '@angular/common';

type EmployeeTab = 'profile' | 'dtr' | 'payroll' | 'analytics';

interface AnalyticsReport {
  onTimeCount: number;
  lateCount: number;
  earlyLeaveCount: number;
  totalMonthlySalary: number;
  monthName: string;
}

@Component({
  selector: 'app-employee-dashboard',
  templateUrl: './employee-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, CurrencyPipe]
})
export class EmployeeDashboardComponent {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  userProfile = this.supabaseService.currentUserProfile;
  userEmail = computed(() => this.userProfile()?.email || 'Employee');
  
  activeTab = signal<EmployeeTab>('profile');

  // Signals for DTR
  dtrHistory = signal<DtrEntry[]>([]);
  dtrLoading = signal(true);
  dtrError = signal<string | null>(null);
  
  // Signals for Payroll
  payrolls = signal<Payroll[]>([]);
  payrollsLoading = signal(true);
  payrollsError = signal<string | null>(null);
  logoutError = signal<string | null>(null);
  expandedPayrollId = signal<number | null>(null);
  
  // Signals for Analytics
  analyticsReport = signal<AnalyticsReport | null>(null);
  analyticsLoading = signal(false);

  constructor() {
    this.loadDtrData();

    effect(() => {
      const currentTab = this.activeTab();
      if (currentTab === 'payroll' && this.payrolls().length === 0) {
        this.loadPayrolls();
      }
      if (currentTab === 'analytics' && !this.analyticsReport()) {
        this.calculateAnalytics();
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
      const { data: history, error: historyError } = await this.supabaseService.getDtrHistoryForCurrentUser();
      if (historyError) throw historyError;
      this.dtrHistory.set(history as DtrEntry[]);

    } catch (e: any) {
      this.dtrError.set(`Failed to load time data: ${e.message}`);
    } finally {
      this.dtrLoading.set(false);
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
  
  calculateAnalytics(): void {
    this.analyticsLoading.set(true);

    const profile = this.userProfile();
    const dtrHistory = this.dtrHistory();

    if (!profile || !profile.departments || !profile.daily_rate) {
        this.analyticsLoading.set(false);
        // Set report to null to show an error message in the template
        this.analyticsReport.set(null);
        return;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });

    const currentMonthDtr = dtrHistory.filter(entry => {
        const entryDate = new Date(entry.time_in!);
        return entryDate.getFullYear() === year && entryDate.getMonth() === month;
    });

    let onTimeCount = 0;
    let lateCount = 0;
    let earlyLeaveCount = 0;

    const dtrByDay = currentMonthDtr.reduce<Record<string, DtrEntry[]>>((acc, dtr) => {
        if (dtr.time_in) {
            const day = dtr.time_in.substring(0, 10);
            if (!acc[day]) {
              acc[day] = [];
            }
            acc[day].push(dtr);
        }
        return acc;
    }, {});
    
    const department = profile.departments;
    
    Object.values(dtrByDay).forEach((dailyEntries: DtrEntry[]) => {
        dailyEntries.sort((a, b) => new Date(a.time_in!).getTime() - new Date(b.time_in!).getTime());
        const firstEntry = dailyEntries[0];
        const lastEntry = dailyEntries[dailyEntries.length - 1];

        // Lateness check
        if (department.work_start_time && firstEntry.time_in) {
            const timeIn = new Date(firstEntry.time_in);
            const [h, m, s] = department.work_start_time.split(':').map(Number);
            const expectedStart = new Date(timeIn);
            expectedStart.setHours(h, m, s, 0);
            const gracePeriodMs = (department.grace_period_minutes || 0) * 60 * 1000;
            if (timeIn.getTime() > expectedStart.getTime() + gracePeriodMs) {
                lateCount++;
            } else {
                onTimeCount++;
            }
        } else {
          onTimeCount++; // If no start time is defined, count as on-time
        }

        // Early leave check
        if (department.work_end_time && lastEntry.time_out) {
            const timeOut = new Date(lastEntry.time_out);
            const [h, m, s] = department.work_end_time.split(':').map(Number);
            const expectedEnd = new Date(timeOut);
            expectedEnd.setHours(h, m, s, 0);
            if (timeOut.getTime() < expectedEnd.getTime()) {
                earlyLeaveCount++;
            }
        }
    });

    const daysWorked = Object.keys(dtrByDay).length;
    const totalMonthlySalary = daysWorked * profile.daily_rate;

    this.analyticsReport.set({
        onTimeCount,
        lateCount,
        earlyLeaveCount,
        totalMonthlySalary,
        monthName
    });
    this.analyticsLoading.set(false);
  }

  togglePayrollDetails(payrollId: number): void {
    this.expandedPayrollId.update(currentId => 
      currentId === payrollId ? null : payrollId
    );
  }

  async onLogout(): Promise<void> {
    this.logoutError.set(null);
    try {
      const { error } = await this.supabaseService.signOut();
      // If there's an error, but it's "Auth session missing!", we can ignore it
      // because the user is effectively logged out.
      if (error && error.message !== 'Auth session missing!') {
        throw error;
      }
      // For successful sign out or "session missing" error, navigate to login.
      this.router.navigate(['/login']);
    } catch (e: any) {
      // Handles any other unexpected errors during sign out.
      this.logoutError.set(`Failed to log out: ${e.message}`);
    }
  }
}
