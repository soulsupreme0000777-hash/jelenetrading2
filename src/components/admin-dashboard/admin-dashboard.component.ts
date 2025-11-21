import { Component, ChangeDetectionStrategy, inject, signal, effect, computed, OnDestroy, viewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry, Payroll, SalaryRule, EmployeeStatus, EmployeeSchedule } from '../../services/supabase.service';
import { AddEmployeeModalComponent } from '../add-employee-modal/add-employee-modal.component';
import { RunPayrollModalComponent } from '../run-payroll-modal/run-payroll-modal.component';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { ViewEmployeeModalComponent } from '../view-employee-modal/view-employee-modal.component';
import { IdCardModalComponent } from '../id-card-modal/id-card-modal.component';
import { SetScheduleModalComponent } from '../set-schedule-modal/set-schedule-modal.component';
import { RealtimeChannel } from '@supabase/supabase-js';

declare var jsQR: any;

type AdminTab = 'employees' | 'dtr' | 'payroll' | 'analytics';

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface DtrPayPeriodGroup {
  id: string; // e.g., "2023-10-16_2023-11-15"
  display: string; // e.g., "October 16 - November 15, 2023"
  payPeriodStart: Date;
  payPeriodEnd: Date;
  entries: (DtrEntry & { profiles: Profile | null })[];
  payrollStatus: 'Processed' | 'Not Processed';
}

interface PayrollGroup {
  monthYearDisplay: string; // e.g., "December 2023"
  monthYearValue: string; // e.g., "2023-12"
  payrolls: (Payroll & { profiles: Profile | null })[];
}

type Notification = { type: 'success' | 'error'; message: string };

type LiveStatus = 'Timed In' | 'On Break' | 'Timed Out' | 'Absent' | 'No Schedule' | 'Day Off' | 'On Leave (SIL)' | 'Emergency Leave';

interface LiveEmployeeStatus {
  profile: Profile;
  status: LiveStatus;
  todaysSchedule: string;
  lastEventTime: Date | null;
  workDurationSeconds: number;
  breakTimeRemainingSeconds: number;
  timerDisplay: string;
  dtrEntries: DtrEntry[];
}

@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AddEmployeeModalComponent, 
    RunPayrollModalComponent, 
    ConfirmationModalComponent, 
    ViewEmployeeModalComponent,
    IdCardModalComponent,
    SetScheduleModalComponent,
    DatePipe, 
    CurrencyPipe
  ],
})
export class AdminDashboardComponent implements OnDestroy {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);
  private realtimeChannel: RealtimeChannel | null = null;
  private notificationTimer: any;
  private timerInterval: any;

  readonly currentUserRole = this.supabaseService.currentUserRole;
  activeTab = signal<AdminTab>('employees');
  isSidebarOpen = signal(false);
  notification = signal<Notification | null>(null);
  readonly currentYear = new Date().getFullYear();

  // Employee Search & Sort
  searchTerm = signal<string>('');
  employeeSortOption = signal<'newest' | 'oldest' | 'lastNameAsc' | 'lastNameDesc'>('newest');

  employees = signal<Profile[]>([]);
  employeesLoading = signal(true);
  employeesError = signal<string | null>(null);
  
  // --- Time Clock Mode Signals & Properties ---
  video = viewChild<ElementRef<HTMLVideoElement>>('video');
  canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  isTimeClockModeActive = signal(false);
  scannerLoading = signal(false);
  scannerErrorMessage = signal<string | null>(null);
  lastScanResult = signal<{ profile: Profile; dtrEntry: DtrEntry; status: string } | null>(null);
  breakCountdown = signal<number | null>(null);
  breakCountdownDisplay = computed(() => {
    const seconds = this.breakCountdown();
    if (seconds === null || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  });

  private stream: MediaStream | null = null;
  private isScanning = false;
  private scanResultTimer: any;
  private breakTimerInterval: any;

  filteredEmployees = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const sortOption = this.employeeSortOption();
    
    const filtered = this.employees().filter(emp =>
      !term || // if no term, return all
      (emp.employee_id?.toLowerCase().includes(term)) ||
      (emp.first_name?.toLowerCase().includes(term)) ||
      (emp.middle_name?.toLowerCase().includes(term)) ||
      (emp.last_name?.toLowerCase().includes(term)) ||
      (emp.email?.toLowerCase().includes(term)) ||
      (emp.branch?.toLowerCase().includes(term))
    );

    const sorted = filtered.sort((a, b) => {
      switch(sortOption) {
        case 'lastNameAsc':
          return (a.last_name || '').localeCompare(b.last_name || '');
        case 'lastNameDesc':
          return (b.last_name || '').localeCompare(a.last_name || '');
        case 'oldest':
          return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        case 'newest':
        default:
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      }
    });

    return sorted;
  });

  // DTR Signals
  dtrSearchTerm = signal<string>('');
  dtrSortOption = signal<'newest' | 'oldest' | 'nameAsc' | 'nameDesc'>('newest');
  dtrEntries = signal<(DtrEntry & { profiles: Profile | null })[]>([]);
  dtrLoading = signal(true);
  dtrError = signal<string | null>(null);
  openDtrPeriods = signal(new Set<string>()); // To track open accordions
  
  groupedDtrPayPeriods = computed<DtrPayPeriodGroup[]>(() => {
    const allDtr = this.dtrEntries();
    const allPayrolls = this.payrolls();
    const term = this.dtrSearchTerm().toLowerCase().trim();
    const sortOption = this.dtrSortOption();

    if (!allDtr.length) return [];

    const dtrByPeriod: Record<string, DtrPayPeriodGroup> = {};

    for (const entry of allDtr) {
        if (!entry.time_in) continue;
        const entryDate = new Date(entry.time_in);
        const day = entryDate.getUTCDate();
        let month = entryDate.getUTCMonth();
        let year = entryDate.getUTCFullYear();

        let periodStart: Date;
        let periodEnd: Date;

        if (day >= 16) {
            periodStart = new Date(Date.UTC(year, month, 16));
            periodEnd = new Date(Date.UTC(year, month + 1, 15, 23, 59, 59, 999));
        } else {
            periodStart = new Date(Date.UTC(year, month - 1, 16));
            periodEnd = new Date(Date.UTC(year, month, 15, 23, 59, 59, 999));
        }

        const periodId = `${periodStart.toISOString().slice(0, 10)}_${periodEnd.toISOString().slice(0, 10)}`;

        if (!dtrByPeriod[periodId]) {
            const periodStartStr = periodStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
            const periodEndStr = periodEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            
            const isProcessed = allPayrolls.some(p => p.pay_period_start.startsWith(periodStart.toISOString().slice(0, 10)));
            
            dtrByPeriod[periodId] = {
                id: periodId,
                display: `${periodStartStr} - ${periodEndStr}`,
                payPeriodStart: periodStart,
                payPeriodEnd: periodEnd,
                entries: [],
                payrollStatus: isProcessed ? 'Processed' : 'Not Processed'
            };
        }
        dtrByPeriod[periodId].entries.push(entry);
    }
    
    const sortedGroups = Object.values(dtrByPeriod).sort((a, b) => b.payPeriodStart.getTime() - a.payPeriodStart.getTime());

    // Filter and sort entries within each group
    return sortedGroups.map(group => {
      // Filter
      const filteredEntries = group.entries.filter(entry => {
        if (!term) return true;
        const fullName = `${entry.profiles?.first_name || ''} ${entry.profiles?.last_name || ''}`.toLowerCase();
        return fullName.includes(term);
      });

      // Sort
      const sortedAndFilteredEntries = filteredEntries.sort((a, b) => {
        switch (sortOption) {
          case 'nameAsc': {
            const nameA = `${a.profiles?.last_name || ''} ${a.profiles?.first_name || ''}`.trim();
            const nameB = `${b.profiles?.last_name || ''} ${b.profiles?.first_name || ''}`.trim();
            return nameA.localeCompare(nameB);
          }
          case 'nameDesc': {
            const nameA = `${a.profiles?.last_name || ''} ${a.profiles?.first_name || ''}`.trim();
            const nameB = `${b.profiles?.last_name || ''} ${b.profiles?.first_name || ''}`.trim();
            return nameB.localeCompare(nameA);
          }
          case 'oldest':
            return new Date(a.time_in || 0).getTime() - new Date(b.time_in || 0).getTime();
          case 'newest':
          default:
            return new Date(b.time_in || 0).getTime() - new Date(a.time_in || 0).getTime();
        }
      });
      
      return { ...group, entries: sortedAndFilteredEntries };
    }).filter(group => group.entries.length > 0);
  });

  // Payroll Signals
  payrolls = signal<(Payroll & { profiles: Profile | null })[]>([]);
  payrollsLoading = signal(true);
  payrollsError = signal<string | null>(null);
  openPayrollMonths = signal(new Set<string>());
  selectedPayPeriod = signal<{start: Date, end: Date} | null>(null);


  groupedPayrolls = computed<PayrollGroup[]>(() => {
    const allPayrolls = this.payrolls();
    if (!allPayrolls.length) {
      return [];
    }

    // 1. Group payrolls by month based on pay_period_end
    const groups: Record<string, PayrollGroup> = {};
    for (const payroll of allPayrolls) {
      const date = new Date(payroll.pay_period_end);
      const monthYearValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!groups[monthYearValue]) {
        groups[monthYearValue] = {
          monthYearDisplay: date.toLocaleString('default', { month: 'long', year: 'numeric' }),
          monthYearValue: monthYearValue,
          payrolls: []
        };
      }
      groups[monthYearValue].payrolls.push(payroll);
    }

    // 2. Convert to array and sort groups (newest first)
    const sortedGroups = Object.values(groups).sort((a, b) => b.monthYearValue.localeCompare(a.monthYearValue));

    // 3. Sort entries within each group (by employee name)
    return sortedGroups.map(group => {
      const sortedPayrolls = group.payrolls.sort((a, b) => {
          const nameA = `${a.profiles?.last_name || ''} ${a.profiles?.first_name || ''}`.trim();
          const nameB = `${b.profiles?.last_name || ''} ${b.profiles?.first_name || ''}`.trim();
          return nameA.localeCompare(nameB);
      });
      return { ...group, payrolls: sortedPayrolls };
    });
  });

  // --- Analytics Signals ---
  liveEmployeeStatus = signal<LiveEmployeeStatus[]>([]);
  analyticsLoading = signal(true);
  analyticsError = signal<string | null>(null);

  isAddEmployeeModalVisible = signal(false);
  isRunPayrollModalVisible = signal(false); 
  isIdCardModalVisible = signal(false);
  isViewEmployeeModalVisible = signal(false);
  isSetScheduleModalVisible = signal(false);
  
  logoutError = signal<string | null>(null);
  
  selectedEmployee = signal<Profile | null>(null);
  employeeToEdit = signal<Profile | null>(null);
  
  isConfirmModalVisible = signal(false);
  confirmModalConfig = signal<ConfirmModalConfig>({ title: '', message: '', onConfirm: () => {} });

  constructor() {
    this.loadInitialData();

    effect((onCleanup) => {
      const tab = this.activeTab();
      // Pre-load data for better UX
      if (tab === 'employees' && this.employees().length === 0) this.loadEmployees();
      if (tab === 'dtr' && this.dtrEntries().length === 0) this.loadDtrAndPayrolls();
      if (tab === 'payroll' && this.payrolls().length === 0) this.loadPayrolls();
      
      if (tab === 'analytics') {
        this.loadLiveAnalyticsData();
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => this.updateTimers(), 1000);
      } else {
        if (this.timerInterval) clearInterval(this.timerInterval);
      }

      if (this.realtimeChannel) {
        this.supabaseService.unsubscribe(this.realtimeChannel);
      }
      this.realtimeChannel = this.supabaseService.subscribeToTableChanges(() => {
        const currentTab = this.activeTab();
        if (currentTab === 'employees') {
            this.loadEmployees();
        } else if (currentTab === 'dtr') {
            this.loadDtrAndPayrolls();
        } else if (currentTab === 'analytics') {
            this.loadLiveAnalyticsData();
        }
      });

      onCleanup(() => {
        if(this.realtimeChannel) this.supabaseService.unsubscribe(this.realtimeChannel);
        if (this.timerInterval) clearInterval(this.timerInterval);
      });

    });

    // Effect for scanner lifecycle
    effect(() => {
        const videoElRef = this.video();
        if (this.isTimeClockModeActive() && videoElRef) {
            this.startScanner();
        } else {
            this.stopScanner();
        }
    });
  }

  ngOnDestroy(): void {
    if (this.realtimeChannel) {
      this.supabaseService.unsubscribe(this.realtimeChannel);
    }
    if (this.notificationTimer) {
      clearTimeout(this.notificationTimer);
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    this.stopScanner();
  }

  loadInitialData(): void {
    this.loadEmployees();
  }

  showNotification(type: 'success' | 'error', message: string, duration = 5000): void {
    if (this.notificationTimer) {
      clearTimeout(this.notificationTimer);
    }
    this.notification.set({ type, message });
    this.notificationTimer = setTimeout(() => this.notification.set(null), duration);
  }
  
  onSearchTermChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchTerm.set(value);
  }

  onDtrSearchTermChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.dtrSearchTerm.set(value);
  }

  setEmployeeSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'newest' | 'oldest' | 'lastNameAsc' | 'lastNameDesc';
    this.employeeSortOption.set(value);
  }

  setDtrSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'newest' | 'oldest' | 'nameAsc' | 'nameDesc';
    this.dtrSortOption.set(value);
  }

  setActiveTab(tab: AdminTab): void {
    this.activeTab.set(tab);
  }

  async loadEmployees(): Promise<void> {
    this.employeesLoading.set(true);
    this.employeesError.set(null);
    try {
      // The service now fetches only employee profiles directly.
      const { data, error } = await this.supabaseService.getAllUsersWithProfiles();
      if (error) throw error;

      this.employees.set(data || []);

    } catch (e: any) {
      this.employeesError.set(`Failed to load employees: ${e.message}`);
    } finally {
      this.employeesLoading.set(false);
    }
  }

  async loadDtrAndPayrolls(): Promise<void> {
    await this.loadDtrEntries();
    await this.loadPayrolls();
  }

  async loadDtrEntries(): Promise<void> {
    this.dtrLoading.set(true);
    this.dtrError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllDtrEntries();
      if (error) throw error;
      this.dtrEntries.set(data as any || []);
    } catch (e: any) {
      this.dtrError.set(`Failed to load DTR entries: ${e.message}`);
    } finally {
      this.dtrLoading.set(false);
    }
  }

  async loadPayrolls(): Promise<void> {
    this.payrollsLoading.set(true);
    this.payrollsError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllPayrolls();
      if (error) throw error;
      this.payrolls.set(data  as any || []);
    } catch (e: any) {
      this.payrollsError.set(`Failed to load payrolls: ${e.message}`);
    } finally {
      this.payrollsLoading.set(false);
    }
  }

  async loadLiveAnalyticsData(): Promise<void> {
    this.analyticsLoading.set(true);
    this.analyticsError.set(null);

    try {
        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);
        const startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

        const employeesRes = await this.supabaseService.getAllUsersWithProfiles();
        if (employeesRes.error) throw employeesRes.error;
        const employees = employeesRes.data || [];
        if (employees.length === 0) {
            this.liveEmployeeStatus.set([]);
            this.analyticsLoading.set(false);
            return;
        }

        const employeeIds = employees.map(e => e.id);
        const [dtrRes, schedulesRes, statusesRes] = await Promise.all([
            this.supabaseService.getDtrEntriesForDateRange(startOfDay, endOfDay),
            this.supabaseService.getSchedulesForDateRange(employeeIds, todayStr, todayStr),
            this.supabaseService.getStatusesForDate(employeeIds, todayStr)
        ]);
        
        if (dtrRes.error) throw dtrRes.error;
        if (schedulesRes.error) throw schedulesRes.error;
        if (statusesRes.error) throw statusesRes.error;

        const dtrEntries = dtrRes.data || [];
        const schedules = schedulesRes.data || [];
        const statusesToday = statusesRes.data || [];
        
        const dtrMap = new Map<string, DtrEntry[]>();
        dtrEntries.forEach(dtr => {
            if (!dtrMap.has(dtr.user_id)) dtrMap.set(dtr.user_id, []);
            dtrMap.get(dtr.user_id)!.push(dtr);
        });
        dtrMap.forEach(entries => entries.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
        
        const scheduleMap = new Map<string, EmployeeSchedule>();
        schedules.forEach(s => scheduleMap.set(s.user_id, s));
        
        const statusMap = new Map<string, EmployeeStatus>();
        statusesToday.forEach(s => statusMap.set(s.user_id, s));

        const now = Date.now();
        const statuses = employees.map((emp): LiveEmployeeStatus => {
            const todaysEntries = dtrMap.get(emp.id) || [];
            const schedule = scheduleMap.get(emp.id);
            const leaveStatus = statusMap.get(emp.id);

            let status: LiveStatus;
            let workDurationSeconds = 0;
            let breakTimeRemainingSeconds = 3600;
            let lastEventTime: Date | null = null;
            let todaysSchedule: string;

            if (leaveStatus) {
                switch(leaveStatus.status) {
                    case 'day_off': status = 'Day Off'; break;
                    case 'service_incentive_leave': status = 'On Leave (SIL)'; break;
                    case 'emergency_leave': status = 'Emergency Leave'; break;
                    default: status = 'Absent';
                }
                todaysSchedule = "On Leave";
            } else if (schedule) {
                 const startTime = this.formatTimeForDisplay(schedule.work_start_time);
                 const endTime = this.formatTimeForDisplay(schedule.work_end_time);
                 todaysSchedule = `${startTime} - ${endTime}`;
                 
                 if (todaysEntries.length === 0) {
                    status = 'Absent';
                 } else if (todaysEntries.length === 1 && todaysEntries[0].time_in) {
                    status = 'Timed In';
                    lastEventTime = new Date(todaysEntries[0].time_in);
                    workDurationSeconds = (now - lastEventTime.getTime()) / 1000;
                } else if (todaysEntries.length === 1 && todaysEntries[0].time_out) { // Break start
                    status = 'On Break';
                    const timeIn1 = new Date(todaysEntries[0].time_in!);
                    const timeOut1 = new Date(todaysEntries[0].time_out!);
                    lastEventTime = timeOut1;
                    workDurationSeconds = (timeOut1.getTime() - timeIn1.getTime()) / 1000;
                    const elapsedBreak = (now - timeOut1.getTime()) / 1000;
                    breakTimeRemainingSeconds = 3600 - elapsedBreak;
                 } else if (todaysEntries.length === 2 && todaysEntries[1].time_in) { // Break end
                    status = 'Timed In';
                    const timeIn1 = new Date(todaysEntries[0].time_in!);
                    const timeOut1 = new Date(todaysEntries[0].time_out!);
                    const timeIn2 = new Date(todaysEntries[1].time_in!);
                    lastEventTime = timeIn2;
                    const firstPeriod = (timeOut1.getTime() - timeIn1.getTime()) / 1000;
                    const secondPeriod = (now - timeIn2.getTime()) / 1000;
                    workDurationSeconds = firstPeriod + secondPeriod;
                } else if (todaysEntries.length >= 2 && todaysEntries[1].time_out) { // Day end
                    status = 'Timed Out';
                    const timeIn1 = new Date(todaysEntries[0].time_in!);
                    const timeOut1 = new Date(todaysEntries[0].time_out!);
                    const timeIn2 = new Date(todaysEntries[1].time_in!);
                    const timeOut2 = new Date(todaysEntries[1].time_out!);
                    lastEventTime = timeOut2;
                    workDurationSeconds = ((timeOut1.getTime() - timeIn1.getTime()) + (timeOut2.getTime() - timeIn2.getTime())) / 1000;
                } else {
                    status = 'Absent'; // Fallback
                }
            } else {
                 status = 'No Schedule';
                 todaysSchedule = 'No Schedule';
            }
            
            const liveStatus: LiveEmployeeStatus = {
                profile: emp, status, todaysSchedule, lastEventTime, workDurationSeconds, breakTimeRemainingSeconds, timerDisplay: '', dtrEntries: todaysEntries
            };
            
            liveStatus.timerDisplay = this.getTimerDisplay(liveStatus);
            return liveStatus;
        });
        
        this.liveEmployeeStatus.set(statuses);
    } catch (e: any) {
        this.analyticsError.set(e.message || 'Failed to load live data.');
    } finally {
        this.analyticsLoading.set(false);
    }
  }

  private updateTimers(): void {
    this.liveEmployeeStatus.update(statuses => 
      statuses.map(s => {
        const newStatus = { ...s };
        if (newStatus.status === 'Timed In') {
          newStatus.workDurationSeconds++;
        } else if (newStatus.status === 'On Break') {
          newStatus.breakTimeRemainingSeconds--;
          if (newStatus.breakTimeRemainingSeconds < 0) {
            newStatus.breakTimeRemainingSeconds = 0;
          }
        }
        
        newStatus.timerDisplay = this.getTimerDisplay(newStatus);
        return newStatus;
      })
    );
  }

  private getTimerDisplay(status: LiveEmployeeStatus): string {
    if (status.status === 'Timed In') {
      return this.formatSeconds(status.workDurationSeconds);
    }
    if (status.status === 'On Break') {
      return `Break: ${this.formatSeconds(status.breakTimeRemainingSeconds)}`;
    }
    if (status.status === 'Timed Out') {
      return this.formatSeconds(status.workDurationSeconds);
    }
    return '--:--:--';
  }

  private formatSeconds(totalSeconds: number): string {
    if (totalSeconds < 0) totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  private formatTimeForDisplay(timeStr: string): string {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':');
    let h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12; // the hour '0' should be '12'
    return `${h}:${minutes} ${ampm}`;
  }

  onEmployeeSaved(): void {
    this.showNotification('success', 'Employee data has been successfully saved.');
    this.refreshAllData();
  }

  refreshPayrolls(): void {
    this.showNotification('success', 'Payroll list has been updated.');
    this.loadPayrolls();
    this.loadDtrEntries(); // To update status
  }
  
  refreshAllData(): void {
    this.loadInitialData();
  }
  
  toggleDtrPeriod(periodId: string): void {
    this.openDtrPeriods.update(currentSet => {
        const newSet = new Set(currentSet);
        if (newSet.has(periodId)) {
            newSet.delete(periodId);
        } else {
            newSet.add(periodId);
        }
        return newSet;
    });
  }

  togglePayrollMonth(monthYearValue: string): void {
    this.openPayrollMonths.update(currentSet => {
        const newSet = new Set(currentSet);
        if (newSet.has(monthYearValue)) {
            newSet.delete(monthYearValue);
        } else {
            newSet.add(monthYearValue);
        }
        return newSet;
    });
  }

  // --- Modal Management ---
  openAddEmployeeModal(): void {
    this.employeeToEdit.set(null);
    this.isAddEmployeeModalVisible.set(true);
  }

  openEditEmployeeModal(employee: Profile): void {
    this.employeeToEdit.set(employee);
    this.isAddEmployeeModalVisible.set(true);
  }
  
  openViewEmployeeModal(employee: Profile): void {
    this.selectedEmployee.set(employee);
    this.isViewEmployeeModalVisible.set(true);
  }
  
  openIdCardModal(employee: Profile): void {
    this.selectedEmployee.set(employee);
    this.isIdCardModalVisible.set(true);
  }

  closeEmployeeModal(): void {
    this.isAddEmployeeModalVisible.set(false);
    this.employeeToEdit.set(null);
  }

  openRunPayrollForPeriod(group: DtrPayPeriodGroup): void {
    this.selectedPayPeriod.set({ start: group.payPeriodStart, end: group.payPeriodEnd });
    this.isRunPayrollModalVisible.set(true);
  }

  closeRunPayrollModal(): void {
    this.isRunPayrollModalVisible.set(false);
    this.selectedPayPeriod.set(null);
  }

  // --- Employee Delete Operation ---
  openDeleteConfirmation(employee: Profile): void {
    this.confirmModalConfig.set({
      title: 'Delete Employee?',
      message: `Are you sure you want to permanently delete ${employee.first_name} ${employee.last_name}? This will remove their profile and all associated data. This action cannot be undone.`,
      onConfirm: () => this.handleDeleteEmployee(employee),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteEmployee(employee: Profile): Promise<void> {
    const { error } = await this.supabaseService.deleteUserAndProfile(employee.id);
    if (error) {
      let errorMessage = `Error deleting employee: ${error.message}`;
      if (error.message.includes('Could not find the function')) {
        errorMessage = 'Database setup required. Please see the instructions in the supabase.service.ts file to create the delete_auth_user function in your Supabase SQL Editor.';
      }
      this.showNotification('error', errorMessage);
    } else {
      this.showNotification('success', `${employee.first_name} ${employee.last_name} has been deleted.`);
      this.loadEmployees(); // Reload list after deletion
    }
    this.isConfirmModalVisible.set(false);
  }
  
  async onPayrollStatusChange(payrollId: number, event: Event): Promise<void> {
    const newStatus = (event.target as HTMLSelectElement).value as 'Paid' | 'Delayed' | 'Unpaid';

    const originalPayrolls = this.payrolls();
    const payrollToUpdate = originalPayrolls.find(p => p.id === payrollId);
    if (!payrollToUpdate) return;

    // 1. Optimistically update UI
    this.payrolls.update(payrolls =>
      payrolls.map(p => (p.id === payrollId ? { ...p, status: newStatus } : p))
    );

    try {
      // 2. Make API call
      const { error } = await this.supabaseService.updatePayrollStatus(payrollId, newStatus);
      if (error) throw error;
      // Success: UI is already updated
      this.showNotification('success', `Payroll status updated to ${newStatus}.`);
    } catch (error: any) {
      // 3. Revert on failure
      this.showNotification('error', `Failed to update status: ${error.message}. Reverting change.`);
      this.payrolls.set(originalPayrolls);
    }
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

  // --- Time Clock Mode Methods ---

  toggleTimeClockMode(): void {
    this.isTimeClockModeActive.update(active => !active);
  }

  private async startScanner(): Promise<void> {
    try {
        if (this.isScanning) return;
        if (this.stream) this.stopScanner();
        
        const videoEl = this.video()?.nativeElement;
        if (!videoEl || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('Camera not available or not supported by this browser.');
        }
        
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });

        videoEl.srcObject = this.stream;
        videoEl.setAttribute('playsinline', 'true');
        await videoEl.play();
        
        this.isScanning = true;
        this.scannerErrorMessage.set(null);
        this.lastScanResult.set(null);
        requestAnimationFrame(this.tick.bind(this));

    } catch (err: any) {
        console.error('Error starting scanner:', err);
        this.scannerErrorMessage.set(err.message || 'Could not access the camera. Check permissions.');
    }
  }

  private stopScanner(): void {
    this.isScanning = false;
    if (this.scanResultTimer) {
        clearTimeout(this.scanResultTimer);
    }
    this.stopBreakTimer();
    if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
    }
    const videoEl = this.video()?.nativeElement;
    if (videoEl) {
        videoEl.srcObject = null;
    }
  }

  private startBreakTimer(): void {
    this.stopBreakTimer();
    this.breakCountdown.set(3600); // 1 hour in seconds
    this.breakTimerInterval = setInterval(() => {
      this.breakCountdown.update(val => {
        if (val === null || val <= 0) {
          this.stopBreakTimer();
          return 0;
        }
        return val - 1;
      });
    }, 1000);
  }

  private stopBreakTimer(): void {
    if (this.breakTimerInterval) {
      clearInterval(this.breakTimerInterval);
      this.breakTimerInterval = null;
      this.breakCountdown.set(null);
    }
  }

  private tick(): void {
    if (!this.isScanning) return;

    const videoEl = this.video()?.nativeElement;
    const canvasEl = this.canvas()?.nativeElement;
    
    if (videoEl && videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && canvasEl) {
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        canvasEl.height = videoEl.videoHeight;
        canvasEl.width = videoEl.videoWidth;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });
        
        if (code) {
          this.isScanning = false; // Stop further scanning while processing
          this.handleQrCodeScan(code.data);
          return; // Exit the loop
        }
      }
    }
    
    requestAnimationFrame(this.tick.bind(this));
  }
  
  private async handleQrCodeScan(qrData: string): Promise<void> {
    this.scannerLoading.set(true);
    this.scannerErrorMessage.set(null);
    this.stopBreakTimer();
    
    if (this.scanResultTimer) {
        clearTimeout(this.scanResultTimer);
    }

    try {
        const parsedData = JSON.parse(qrData);
        if (!parsedData.userId) {
            throw new Error('Invalid QR code format.');
        }
        
        const { profile, dtrEntry, status } = await this.supabaseService.handleQrCodeLogin(parsedData.userId);

        this.lastScanResult.set({ profile, dtrEntry, status });
        
        if (status === 'CLOCK_OUT_BREAK') {
            this.startBreakTimer();
        }

        // Hide message and restart scan after 5 seconds
        this.scanResultTimer = setTimeout(() => {
            this.lastScanResult.set(null);
            if (this.isTimeClockModeActive()) {
                this.isScanning = true;
                requestAnimationFrame(this.tick.bind(this));
            }
        }, 5000);

    } catch (error: any) {
        this.scannerErrorMessage.set(error.message || 'Failed to process QR code.');
        // Hide error and restart scan after 5 seconds
        this.scanResultTimer = setTimeout(() => {
            this.scannerErrorMessage.set(null);
            if (this.isTimeClockModeActive()) {
                this.isScanning = true;
                requestAnimationFrame(this.tick.bind(this));
            }
        }, 5000);
    } finally {
        this.scannerLoading.set(false);
    }
  }
}
