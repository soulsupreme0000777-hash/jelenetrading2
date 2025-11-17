import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, DtrEntry, Payroll, Profile, EmployeeSchedule, EmployeeStatus } from '../../services/supabase.service';
import { FormsModule } from '@angular/forms';
import { DatePipe, CurrencyPipe, CommonModule } from '@angular/common';

type EmployeeTab = 'profile' | 'dtr' | 'payroll' | 'schedule' | 'leave_status';

interface CalendarDay {
  date: Date;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  schedule?: string;
}

@Component({
  selector: 'app-employee-dashboard',
  templateUrl: './employee-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, CurrencyPipe, CommonModule]
})
export class EmployeeDashboardComponent {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  userProfile = this.supabaseService.currentUserProfile;
  userEmail = computed(() => this.userProfile()?.email || 'Employee');
  
  activeTab = signal<EmployeeTab>('profile');
  isSidebarOpen = signal(false);

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
  
  // Signals for Schedule
  scheduleLoading = signal(true);
  scheduleError = signal<string|null>(null);
  currentDate = signal(new Date());
  calendarDays = signal<CalendarDay[]>([]);

  // Signals for Leave & Status
  leaveHistory = signal<EmployeeStatus[]>([]);
  leaveLoading = signal(false);
  leaveError = signal<string|null>(null);

  dayOffBalance = computed(() => this.userProfile()?.day_off_balance ?? 0);
  silBalance = computed(() => this.userProfile()?.sil_balance ?? 0);

  isEligibleForSIL = computed(() => {
    const profile = this.userProfile();
    if (!profile || !profile.hire_date) return false;
    const hireDate = new Date(profile.hire_date);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    return hireDate <= oneYearAgo;
  });
  
  constructor() {
    this.loadDtrData();

    effect(() => {
      const currentTab = this.activeTab();
      if (currentTab === 'payroll' && this.payrolls().length === 0) {
        this.loadPayrolls();
      }
      if (currentTab === 'schedule') {
        this.generateCalendar();
      }
      if (currentTab === 'leave_status') {
        this.loadLeaveHistory();
      }
    });

    effect(() => {
      this.currentDate(); // Re-render calendar when month changes
      if (this.activeTab() === 'schedule') {
         this.generateCalendar();
      }
    });
  }
  
  setActiveTab(tab: EmployeeTab): void {
    this.activeTab.set(tab);
    this.isSidebarOpen.set(false);
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

  async loadLeaveHistory(): Promise<void> {
    this.leaveLoading.set(true);
    this.leaveError.set(null);
    try {
      const { data, error } = await this.supabaseService.getStatusesForCurrentUser();
      if (error) throw error;
      this.leaveHistory.set(data as EmployeeStatus[]);
    } catch(e: any) {
      this.leaveError.set(`Failed to load leave history: ${e.message}`);
    } finally {
      this.leaveLoading.set(false);
    }
  }

  async requestLeave(type: EmployeeStatus['status']) {
    this.leaveError.set(null);
    const profile = this.userProfile();
    if (!profile) return;
    
    // Check for existing leave today
    const todayStr = new Date().toISOString().slice(0, 10);
    if(this.leaveHistory().some(h => h.date === todayStr)) {
        this.leaveError.set("You have already requested leave for today.");
        return;
    }

    let newBalances: Partial<Profile> = {};

    switch (type) {
        case 'day_off':
        case 'emergency_leave':
            if (this.dayOffBalance() <= 0) {
                this.leaveError.set('You have no day-offs remaining.');
                return;
            }
            newBalances.day_off_balance = this.dayOffBalance() - 1;
            break;
        case 'service_incentive_leave':
            if (!this.isEligibleForSIL()) {
                this.leaveError.set('You are not yet eligible for Service Incentive Leave.');
                return;
            }
            if (this.silBalance() <= 0) {
                this.leaveError.set('You have no Service Incentive Leaves remaining.');
                return;
            }
            newBalances.sil_balance = this.silBalance() - 1;
            break;
    }

    try {
        await this.supabaseService.setEmployeeStatus(profile.id, type, newBalances);
        // Refresh profile to get updated balances
        await this.supabaseService.loadUserProfile(profile.id);
        // Refresh leave history
        this.loadLeaveHistory();
    } catch (e: any) {
        this.leaveError.set(e.message || 'An error occurred while setting status.');
    }
  }
  
  async generateCalendar(): Promise<void> {
    const user = this.userProfile();
    if (!user) return;
    
    this.scheduleLoading.set(true);
    this.scheduleError.set(null);

    const date = this.currentDate();
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    
    const startDate = new Date(firstDayOfMonth);
    startDate.setDate(startDate.getDate() - firstDayOfMonth.getDay());
    
    const endDate = new Date(lastDayOfMonth);
    endDate.setDate(endDate.getDate() + (6 - lastDayOfMonth.getDay()));

    // Fetch schedules for the visible date range
    let schedules: EmployeeSchedule[] = [];
    try {
      const { data, error } = await this.supabaseService.getSchedulesForDateRange(
        [user.id], 
        startDate.toISOString().slice(0,10), 
        endDate.toISOString().slice(0,10)
      );
      if (error) throw error;
      schedules = data || [];
    } catch(e: any) {
      this.scheduleError.set('Could not load schedule data.');
    }

    const scheduleMap = new Map<string, string>();
    schedules.forEach(s => {
      const start = s.work_start_time.slice(0, 5);
      const end = s.work_end_time.slice(0, 5);
      scheduleMap.set(s.date, `${start} - ${end}`);
    });

    const days: CalendarDay[] = [];
    let day = new Date(startDate);
    while (day <= endDate) {
      const dateStr = day.toISOString().slice(0,10);
      days.push({
        date: new Date(day),
        dayOfMonth: day.getDate(),
        isCurrentMonth: day.getMonth() === month,
        isToday: dateStr === new Date().toISOString().slice(0,10),
        schedule: scheduleMap.get(dateStr)
      });
      day.setDate(day.getDate() + 1);
    }
    
    this.calendarDays.set(days);
    this.scheduleLoading.set(false);
  }

  previousMonth(): void {
    this.currentDate.update(d => {
      const newDate = new Date(d);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
  }

  nextMonth(): void {
    this.currentDate.update(d => {
      const newDate = new Date(d);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
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
