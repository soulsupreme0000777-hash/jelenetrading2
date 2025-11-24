import { Component, ChangeDetectionStrategy, inject, signal, effect, computed, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry, Payroll, EmployeeStatus, EmployeeSchedule, SalaryRule, CompanySetting, Position, Branch, PositionRate } from '../../services/supabase.service';
import { AddEmployeeModalComponent } from '../add-employee-modal/add-employee-modal.component';
import { RunPayrollModalComponent } from '../run-payroll-modal/run-payroll-modal.component';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';
import { DatePipe, CurrencyPipe, DecimalPipe } from '@angular/common';
import { ViewEmployeeModalComponent } from '../view-employee-modal/view-employee-modal.component';
import { IdCardModalComponent } from '../id-card-modal/id-card-modal.component';
import { SetScheduleModalComponent } from '../set-schedule-modal/set-schedule-modal.component';
import { DtrExportModalComponent } from '../dtr-export-modal/dtr-export-modal.component';
import { SalaryAdjustmentModalComponent } from '../salary-adjustment-modal/salary-adjustment-modal.component';
import { DtrBulkExportModalComponent } from '../dtr-bulk-export-modal/dtr-bulk-export-modal.component';
import { IdCardBulkViewModalComponent } from '../id-card-bulk-view-modal/id-card-bulk-view-modal.component';
import { EmployeeDetailsBulkViewModalComponent } from '../employee-details-bulk-view-modal/employee-details-bulk-view-modal.component';
import { FormsModule } from '@angular/forms';

// FIX: The RealtimeChannel type is not available from the Supabase import due to environment/versioning issues.
// The import is removed, and `any` will be used as a workaround.
// import { RealtimeChannel } from '@supabase/supabase-js';

type AdminTab = 'manage-employees' | 'dtr' | 'payroll' | 'daily-logs' | 'manage-payroll' | 'recovery' | 'analytics';

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
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

// --- DTR Timesheet Specific Types ---
type TimesheetCellStatus = 'Present' | 'Late' | 'Absent' | 'Leave' | 'NoSchedule' | 'Weekend';
interface TimesheetDay {
    dateStr: string;
    dayOfMonth: number;
    isToday: boolean;
    // FIX: Added the `isCurrentMonth` property to align the type with its usage in the `monthlyAttendanceSummary` computed signal.
    isCurrentMonth: boolean;
    isWeekend: boolean;
    status: TimesheetCellStatus;
    hoursWorked: number | null;
    dtr: DtrEntry[];
}
interface TimesheetRow {
    employee: Profile;
    days: TimesheetDay[];
}
interface DtrSummary {
    present: number;
    onLeave: number;
    late: number;
    absent: number;
}
interface AvailablePayPeriod {
    id: string;
    display: string;
    start: Date;
    end: Date;
    isProcessed?: boolean;
}

export interface PayrollSettings {
  late_rate_per_minute: number;
  grace_period_minutes: number;
  birth_month_bonus: { [positionName: string]: number };
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
    DtrExportModalComponent,
    SalaryAdjustmentModalComponent,
    DtrBulkExportModalComponent,
    IdCardBulkViewModalComponent,
    EmployeeDetailsBulkViewModalComponent,
    DatePipe, 
    CurrencyPipe,
    FormsModule,
    DecimalPipe
  ],
})
export class AdminDashboardComponent implements OnDestroy {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);
  // FIX: Using `any` as RealtimeChannel type is not available from import.
  private realtimeChannel: any | null = null;
  private notificationTimer: any;
  private timerInterval: any;

  readonly currentUserRole = this.supabaseService.currentUserRole;
  activeTab = signal<AdminTab>('analytics');
  isSidebarOpen = signal(false);
  notification = signal<Notification | null>(null);
  readonly currentYear = new Date().getFullYear();

  // Employee Search, Sort, and Selection
  searchTerm = signal<string>('');
  employeeSortOption = signal<'newest' | 'oldest' | 'lastNameAsc' | 'lastNameDesc'>('newest');
  selectedEmployees = signal(new Set<string>());
  isMultiSelectMode = signal(false);

  employees = signal<Profile[]>([]);
  employeesLoading = signal(true);
  employeesError = signal<string | null>(null);
  
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
  
  isAllEmployeesSelected = computed(() => {
    const filtered = this.filteredEmployees();
    const selected = this.selectedEmployees();
    if (filtered.length === 0) return false;
    return filtered.every(emp => selected.has(emp.id));
  });

  selectedEmployeeIdsArray = computed(() => [...this.selectedEmployees()]);

  selectedEmployeeProfiles = computed(() => {
    const selectedIds = this.selectedEmployees();
    return this.employees().filter(e => selectedIds.has(e.id));
  });

  // --- NEW DTR Tab Signals ---
  dtrViewDate = signal(new Date());
  dtrDataLoading = signal(true);
  dtrSchedules = signal<EmployeeSchedule[]>([]);
  dtrEntries = signal<DtrEntry[]>([]);
  dtrStatuses = signal<EmployeeStatus[]>([]);
  isPayrollPeriodSelectorVisible = signal(false);
  dtrSearchTerm = signal<string>('');
  dtrFilterStatus = signal<'all' | 'present' | 'late' | 'absent' | 'noSchedule'>('all');


  dtrCalendarDays = computed(() => {
      const viewDate = this.dtrViewDate();
      const year = viewDate.getFullYear();
      const month = viewDate.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      
      const days = [];
      for (let i = 1; i <= daysInMonth; i++) {
          const date = new Date(year, month, i);
          const dayOfWeek = date.getDay();
          days.push({
              dateStr: date.toISOString().slice(0, 10),
              dayOfMonth: i,
              isToday: new Date().toDateString() === date.toDateString(),
              // FIX: Add `isCurrentMonth` to ensure the generated data aligns with the `TimesheetDay` type.
              isCurrentMonth: true,
              isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
              dayName: date.toLocaleDateString('en-US', { weekday: 'short' })
          });
      }
      return days;
  });

  dtrTimesheetData = computed<TimesheetRow[]>(() => {
    const employees = this.employees();
    const calendarDays = this.dtrCalendarDays();
    const schedules = this.dtrSchedules();
    const dtr = this.dtrEntries();
    const statuses = this.dtrStatuses();
    const gracePeriod = this.payrollSettings().grace_period_minutes;

    const scheduleMap = new Map<string, EmployeeSchedule>(schedules.map(s => [`${s.user_id}|${s.date}`, s]));
    const statusMap = new Map<string, EmployeeStatus>(statuses.map(s => [`${s.user_id}|${s.date}`, s]));
    const dtrMap = new Map<string, DtrEntry[]>();
    dtr.forEach(entry => {
        if (!entry.time_in) return;
        const key = `${entry.user_id}|${new Date(entry.time_in).toISOString().slice(0, 10)}`;
        if (!dtrMap.has(key)) dtrMap.set(key, []);
        dtrMap.get(key)!.push(entry);
    });

    return employees.map(employee => {
        const days: TimesheetDay[] = calendarDays.map(day => {
            const key = `${employee.id}|${day.dateStr}`;
            const schedule = scheduleMap.get(key);
            const status = statusMap.get(key);
            const dailyDtr = (dtrMap.get(key) || []).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

            let cellStatus: TimesheetCellStatus = 'NoSchedule';
            let hoursWorked: number | null = null;
            
            if (day.isWeekend && !schedule) {
                cellStatus = 'Weekend';
            } else if (status) {
                cellStatus = 'Leave';
            } else if (schedule) {
                if (dailyDtr.length > 0) {
                    const expectedStart = new Date(`${day.dateStr}T${schedule.work_start_time}Z`);
                    const actualStart = new Date(dailyDtr[0].time_in!);
                    cellStatus = (actualStart.getTime() - expectedStart.getTime()) / 60000 > gracePeriod ? 'Late' : 'Present';

                    let workMs = 0;
                    if (dailyDtr[0].time_out) workMs += new Date(dailyDtr[0].time_out).getTime() - new Date(dailyDtr[0].time_in!).getTime();
                    if (dailyDtr.length > 1 && dailyDtr[1].time_in && dailyDtr[1].time_out) {
                        workMs += new Date(dailyDtr[1].time_out).getTime() - new Date(dailyDtr[1].time_in).getTime();
                    }
                    hoursWorked = parseFloat((workMs / 3600000).toFixed(1));

                } else {
                    cellStatus = 'Absent';
                }
            }
            
            return { ...day, status: cellStatus, hoursWorked, dtr: dailyDtr };
        });
        return { employee, days };
    });
  });

  filteredDtrTimesheetData = computed(() => {
    const originalData = this.dtrTimesheetData();
    const searchTerm = this.dtrSearchTerm().toLowerCase().trim();
    const filterStatus = this.dtrFilterStatus();
  
    // 1. Filter by search term
    const searchedData = !searchTerm
      ? originalData
      : originalData.filter(row =>
          `${row.employee.first_name || ''} ${row.employee.last_name || ''}`.toLowerCase().includes(searchTerm)
        );
  
    // 2. If no specific status filter, return the searched data as is (for the grid view)
    if (filterStatus === 'all') {
      return searchedData;
    }
  
    // 3. Filter by status and transform the data for list view
    const statusMap: { [key: string]: TimesheetCellStatus[] } = {
        present: ['Present'],
        late: ['Late'],
        absent: ['Absent'],
        noSchedule: ['NoSchedule']
    };
    const targetStatuses = statusMap[filterStatus];
  
    return searchedData.map(row => {
        const matchingDays = row.days.filter(day => targetStatuses.includes(day.status));
        return { ...row, days: matchingDays };
      })
      .filter(row => row.days.length > 0); // Only include employees who have days matching the filter
  });

  dtrSummary = computed<DtrSummary>(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const timesheet = this.dtrTimesheetData();
    const summary: DtrSummary = { present: 0, onLeave: 0, late: 0, absent: 0 };

    if (!timesheet.length) return summary;

    timesheet.forEach(row => {
        const todayData = row.days.find(d => d.dateStr === todayStr);
        if (todayData) {
            switch (todayData.status) {
                case 'Present': summary.present++; break;
                case 'Late': summary.late++; break;
                case 'Leave': summary.onLeave++; break;
                case 'Absent': summary.absent++; break;
            }
        }
    });
    return summary;
  });

  availablePayPeriods = computed<AvailablePayPeriod[]>(() => {
      const allDtr = this.dtrEntries();
      const allPayrolls = this.payrolls();

      if (!allDtr.length) return [];
      
      const periods: Record<string, { start: Date, end: Date }> = {};
      allDtr.forEach(entry => {
          if (!entry.time_in) return;
          const entryDate = new Date(entry.time_in);
          const day = entryDate.getUTCDate();
          let month = entryDate.getUTCMonth();
          let year = entryDate.getUTCFullYear();

          let periodStart: Date, periodEnd: Date;
          if (day >= 16) {
              periodStart = new Date(Date.UTC(year, month, 16));
              periodEnd = new Date(Date.UTC(year, month + 1, 15, 23, 59, 59, 999));
          } else {
              periodStart = new Date(Date.UTC(year, month - 1, 16));
              periodEnd = new Date(Date.UTC(year, month, 15, 23, 59, 59, 999));
          }
          const periodId = `${periodStart.toISOString().slice(0, 10)}_${periodEnd.toISOString().slice(0, 10)}`;
          if (!periods[periodId]) {
              periods[periodId] = { start: periodStart, end: periodEnd };
          }
      });
      
      const processedPeriodStarts = new Set(allPayrolls.map(p => p.pay_period_start.slice(0, 10)));
      
      return Object.entries(periods)
        .map(([id, dates]) => ({
            id,
            display: `${dates.start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} - ${dates.end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
            ...dates,
            isProcessed: processedPeriodStarts.has(dates.start.toISOString().slice(0, 10)),
        }))
        .sort((a, b) => b.start.getTime() - a.start.getTime());
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
    // FIX: Correctly compare the `monthYearValue` string of both objects in the sort function.
    const sortedGroups = Object.values(groups).sort((a, b) => b.monthYearValue.localeCompare(a.monthYearValue));
    return sortedGroups.map(group => {
      const sortedPayrolls = group.payrolls.sort((a, b) => {
          const nameA = `${a.profiles?.last_name || ''} ${a.profiles?.first_name || ''}`.trim();
          const nameB = `${b.profiles?.last_name || ''} ${b.profiles?.first_name || ''}`.trim();
          return nameA.localeCompare(nameB);
      });
      return { ...group, payrolls: sortedPayrolls };
    });
  });

  // --- Manage Payroll Signals ---
  settingsLoading = signal(true);
  positions = signal<Position[]>([]);
  branches = signal<Branch[]>([]);
  positionRates = signal<PositionRate[]>([]);
  positionRatesModel = signal<Record<number, Record<number, number | null>>>({});
  payrollSettings = signal<PayrollSettings>({
    late_rate_per_minute: 1.60,
    grace_period_minutes: 15,
    birth_month_bonus: {},
  });
  salaryRules = signal<SalaryRule[]>([]);
  salaryRulesLoading = signal(true);
  isSalaryAdjustmentModalVisible = signal(false);
  adjustmentToEdit = signal<SalaryRule | null>(null);

  // --- Daily Logs Signals ---
  liveEmployeeStatus = signal<LiveEmployeeStatus[]>([]);
  dailyLogsLoading = signal(true);
  dailyLogsError = signal<string | null>(null);
  
  // --- Recovery Signals ---
  deletedEmployees = signal<Profile[]>([]);
  recoveryLoading = signal(true);
  recoveryError = signal<string | null>(null);
  
  // --- Analytics Signals ---
  colorPalette = [
    { text: 'text-indigo-500', bg: 'bg-indigo-500' },
    { text: 'text-sky-500', bg: 'bg-sky-500' },
    { text: 'text-emerald-500', bg: 'bg-emerald-500' },
    { text: 'text-amber-500', bg: 'bg-amber-500' },
    { text: 'text-rose-500', bg: 'bg-rose-500' },
    { text: 'text-fuchsia-500', bg: 'bg-fuchsia-500' },
  ];

  totalEmployees = computed(() => this.employees().length);
  totalBranches = computed(() => new Set(this.employees().filter(e => e.branch).map(e => e.branch)).size);
  
  distributionByBranch = computed(() => {
    const branchCounts = this.employees().reduce((acc, emp) => {
      const branch = emp.branch || 'Unassigned';
      acc[branch] = (acc[branch] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sortedBranches = Object.entries(branchCounts).sort((a, b) => b[1] - a[1]);
    const total = this.employees().length;
    if (total === 0) return [];

    let cumulativePercentage = 0;
    return sortedBranches.map(([name, count], index) => {
      const percentage = (count / total) * 100;
      const colorSet = this.colorPalette[index % this.colorPalette.length];
      const data = {
        name,
        count,
        percentage,
        offset: cumulativePercentage,
        textColor: colorSet.text,
        bgColor: colorSet.bg,
      };
      cumulativePercentage += percentage;
      return data;
    });
  });

  distributionByPosition = computed(() => {
    const positionCounts = this.employees().reduce((acc, emp) => {
      const position = emp.position || 'Unassigned';
      acc[position] = (acc[position] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sortedPositions = Object.entries(positionCounts).sort((a, b) => b[1] - a[1]);
    const maxCount = sortedPositions[0]?.[1] || 0;

    return sortedPositions.map(([name, count], index) => ({
      name,
      count,
      heightPercentage: maxCount > 0 ? (count / maxCount) * 100 : 0,
      color: this.colorPalette[index % this.colorPalette.length].bg,
    }));
  });

  monthlyAttendanceSummary = computed(() => {
    const summary = { present: 0, late: 0, absent: 0, onLeave: 0 };
    this.dtrTimesheetData().forEach(row => {
        row.days.forEach(day => {
            if (day.isCurrentMonth && !day.isWeekend && day.status !== 'NoSchedule') {
                switch(day.status) {
                    case 'Present': summary.present++; break;
                    case 'Late': summary.late++; break;
                    case 'Absent': summary.absent++; break;
                    case 'Leave': summary.onLeave++; break;
                }
            }
        });
    });
    
    const total = summary.present + summary.late + summary.absent + summary.onLeave;
    
    return {
      stats: [
        { name: 'Present', count: summary.present, percentage: total > 0 ? (summary.present / total) * 100 : 0, color: 'bg-green-500' },
        { name: 'Late', count: summary.late, percentage: total > 0 ? (summary.late / total) * 100 : 0, color: 'bg-yellow-500' },
        { name: 'On Leave', count: summary.onLeave, percentage: total > 0 ? (summary.onLeave / total) * 100 : 0, color: 'bg-blue-500' },
        { name: 'Absent', count: summary.absent, percentage: total > 0 ? (summary.absent / total) * 100 : 0, color: 'bg-red-500' }
      ],
      total,
    };
  });


  // --- Modals Visibility ---
  isAddEmployeeModalVisible = signal(false);
  isRunPayrollModalVisible = signal(false); 
  isIdCardModalVisible = signal(false);
  isViewEmployeeModalVisible = signal(false);
  isSetScheduleModalVisible = signal(false);
  isDtrExportModalVisible = signal(false);
  isDtrBulkExportModalVisible = signal(false);
  isIdCardBulkViewModalVisible = signal(false);
  isEmployeeDetailsBulkViewModalVisible = signal(false);
  
  logoutError = signal<string | null>(null);
  
  selectedEmployeeForModal = signal<Profile | null>(null);
  employeeToEdit = signal<Profile | null>(null);
  
  isConfirmModalVisible = signal(false);
  confirmModalConfig = signal<ConfirmModalConfig>({ title: '', message: '', onConfirm: () => {} });

  constructor() {
    this.loadInitialData();

    effect((onCleanup) => {
      const tab = this.activeTab();
      if ((tab === 'manage-employees' || tab === 'analytics') && this.employees().length === 0) this.loadEmployees();
      if (tab === 'payroll' && this.payrolls().length === 0) this.loadPayrolls();
      if (tab === 'recovery' && this.deletedEmployees().length === 0) this.loadDeletedEmployees();
      
      if (tab === 'dtr' || tab === 'analytics') {
        this.loadDtrMonthlyData();
      }
      
      if (tab === 'manage-payroll') {
        this.loadPayrollSettings();
      }

      if (tab === 'daily-logs') {
        this.loadDailyLogsData();
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
        if (currentTab === 'manage-employees' || currentTab === 'analytics') this.loadEmployees();
        if (currentTab === 'recovery') this.loadDeletedEmployees();
        if (currentTab === 'dtr' || currentTab === 'analytics') this.loadDtrMonthlyData();
        if (currentTab === 'daily-logs') this.loadDailyLogsData();
        if (currentTab === 'manage-payroll') this.loadPayrollSettings();
      });

      onCleanup(() => {
        if(this.realtimeChannel) this.supabaseService.unsubscribe(this.realtimeChannel);
        if (this.timerInterval) clearInterval(this.timerInterval);
      });

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
  }

  loadInitialData(): void {
    this.loadEmployees();
    this.loadPayrolls();
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

  setEmployeeSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'newest' | 'oldest' | 'lastNameAsc' | 'lastNameDesc';
    this.employeeSortOption.set(value);
  }

  setActiveTab(tab: AdminTab): void {
    this.activeTab.set(tab);
    this.selectedEmployees.set(new Set()); // Clear selection when changing tabs
    this.isMultiSelectMode.set(false); // Also exit multi-select mode
  }

  async loadEmployees(): Promise<void> {
    this.employeesLoading.set(true);
    this.employeesError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllUsersWithProfiles();
      if (error) throw error;
      this.employees.set(data || []);
    } catch (e: any) {
      this.employeesError.set(`Failed to load employees: ${e.message}`);
    } finally {
      this.employeesLoading.set(false);
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

  async loadDtrMonthlyData(): Promise<void> {
    this.dtrDataLoading.set(true);
    const viewDate = this.dtrViewDate();
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    const startDate = new Date(year, month, 1).toISOString();
    const endDate = new Date(year, month + 1, 1).toISOString();
    const employeeIds = this.employees().map(e => e.id);

    try {
        if(this.employees().length === 0) await this.loadEmployees();
        
        const [schedulesRes, dtrRes, statusesRes] = await Promise.all([
            this.supabaseService.getSchedulesForDateRange(employeeIds, startDate.slice(0, 10), endDate.slice(0, 10)),
            this.supabaseService.getDtrEntriesForDateRange(startDate, endDate),
            this.supabaseService.getAllStatusesForDateRange(employeeIds, startDate.slice(0, 10), endDate.slice(0, 10))
        ]);

        if (schedulesRes.error) throw schedulesRes.error;
        this.dtrSchedules.set(schedulesRes.data || []);
        
        if (dtrRes.error) throw dtrRes.error;
        this.dtrEntries.set(dtrRes.data || []);

        if (statusesRes.error) throw statusesRes.error;
        this.dtrStatuses.set(statusesRes.data || []);
    } catch (e: any) {
        console.error("Failed to load DTR monthly data", e);
    } finally {
        this.dtrDataLoading.set(false);
    }
  }

  changeDtrMonth(offset: number): void {
      this.dtrViewDate.update(d => {
          const newDate = new Date(d);
          newDate.setMonth(newDate.getMonth() + offset);
          return newDate;
      });
      this.loadDtrMonthlyData();
  }
  
   async loadPayrollSettings(): Promise<void> {
    this.settingsLoading.set(true);
    this.salaryRulesLoading.set(true);
    try {
        const [settingsRes, rulesRes, positionsRes, branchesRes, ratesRes] = await Promise.all([
            this.supabaseService.getCompanySettings(),
            this.supabaseService.getAllSalaryRules(),
            this.supabaseService.getPositions(),
            this.supabaseService.getBranches(),
            this.supabaseService.getPositionRates(),
        ]);

        if (settingsRes.error) throw settingsRes.error;
        if (rulesRes.error) throw rulesRes.error;
        if (positionsRes.error) throw positionsRes.error;
        if (branchesRes.error) throw branchesRes.error;
        if (ratesRes.error) throw ratesRes.error;

        const positionsData = positionsRes.data || [];
        const branchesData = branchesRes.data || [];
        const ratesData = ratesRes.data || [];
        this.positions.set(positionsData);
        this.branches.set(branchesData);
        this.positionRates.set(ratesData);

        // Process company settings
        const settingsData = settingsRes.data || [];
        this.payrollSettings.update(currentSettings => {
            const newSettings: PayrollSettings = { ...currentSettings };
            settingsData.forEach(s => {
                if (s.setting_key in newSettings) {
                    if (s.setting_key === 'birth_month_bonus' && typeof s.setting_value === 'string') {
                        try {
                            newSettings.birth_month_bonus = JSON.parse(s.setting_value);
                        } catch (e) {
                            console.error('Error parsing birth_month_bonus setting:', e);
                            newSettings.birth_month_bonus = {};
                        }
                    } else {
                        (newSettings as any)[s.setting_key] = s.setting_value;
                    }
                }
            });
            return newSettings;
        });

        // Process salary rules
        this.salaryRules.set(rulesRes.data || []);

        // Build model for position rates form
        const model: Record<number, Record<number, number | null>> = {};
        positionsData.forEach(p => {
          model[p.id] = {};
          branchesData.forEach(b => {
            const rate = ratesData.find(r => r.position_id === p.id && r.branch_id === b.id);
            model[p.id][b.id] = rate ? rate.daily_rate : null;
          });
        });
        this.positionRatesModel.set(model);


    } catch (e: any) {
        let message = e.message || 'An unknown error occurred.';
        if (typeof message === 'string' && message.includes('Could not find the table')) {
             message = `Database schema is out of date. ${message}. Please run the full setup script from the comments in 'src/services/supabase.service.ts' in your Supabase SQL editor to create the missing tables.`;
        }
        this.showNotification('error', `Failed to load payroll settings: ${message}`);
    } finally {
        this.settingsLoading.set(false);
        this.salaryRulesLoading.set(false);
    }
  }

  async savePayrollSettings(): Promise<void> {
    const currentSettings = this.payrollSettings();
    const settingsToUpdate = Object.entries(currentSettings).map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : value,
    }));
  
    try {
      await this.supabaseService.updateCompanySettings(settingsToUpdate);
      this.showNotification('success', 'Payroll settings saved successfully.');
    } catch (e: any) {
      this.showNotification('error', `Failed to save settings: ${e.message}`);
    }
  }

  async savePositionRates(): Promise<void> {
    const model = this.positionRatesModel();
    const ratesToUpsert: Omit<PositionRate, 'id'>[] = [];
    for (const posId in model) {
      for (const braId in model[posId]) {
        const rate = model[posId][braId];
        if (rate !== null && rate >= 0) {
          ratesToUpsert.push({
            position_id: +posId,
            branch_id: +braId,
            daily_rate: rate,
          });
        }
      }
    }

    try {
      const { error: upsertError } = await this.supabaseService.upsertPositionRates(ratesToUpsert);
      if (upsertError) throw upsertError;

      const { error: rpcError } = await this.supabaseService.updateAllEmployeeDailyRates();
      if (rpcError) throw rpcError;
      
      this.showNotification('success', 'Daily rates saved and applied to employees.');
      this.loadPayrollSettings(); // Reload to confirm
      this.loadEmployees(); // Reload employees to get updated rates
    } catch (e: any) {
      this.showNotification('error', `Failed to save daily rates: ${e.message}`);
    }
  }
  
  openAddSalaryRuleModal(): void {
    this.adjustmentToEdit.set(null);
    this.isSalaryAdjustmentModalVisible.set(true);
  }

  openEditSalaryRuleModal(rule: SalaryRule): void {
    this.adjustmentToEdit.set(rule);
    this.isSalaryAdjustmentModalVisible.set(true);
  }

  closeSalaryRuleModal(): void {
    this.isSalaryAdjustmentModalVisible.set(false);
    this.adjustmentToEdit.set(null);
  }

  onSalaryRuleSaved(): void {
    this.showNotification('success', 'Salary rule has been saved.');
    this.loadPayrollSettings();
  }

  openDeleteSalaryRuleConfirmation(rule: SalaryRule): void {
    this.confirmModalConfig.set({
      title: 'Delete Salary Rule?',
      message: `Are you sure you want to delete the rule "${rule.name}"? This action cannot be undone.`,
      onConfirm: () => this.handleDeleteSalaryRule(rule.id),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteSalaryRule(ruleId: number): Promise<void> {
    try {
      const { error } = await this.supabaseService.deleteSalaryRule(ruleId);
      if (error) throw error;
      this.showNotification('success', 'Salary rule deleted successfully.');
      this.loadPayrollSettings();
    } catch (e: any) {
      this.showNotification('error', `Failed to delete rule: ${e.message}`);
    } finally {
      this.isConfirmModalVisible.set(false);
    }
  }

  async loadDailyLogsData(): Promise<void> {
    this.dailyLogsLoading.set(true);
    this.dailyLogsError.set(null);

    try {
        const timeZone = 'Asia/Manila';
        const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone }));

        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(nowPST);

        const year = parts.find(p => p.type === 'year')!.value;
        const month = parts.find(p => p.type === 'month')!.value;
        const day = parts.find(p => p.type === 'day')!.value;
        const todayStr = `${year}-${month}-${day}`;

        const startOfDayPSTIso = `${todayStr}T00:00:00.000+08:00`;
        const endOfDayPSTIso = `${todayStr}T23:59:59.999+08:00`;

        const employeesRes = await this.supabaseService.getAllUsersWithProfiles();
        if (employeesRes.error) throw employeesRes.error;
        const employees = employeesRes.data || [];
        if (employees.length === 0) {
            this.liveEmployeeStatus.set([]);
            this.dailyLogsLoading.set(false);
            return;
        }

        const employeeIds = employees.map(e => e.id);
        const [dtrRes, schedulesRes, statusesRes] = await Promise.all([
            this.supabaseService.getDtrEntriesForDateRange(startOfDayPSTIso, endOfDayPSTIso),
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
                 
                 const entryCount = todaysEntries.length;
                 const timeIn1 = entryCount > 0 ? new Date(todaysEntries[0].time_in!) : null;
                 const timeOut1 = (entryCount > 0 && todaysEntries[0].time_out) ? new Date(todaysEntries[0].time_out) : null;
                 const timeIn2 = (entryCount > 1 && todaysEntries[1].time_in) ? new Date(todaysEntries[1].time_in) : null;
                 const timeOut2 = (entryCount > 1 && todaysEntries[1].time_out) ? new Date(todaysEntries[1].time_out) : null;
                 
                 let firstPeriodSeconds = 0;
                 if (timeIn1 && timeOut1) {
                     firstPeriodSeconds = (timeOut1.getTime() - timeIn1.getTime()) / 1000;
                 }

                 if (entryCount === 0) {
                     status = 'Absent';
                 } else if (timeIn1 && !timeOut1) { // Clocked-in, before break
                     status = 'Timed In';
                     lastEventTime = timeIn1;
                     workDurationSeconds = (nowPST.getTime() - timeIn1.getTime()) / 1000;
                 } else if (timeOut1 && !timeIn2) { // On break
                     status = 'On Break';
                     lastEventTime = timeOut1;
                     workDurationSeconds = firstPeriodSeconds;
                     const elapsedBreak = (nowPST.getTime() - timeOut1.getTime()) / 1000;
                     breakTimeRemainingSeconds = 3600 - elapsedBreak;
                 } else if (timeIn2 && !timeOut2) { // Clocked-in, after break
                     const scheduledEndDateTime = new Date(`${todayStr}T${schedule.work_end_time}`);
                     const autoClockOutDateTime = new Date(scheduledEndDateTime.getTime() + (60 * 60 * 1000));

                     if (nowPST.getTime() > autoClockOutDateTime.getTime()) {
                         status = 'Timed Out';
                         lastEventTime = scheduledEndDateTime;
                         const secondPeriodSeconds = (scheduledEndDateTime.getTime() - timeIn2.getTime()) / 1000;
                         workDurationSeconds = firstPeriodSeconds + Math.max(0, secondPeriodSeconds);
                     } else {
                         status = 'Timed In';
                         lastEventTime = timeIn2;
                         const secondPeriodSeconds = (nowPST.getTime() - timeIn2.getTime()) / 1000;
                         workDurationSeconds = firstPeriodSeconds + secondPeriodSeconds;
                     }
                 } else if (timeOut2) { // Clocked out for the day
                     status = 'Timed Out';
                     lastEventTime = timeOut2;
                     const secondPeriodSeconds = (timeOut2.getTime() - timeIn2!.getTime()) / 1000;
                     workDurationSeconds = firstPeriodSeconds + secondPeriodSeconds;
                 } else {
                     status = 'Absent'; // Fallback for incomplete data
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
        this.dailyLogsError.set(e.message || 'Failed to load live data.');
    } finally {
        this.dailyLogsLoading.set(false);
    }
  }

  async loadDeletedEmployees(): Promise<void> {
    this.recoveryLoading.set(true);
    this.recoveryError.set(null);
    try {
      const { data, error } = await this.supabaseService.getDeletedUsersWithProfiles();
      if (error) throw error;
      this.deletedEmployees.set(data || []);
    } catch (e: any) {
      this.recoveryError.set(`Failed to load deleted employees: ${e.message}`);
    } finally {
      this.recoveryLoading.set(false);
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
  }
  
  refreshAllData(): void {
    this.loadInitialData();
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
  
  // --- Employee Selection ---
  toggleMultiSelectMode(): void {
    this.isMultiSelectMode.update(v => !v);
    if (!this.isMultiSelectMode()) {
      this.selectedEmployees.set(new Set());
    }
  }

  toggleEmployeeSelection(employeeId: string): void {
    this.selectedEmployees.update(currentSet => {
      const newSet = new Set(currentSet);
      if (newSet.has(employeeId)) {
        newSet.delete(employeeId);
      } else {
        newSet.add(employeeId);
      }
      return newSet;
    });
  }

  toggleAllEmployeeSelection(): void {
    const shouldSelectAll = !this.isAllEmployeesSelected();
    const filteredIds = new Set(this.filteredEmployees().map(e => e.id));
    
    if (shouldSelectAll) {
      this.selectedEmployees.set(filteredIds);
    } else {
      this.selectedEmployees.set(new Set());
    }
  }

  // --- Modal Management & Actions ---
  openAddEmployeeModal(): void {
    this.employeeToEdit.set(null);
    this.isAddEmployeeModalVisible.set(true);
  }

  openEditEmployeeModal(): void {
    const selectedIds = this.selectedEmployees();
    if (selectedIds.size !== 1) return;
    const employeeId = selectedIds.values().next().value;
    const employee = this.employees().find(e => e.id === employeeId);
    if (employee) {
      this.employeeToEdit.set(employee);
      this.isAddEmployeeModalVisible.set(true);
    }
  }
  
  openViewEmployeeModal(employee: Profile): void {
    this.selectedEmployeeForModal.set(employee);
    this.isViewEmployeeModalVisible.set(true);
  }
  
  openIdCardModal(employee: Profile): void {
    this.selectedEmployeeForModal.set(employee);
    this.isIdCardModalVisible.set(true);
  }

  openDtrExportModal(employee: Profile): void {
    this.selectedEmployeeForModal.set(employee);
    this.isDtrExportModalVisible.set(true);
  }
  
  openBulkIdCardModal(): void {
    this.isIdCardBulkViewModalVisible.set(true);
  }

  openBulkDtrExportModal(): void {
    this.isDtrBulkExportModalVisible.set(true);
  }

  openBulkDetailsModal(): void {
    this.isEmployeeDetailsBulkViewModalVisible.set(true);
  }

  closeEmployeeModal(): void {
    this.isAddEmployeeModalVisible.set(false);
    this.employeeToEdit.set(null);
  }

  openRunPayrollForPeriod(period: AvailablePayPeriod): void {
    this.selectedPayPeriod.set({ start: period.start, end: period.end });
    this.isRunPayrollModalVisible.set(true);
    this.isPayrollPeriodSelectorVisible.set(false);
  }

  closeRunPayrollModal(): void {
    this.isRunPayrollModalVisible.set(false);
    this.selectedPayPeriod.set(null);
  }

  // --- Employee Delete & Recovery Operation ---
  openDeleteConfirmation(): void {
    const count = this.selectedEmployees().size;
    if (count === 0) return;
    
    this.confirmModalConfig.set({
      title: `Delete ${count} Employee(s)?`,
      message: `Are you sure you want to delete ${count} employee(s)? Their records will be moved to the recovery tab where they can be restored or permanently deleted.`,
      onConfirm: () => this.handleDeleteEmployees(),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteEmployees(): Promise<void> {
    const userIds = [...this.selectedEmployees()];
    const { error } = await this.supabaseService.softDeleteUsers(userIds);
    if (error) {
      this.showNotification('error', `Error deleting employees: ${error.message}`);
    } else {
      this.showNotification('success', `${userIds.length} employee(s) have been deleted.`);
      this.loadEmployees();
      this.selectedEmployees.set(new Set());
    }
    this.isConfirmModalVisible.set(false);
  }
  
  async handleRecoverEmployee(employee: Profile): Promise<void> {
    const { error } = await this.supabaseService.recoverUsers([employee.id]);
    if (error) {
      this.showNotification('error', `Error recovering employee: ${error.message}`);
    } else {
      this.showNotification('success', `${employee.first_name} ${employee.last_name} has been recovered.`);
      this.loadDeletedEmployees();
    }
  }

  openPermanentDeleteConfirmation(employee: Profile): void {
    this.confirmModalConfig.set({
      title: 'Permanently Delete Employee?',
      message: `Are you sure you want to PERMANENTLY delete ${employee.first_name} ${employee.last_name}? This will remove their authentication account and all associated data. This action cannot be undone.`,
      onConfirm: () => this.handlePermanentDelete(employee),
    });
    this.isConfirmModalVisible.set(true);
  }
  
  async handlePermanentDelete(employee: Profile): Promise<void> {
    const { error } = await this.supabaseService.permanentlyDeleteUser(employee.id);
    if (error) {
       this.showNotification('error', `Error deleting: ${error.message}`);
    } else {
      this.showNotification('success', `${employee.first_name} ${employee.last_name} has been permanently deleted.`);
      this.loadDeletedEmployees();
    }
    this.isConfirmModalVisible.set(false);
  }
  
  
  async onPayrollStatusChange(payrollId: number, event: Event): Promise<void> {
    const newStatus = (event.target as HTMLSelectElement).value as 'Paid' | 'Delayed' | 'Unpaid';

    const originalPayrolls = this.payrolls();
    const payrollToUpdate = originalPayrolls.find(p => p.id === payrollId);
    if (!payrollToUpdate) return;
    this.payrolls.update(payrolls =>
      payrolls.map(p => (p.id === payrollId ? { ...p, status: newStatus } : p))
    );

    try {
      const { error } = await this.supabaseService.updatePayrollStatus(payrollId, newStatus);
      if (error) throw error;
      this.showNotification('success', `Payroll status updated to ${newStatus}.`);
    } catch (error: any) {
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

  // --- Time Clock Mode: Open in New Window ---
  openTimeClockWindow(): void {
    // The '/#/time-clock' path is used because the app uses hash-based routing.
    // The features string specifies the properties of the new window.
    const features = 'popup,width=1000,height=700,left=100,top=100';
    window.open('/#/time-clock', 'JeleneTradingTimeClock', features);
  }
}