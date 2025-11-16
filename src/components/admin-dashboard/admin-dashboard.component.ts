import { Component, ChangeDetectionStrategy, inject, signal, effect, computed } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry, Payroll, Department, SalaryRule } from '../../services/supabase.service';
import { AddEmployeeModalComponent } from '../add-employee-modal/add-employee-modal.component';
import { AddDepartmentModalComponent } from '../add-department-modal/add-department-modal.component';
import { RunPayrollModalComponent } from '../run-payroll-modal/run-payroll-modal.component';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { ViewEmployeeModalComponent } from '../view-employee-modal/view-employee-modal.component';
import { IdCardModalComponent } from '../id-card-modal/id-card-modal.component';

type AdminTab = 'employees' | 'dtr' | 'payroll' | 'departments' | 'analytics';

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface AnalyticsReport {
  absentCount: number;
  lateCount: number;
  earlyCount: number;
  lateByDay: { day: number; count: number }[];
  maxLateCount: number;
}

interface DtrGroup {
  monthYearDisplay: string; // e.g., "October 2025"
  monthYearValue: string; // e.g., "2025-10" for unique key
  entries: (DtrEntry & { profiles: Profile })[];
}


@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AddEmployeeModalComponent, 
    AddDepartmentModalComponent, 
    RunPayrollModalComponent, 
    ConfirmationModalComponent, 
    ViewEmployeeModalComponent,
    IdCardModalComponent,
    DatePipe, 
    CurrencyPipe
  ],
})
export class AdminDashboardComponent {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  readonly currentUserRole = this.supabaseService.currentUserRole;
  activeTab = signal<AdminTab>('employees');
  isSidebarOpen = signal(false);

  // Employee Search & Sort
  searchTerm = signal<string>('');
  employeeSortOption = signal<'newest' | 'oldest' | 'lastNameAsc' | 'lastNameDesc'>('newest');

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
      (emp.email?.toLowerCase().includes(term))
    );

    return filtered.sort((a, b) => {
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
  });

  // DTR Signals
  dtrSearchTerm = signal<string>('');
  dtrSortOption = signal<'newest' | 'oldest' | 'nameAsc' | 'nameDesc'>('newest');
  dtrEntries = signal<(DtrEntry & { profiles: Profile })[]>([]);
  dtrLoading = signal(true);
  dtrError = signal<string | null>(null);
  openDtrMonths = signal(new Set<string>()); // To track open accordions
  
  groupedDtrEntries = computed<DtrGroup[]>(() => {
    const term = this.dtrSearchTerm().toLowerCase().trim();
    const sortOption = this.dtrSortOption();
    const allEntries = this.dtrEntries();

    if (!allEntries.length) {
      return [];
    }

    // 1. Group entries by month
    // FIX: Correctly type the initial value for the reduce function to ensure `groups` is properly typed as `Record<string, DtrGroup>`. This resolves downstream type errors.
    const groups = allEntries.reduce((acc, entry) => {
      const date = new Date(entry.time_in!);
      const monthYearValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!acc[monthYearValue]) {
        acc[monthYearValue] = {
          monthYearDisplay: date.toLocaleString('default', { month: 'long', year: 'numeric' }),
          monthYearValue: monthYearValue,
          entries: []
        };
      }
      acc[monthYearValue].entries.push(entry);
      return acc;
    }, {} as Record<string, DtrGroup>);

    // 2. Convert to array and sort groups (newest first)
    const sortedGroups = Object.values(groups).sort((a, b) => b.monthYearValue.localeCompare(a.monthYearValue));

    // 3. Filter and sort entries within each group
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
    });
  });

  payrolls = signal<(Payroll & { profiles: Profile })[]>([]);
  payrollsLoading = signal(true);
  payrollsError = signal<string | null>(null);

  departments = signal<Department[]>([]);
  departmentsLoading = signal(true);
  departmentsError = signal<string | null>(null);

  // --- Analytics Signals ---
  analyticsMonth = signal<string>(new Date().toISOString().slice(0, 7)); // YYYY-MM format
  analyticsLoading = signal(false);
  analyticsError = signal<string | null>(null);
  dtrEntriesForAnalytics = signal<DtrEntry[]>([]);

  monthsForSelector = computed(() => {
    const months = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const monthStr = month < 10 ? `0${month}` : month.toString();
      months.push({
        value: `${year}-${monthStr}`,
        label: d.toLocaleString('default', { month: 'long', year: 'numeric' })
      });
      d.setMonth(d.getMonth() - 1);
    }
    return months;
  });
  
  totalEmployees = computed(() => this.employees().length);

  analyticsReport = computed<AnalyticsReport>(() => {
    const employees = this.employees();
    const dtrEntries = this.dtrEntriesForAnalytics();
    const departments = this.departments();
    const monthStr = this.analyticsMonth();

    if (!employees.length || !monthStr || !departments.length) {
      return { absentCount: 0, lateCount: 0, earlyCount: 0, lateByDay: [], maxLateCount: 0 };
    }

    const [year, month] = monthStr.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    
    const absentEmployees = new Set<string>();
    const lateEmployees = new Set<string>();
    const earlyLeavers = new Set<string>();
    const lateByDay = new Map<number, number>();

    const departmentsMap = new Map(departments.map(d => [d.id, d]));

    const isWeekend = (date: Date) => {
        const day = date.getDay();
        return day === 0 || day === 6;
    };

    // Calculate absent employees (no DTR entries for the entire month)
    for (const emp of employees) {
      const hasAnyDtrInMonth = dtrEntries.some(dtr => dtr.user_id === emp.id);
      if (!hasAnyDtrInMonth) {
        absentEmployees.add(emp.id);
      }
    }

    // Calculate daily metrics for working days
    for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, month - 1, day);
        if (isWeekend(currentDate)) continue;

        lateByDay.set(day, 0); // Initialize count for the working day

        for (const emp of employees) {
            const empDtrForDay = dtrEntries.filter(dtr => dtr.user_id === emp.id && new Date(dtr.time_in!).getDate() === day);

            if (empDtrForDay.length > 0) {
              const firstEntry = empDtrForDay[0];
              const lastEntry = empDtrForDay[empDtrForDay.length - 1];

              const department = emp.departments;

              if (department) {
                  // Check for lateness on first entry
                  if (department.work_start_time && firstEntry.time_in) {
                      const timeIn = new Date(firstEntry.time_in);
                      const [h, m, s] = department.work_start_time.split(':').map(Number);
                      const expectedStart = new Date(timeIn);
                      expectedStart.setHours(h, m, s, 0);
                      const gracePeriodMs = (department.grace_period_minutes || 0) * 60 * 1000;
                      if (timeIn.getTime() > expectedStart.getTime() + gracePeriodMs) {
                          lateEmployees.add(emp.id);
                          lateByDay.set(day, (lateByDay.get(day) || 0) + 1);
                      }
                  }
                  // Check for early leave on last entry
                  if (department.work_end_time && lastEntry.time_out) {
                      const timeOut = new Date(lastEntry.time_out);
                      const [h, m, s] = department.work_end_time.split(':').map(Number);
                      const expectedEnd = new Date(timeOut);
                      expectedEnd.setHours(h, m, s, 0);
                      if (timeOut.getTime() < expectedEnd.getTime()) {
                          earlyLeavers.add(emp.id);
                      }
                  }
              }
            }
        }
    }
    
    const lateByDayArray = Array.from(lateByDay.entries())
                                  .map(([day, count]) => ({ day, count }))
                                  .sort((a, b) => a.day - b.day);

    return {
        absentCount: absentEmployees.size,
        lateCount: lateEmployees.size,
        earlyCount: earlyLeavers.size,
        lateByDay: lateByDayArray,
        maxLateCount: Math.max(1, ...lateByDayArray.map(d => d.count)) // use 1 to avoid division by zero
    };
  });

  isAddEmployeeModalVisible = signal(false);
  isAddDepartmentModalVisible = signal(false);
  isRunPayrollModalVisible = signal(false); 
  isIdCardModalVisible = signal(false);
  isViewEmployeeModalVisible = signal(false);
  
  logoutError = signal<string | null>(null);
  
  selectedEmployee = signal<Profile | null>(null);
  employeeToEdit = signal<Profile | null>(null);
  departmentToEdit = signal<Department | null>(null);
  
  isConfirmModalVisible = signal(false);
  confirmModalConfig = signal<ConfirmModalConfig>({ title: '', message: '', onConfirm: () => {} });

  constructor() {
    this.loadInitialData();

    effect(() => {
      const tab = this.activeTab();
      if (tab === 'dtr' && this.dtrEntries().length === 0) this.loadDtrEntries();
      if (tab === 'payroll' && this.payrolls().length === 0) this.loadPayrolls();
      if (tab === 'analytics') this.loadDtrForAnalyticsMonth();
    }, { allowSignalWrites: true });
    
    effect(() => {
      this.analyticsMonth();
      if(this.activeTab() === 'analytics') {
          this.loadDtrForAnalyticsMonth();
      }
    });
  }

  loadInitialData(): void {
    this.loadDepartments();
    this.loadEmployees();
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

  setAnalyticsMonth(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.analyticsMonth.set(value);
  }

  setActiveTab(tab: AdminTab): void {
    this.activeTab.set(tab);
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

  async loadDtrEntries(): Promise<void> {
    this.dtrLoading.set(true);
    this.dtrError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllDtrEntries();
      if (error) throw error;
      this.dtrEntries.set(data || []);
    } catch (e: any) {
      this.dtrError.set(`Failed to load DTR entries: ${e.message}`);
    } finally {
      this.dtrLoading.set(false);
    }
  }
  
  async loadDtrForAnalyticsMonth(): Promise<void> {
    this.analyticsLoading.set(true);
    this.analyticsError.set(null);
    try {
      const [year, month] = this.analyticsMonth().split('-').map(Number);
      const startDate = new Date(year, month - 1, 1).toISOString();
      const endDate = new Date(year, month, 1).toISOString();
      
      const { data, error } = await this.supabaseService.getDtrEntriesForDateRange(startDate, endDate);
      if (error) throw error;
      this.dtrEntriesForAnalytics.set(data || []);
    } catch (e: any) {
      this.analyticsError.set(`Failed to load analytics data: ${e.message}`);
    } finally {
      this.analyticsLoading.set(false);
    }
  }

  async loadPayrolls(): Promise<void> {
    this.payrollsLoading.set(true);
    this.payrollsError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllPayrolls();
      if (error) throw error;
      this.payrolls.set(data || []);
    } catch (e: any) {
      this.payrollsError.set(`Failed to load payrolls: ${e.message}`);
    } finally {
      this.payrollsLoading.set(false);
    }
  }

  refreshPayrolls(): void {
    this.loadPayrolls();
  }
  
  async loadDepartments(): Promise<void> {
    this.departmentsLoading.set(true);
    this.departmentsError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllDepartments();
      if (error) throw error;
      this.departments.set(data || []);
    } catch (e: any) {
      this.departmentsError.set(`Failed to load departments: ${e.message}`);
    } finally {
      this.departmentsLoading.set(false);
    }
  }

  refreshAllData(): void {
    this.loadInitialData();
  }
  
  toggleDtrMonth(monthYearValue: string): void {
    this.openDtrMonths.update(currentSet => {
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

  openAddDepartmentModal(): void {
    this.departmentToEdit.set(null);
    this.isAddDepartmentModalVisible.set(true);
  }

  openEditDepartmentModal(department: Department): void {
    this.departmentToEdit.set(department);
    this.isAddDepartmentModalVisible.set(true);
  }

  closeDepartmentModal(): void {
    this.isAddDepartmentModalVisible.set(false);
    this.departmentToEdit.set(null);
  }
  
  // --- Delete Operations ---
  openDeleteDepartmentConfirmation(dept: Department): void {
    this.confirmModalConfig.set({
      title: 'Delete Department?',
      message: `Are you sure you want to delete the "${dept.name}" department? This action cannot be undone.`,
      onConfirm: () => this.handleDeleteDepartment(dept.id),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteDepartment(id: number): Promise<void> {
    const { error } = await this.supabaseService.deleteDepartment(id);
    if (error) {
      alert(`Error deleting department: ${error.message}`);
    } else {
      this.loadDepartments();
    }
    this.isConfirmModalVisible.set(false);
  }

  openDeleteEmployeeConfirmation(employee: Profile): void {
    this.confirmModalConfig.set({
      title: 'Deactivate Employee?',
      message: `Are you sure you want to deactivate ${employee.first_name} ${employee.last_name}? Their data will be saved, but they will be hidden from active lists.`,
      onConfirm: () => this.handleDeactivateEmployee(employee.id),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeactivateEmployee(id: string): Promise<void> {
    const { error } = await this.supabaseService.updateUserProfile(id, { status: 'inactive' });
    if (error) {
      alert(`Error deactivating employee: ${error.message}`);
    } else {
      this.loadEmployees();
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
      // Success: UI is already updated, do nothing.
    } catch (error: any) {
      // 3. Revert on failure
      alert(`Failed to update status: ${error.message}. Reverting change.`);
      this.payrolls.set(originalPayrolls);
    }
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
