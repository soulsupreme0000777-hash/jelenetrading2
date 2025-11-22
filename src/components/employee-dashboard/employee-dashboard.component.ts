import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, DtrEntry, Payroll, Profile, EmployeeSchedule, EmployeeStatus } from '../../services/supabase.service';
import { FormsModule } from '@angular/forms';
import { DatePipe, CurrencyPipe, CommonModule } from '@angular/common';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';

type EmployeeTab = 'profile' | 'dtr' | 'payroll' | 'schedule';

interface CalendarDay {
  date: Date;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  schedule?: string;
  leaveType?: 'day_off' | 'service_incentive_leave' | 'emergency_leave';
  dateStr: string;
}

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
}

@Component({
  selector: 'app-employee-dashboard',
  templateUrl: './employee-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, CurrencyPipe, CommonModule, ConfirmationModalComponent]
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
  
  // Signals for Schedule & Leave
  scheduleLoading = signal(true);
  scheduleError = signal<string|null>(null);
  currentDate = signal(new Date());
  calendarDays = signal<CalendarDay[]>([]);
  leaveRequestMode = signal<'day_off' | 'sil' | null>(null);
  leaveRequestMessage = signal<string | null>(null);
  selectedLeaveDates = signal<Set<string>>(new Set());

  // Signals for Leave & Status
  leaveHistory = signal<EmployeeStatus[]>([]);
  leaveLoading = signal(false);

  // Confirmation Modal
  isConfirmModalVisible = signal(false);
  confirmModalConfig = signal<ConfirmModalConfig>({ title: '', message: '', onConfirm: () => {} });

  // Signals for Today's Pay
  todaysPotentialEarnings = signal<number | null>(null);
  todaysStatus = signal<'clocked-in' | 'clocked-out' | 'absent' | null>(null);

  dayOffBalance = computed(() => this.userProfile()?.day_off_balance ?? 0);
  silBalance = computed(() => this.userProfile()?.sil_balance ?? 0);

  private silCheckComplete = signal(false);

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
      // This single effect handles all calendar generation logic.
      // It runs when the schedule tab is active and automatically re-runs if its
      // dependencies (like the current month/year or user profile) change.
      // This was the source of the blinking when the profile was updated in a loop.
      if (this.activeTab() === 'schedule') {
        this.generateCalendar();
      }
    });

    effect(() => {
        const profile = this.userProfile();
        // This check for SIL eligibility was causing an infinite loop because
        // checkAndGrantSIL updates the profile, which re-triggered this effect.
        // By adding the silCheckComplete signal, we ensure this logic runs only ONCE
        // when the profile is first loaded, breaking the loop and stopping the blinking.
        if (profile && !this.silCheckComplete()) {
            this.silCheckComplete.set(true);
            this.checkAndGrantSIL(profile);
        }
    });
  }
  
  private async checkAndGrantSIL(profile: Profile): Promise<void> {
    if (!profile.hire_date) return;

    const hireDate = new Date(profile.hire_date);
    const today = new Date();

    const oneYearAfterHire = new Date(hireDate.getFullYear() + 1, hireDate.getMonth(), hireDate.getDate());
    if (today < oneYearAfterHire) {
        return; // Not yet eligible for the first time
    }
    
    // Determine the most recent anniversary date for the current service year
    let lastAnniversary = new Date(today.getFullYear(), hireDate.getMonth(), hireDate.getDate());
    if (today < lastAnniversary) {
        // If today is before this year's anniversary, the service year started last year
        lastAnniversary.setFullYear(lastAnniversary.getFullYear() - 1);
    }

    const nextAnniversary = new Date(lastAnniversary.getFullYear() + 1, lastAnniversary.getMonth(), lastAnniversary.getDate());

    const { data: silLeaves, error } = await this.supabaseService.getStatusesForDateRange(
        profile.id,
        lastAnniversary.toISOString().slice(0, 10),
        new Date(nextAnniversary.getTime() - 86400000).toISOString().slice(0, 10) // Day before next anniversary
    );

    if (error) {
        console.error("Failed to check for recent SIL leaves", error);
        return;
    }

    const hasUsedSILThisYear = silLeaves?.some(leave => leave.status === 'service_incentive_leave');

    // If SIL has NOT been used in the current service year and balance is not 5, grant it.
    if (!hasUsedSILThisYear && profile.sil_balance !== 5) {
        const { error: updateError } = await this.supabaseService.updateUserProfile(profile.id, { sil_balance: 5 });
        if (updateError) {
            console.error("Failed to grant SIL:", updateError.message);
        } else {
            await this.supabaseService.loadUserProfile(profile.id); // Refresh profile state
        }
    }
  }

  setActiveTab(tab: EmployeeTab): void {
    if (tab === 'payroll' && this.payrolls().length === 0) {
      this.loadPayrolls();
    }
    this.activeTab.set(tab);
    this.isSidebarOpen.set(false);
    this.leaveRequestMode.set(null); // Exit leave planning mode when changing tabs
  }

  async loadDtrData(): Promise<void> {
    this.dtrLoading.set(true);
    this.dtrError.set(null);
    try {
      const { data: history, error: historyError } = await this.supabaseService.getDtrHistoryForCurrentUser();
      if (historyError) throw historyError;
      this.dtrHistory.set(history as DtrEntry[]);

      // New logic for today's pay visibility
      const todayStr = new Date().toISOString().slice(0, 10);
      const todaysEntries = (history || []).filter(e => e.created_at.startsWith(todayStr));
      
      if (todaysEntries.length > 0) {
        this.todaysPotentialEarnings.set(this.userProfile()?.daily_rate ?? null);
        
        // Determine status by sorting to find the latest entry
        todaysEntries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const lastEntry = todaysEntries[0];
        if (lastEntry.time_out) {
            this.todaysStatus.set('clocked-out');
        } else {
            this.todaysStatus.set('clocked-in');
        }
      } else {
        this.todaysPotentialEarnings.set(null);
        this.todaysStatus.set('absent');
      }

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

  startLeaveRequest(mode: 'day_off' | 'sil'): void {
    this.leaveRequestMode.set(mode);
    this.selectedLeaveDates.set(new Set());
    if (mode === 'day_off') {
        this.leaveRequestMessage.set('Please select up to 3 available days on the calendar for your day off.');
    } else {
        this.leaveRequestMessage.set('Please select the START date for your 5-day Service Incentive Leave.');
    }
  }

  cancelLeaveRequest(): void {
    this.leaveRequestMode.set(null);
    this.leaveRequestMessage.set(null);
    this.selectedLeaveDates.set(new Set());
  }

  async handleDayClick(day: CalendarDay): Promise<void> {
    const mode = this.leaveRequestMode();
    if (!mode) return;

    const profile = this.userProfile();
    if (!profile) return;

    if (day.date < new Date(new Date().toDateString())) {
        this.leaveRequestMessage.set("You cannot schedule leave for a past date.");
        return;
    }
    if (day.leaveType || day.schedule === 'Rest Day' || !day.schedule) {
        this.leaveRequestMessage.set("This day is unavailable for leave.");
        return;
    }

    if (mode === 'day_off') {
      this.selectedLeaveDates.update(currentSelection => {
          const newSelection = new Set(currentSelection);
          if (newSelection.has(day.dateStr)) {
              newSelection.delete(day.dateStr);
          } else {
              const dayOffsThisMonth = this.calendarDays().filter(d => d.isCurrentMonth && d.leaveType === 'day_off').length;
              const pendingDayOffs = newSelection.size;
              
              if (dayOffsThisMonth + pendingDayOffs >= 3) {
                  this.leaveRequestMessage.set("You can only schedule up to 3 day-offs per month.");
                  return currentSelection;
              }
              if (this.dayOffBalance() - pendingDayOffs <= 0) {
                  this.leaveRequestMessage.set("You do not have enough day-off balance for this selection.");
                   return currentSelection;
              }

              newSelection.add(day.dateStr);
          }
          return newSelection;
      });
    }

    if (mode === 'sil') {
        if (!this.isEligibleForSIL()) {
            this.leaveRequestMessage.set("You are not yet eligible for Service Incentive Leave.");
            return;
        }
        if (this.silBalance() <= 0) {
            this.leaveRequestMessage.set("You have already used your Service Incentive Leave for this year.");
            return;
        }

        const leaveDates: string[] = [];
        for (let i = 0; i < 5; i++) {
            const nextDay = new Date(day.date);
            nextDay.setDate(nextDay.getDate() + i);
            leaveDates.push(nextDay.toISOString().slice(0, 10));
        }

        const endDate = new Date(leaveDates[4]);
        this.confirmModalConfig.set({
            title: "Confirm 5-Day SIL",
            message: `This will schedule a 5-day leave from ${day.date.toLocaleDateString()} to ${endDate.toLocaleDateString()}. This is a one-time action for the year and cannot be undone. Proceed?`,
            onConfirm: () => this.submitLeaveRequest('service_incentive_leave', leaveDates)
        });
        this.isConfirmModalVisible.set(true);
    }
  }

  openDayOffConfirmation(): void {
    if (this.selectedLeaveDates().size === 0) {
        this.leaveRequestMessage.set("Please select at least one day.");
        return;
    }
    // FIX: Replaced Array.from() with the spread operator (...) to ensure correct
    // type inference from Set<string> to string[], resolving a potential compiler issue.
    const dates: string[] = [...this.selectedLeaveDates()].sort();
    const formattedDates = dates.map(d => new Date(d + 'T00:00:00').toLocaleDateString()).join(', ');
    
    this.confirmModalConfig.set({
        title: `Confirm ${dates.length} Day Off(s)`,
        message: `Are you sure you want to request day-offs for the following dates: ${formattedDates}? This action cannot be undone.`,
        onConfirm: () => this.submitLeaveRequest('day_off', dates)
    });
    this.isConfirmModalVisible.set(true);
  }

  openEmergencyLeaveConfirmation(): void {
    const new_message = this.dayOffBalance() > 0 
        ? `This will use one of your ${this.dayOffBalance()} available Day Off balance(s).`
        : `You have no Day Off balance remaining. This will be deducted from future leave credits.`;

    this.confirmModalConfig.set({
        title: 'Confirm Emergency Leave',
        message: `Are you sure you want to take an emergency leave for today, ${new Date().toLocaleDateString()}? ${new_message} This action cannot be undone.`,
        onConfirm: () => this.submitLeaveRequest('emergency_leave', [new Date().toISOString().slice(0, 10)])
    });
    this.isConfirmModalVisible.set(true);
  }

  async submitLeaveRequest(type: EmployeeStatus['status'], dates: string[]): Promise<void> {
    const profile = this.userProfile();
    if (!profile) return;
    
    let balanceUpdates: Partial<Profile> = {};
    if (type === 'day_off' || type === 'emergency_leave') {
        balanceUpdates.day_off_balance = this.dayOffBalance() - dates.length;
    } else if (type === 'service_incentive_leave') {
        balanceUpdates.sil_balance = 0; // It's a block of 5
    }

    try {
      const leaveRequests = dates.map(date => ({ date, status: type }));
      await this.supabaseService.requestLeaveAndUpdateBalance(profile.id, leaveRequests, balanceUpdates);
      
      // Refresh profile to get updated balances
      await this.supabaseService.loadUserProfile(profile.id);
      
      // Refresh calendar - The effect will handle this automatically
      // this.generateCalendar();

    } catch(e: any) {
      this.scheduleError.set(e.message || "An error occurred while submitting your leave request.");
    } finally {
        this.isConfirmModalVisible.set(false);
        this.cancelLeaveRequest();
    }
  }
  
  async generateCalendar(): Promise<void> {
    const user = this.userProfile();
    const date = this.currentDate();
    if (!user) return;
    
    this.scheduleLoading.set(true);
    this.scheduleError.set(null);

    const year = date.getFullYear();
    const month = date.getMonth();

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    
    const startDate = new Date(firstDayOfMonth);
    startDate.setDate(startDate.getDate() - firstDayOfMonth.getDay());
    
    const endDate = new Date(lastDayOfMonth);
    endDate.setDate(endDate.getDate() + (6 - lastDayOfMonth.getDay()));

    let schedules: EmployeeSchedule[] = [];
    let statuses: EmployeeStatus[] = [];
    try {
      const [scheduleRes, statusRes] = await Promise.all([
        this.supabaseService.getSchedulesForDateRange([user.id], startDate.toISOString().slice(0,10), endDate.toISOString().slice(0,10)),
        this.supabaseService.getStatusesForDateRange(user.id, startDate.toISOString().slice(0,10), endDate.toISOString().slice(0,10))
      ]);
      
      if (scheduleRes.error) throw scheduleRes.error;
      schedules = scheduleRes.data || [];
      
      if (statusRes.error) throw statusRes.error;
      statuses = statusRes.data || [];

    } catch(e: any) {
      this.scheduleError.set('Could not load schedule data.');
    }

    const scheduleMap = new Map<string, string>();
    schedules.forEach(s => {
      const start = s.work_start_time.slice(0, 5);
      const end = s.work_end_time.slice(0, 5);
      scheduleMap.set(s.date, `${start} - ${end}`);
    });
    
    const statusMap = new Map<string, EmployeeStatus['status']>();
    statuses.forEach(s => statusMap.set(s.date, s.status));

    const days: CalendarDay[] = [];
    let day = new Date(startDate);
    const todayStr = new Date().toISOString().slice(0,10);
    while (day <= endDate) {
      const dateStr = day.toISOString().slice(0,10);
      days.push({
        date: new Date(day),
        dayOfMonth: day.getDate(),
        isCurrentMonth: day.getMonth() === month,
        isToday: dateStr === todayStr,
        schedule: scheduleMap.get(dateStr),
        leaveType: statusMap.get(dateStr),
        dateStr
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
      if (error && error.message !== 'Auth session missing!') {
        throw error;
      }
      this.router.navigate(['/login']);
    } catch (e: any) {
      this.logoutError.set(`Failed to log out: ${e.message}`);
    }
  }
}
