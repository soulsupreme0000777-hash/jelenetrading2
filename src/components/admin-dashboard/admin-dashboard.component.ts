import { Component, ChangeDetectionStrategy, inject, signal, effect, computed, OnDestroy, viewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry, Payroll, SalaryRule, EmployeeStatus } from '../../services/supabase.service';
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

interface AnalyticsReport {
  absentCount: number;
  lateCount: number;
  earlyCount: number;
  lateByDay: { day: number; count: number }[];
  maxLateCount: number;
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

const BIRTH_MONTH_BONUS = {
  'branch officer': 1200,
  'team leader': 1000,
  'regular staff': 500,
} as const;

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
  lastScanResult = signal<{ profile: Profile; dtrEntry: DtrEntry; type: 'in' | 'out' } | null>(null);

  private stream: MediaStream | null = null;
  private isScanning = false;
  private scanResultTimer: any;

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
    // This calculation is now incorrect due to schedule changes.
    // It should be updated to fetch daily schedules.
    // For now, it will produce inaccurate results.
    return { absentCount: 0, lateCount: 0, earlyCount: 0, lateByDay: [], maxLateCount: 0 };
  });

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
      
      if (this.realtimeChannel) {
        this.supabaseService.unsubscribe(this.realtimeChannel);
      }
      this.realtimeChannel = this.supabaseService.subscribeToTableChanges(() => {
        const currentTab = this.activeTab();
        if (currentTab === 'employees') {
            this.loadEmployees();
        } else if (currentTab === 'dtr') {
            this.loadDtrAndPayrolls();
        }
      });

      onCleanup(() => {
        if(this.realtimeChannel) this.supabaseService.unsubscribe(this.realtimeChannel);
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

  async exportDtrPeriodToCsv(group: DtrPayPeriodGroup): Promise<void> {
    this.showNotification('success', 'Generating CSV export...');
    const periodStartStr = group.payPeriodStart.toISOString().slice(0, 10);
    
    // Find all payroll records for this specific period start date
    const payrollsForPeriod = this.payrolls().filter(p => p.pay_period_start.startsWith(periodStartStr));

    if (payrollsForPeriod.length === 0) {
        this.showNotification('error', 'No payroll data found for this period to export.');
        return;
    }

    const csvRows = [];
    // Headers
    const headers = [
        'Employee ID', 'Full Name', 'Late Arrivals (mins)', 
        'Early Departures (mins)', 'Birth Month Bonus (PHP)', 'Net Pay (PHP)'
    ];
    csvRows.push(headers.join(','));

    // Data rows
    for (const payroll of payrollsForPeriod) {
        const empProfile = payroll.profiles;
        if (!empProfile) continue;

        let birthMonthBonus = 0;
        if (empProfile.birth_date && empProfile.position) {
            const birthMonth = new Date(empProfile.birth_date).getUTCMonth();
            const payrollEndMonth = new Date(payroll.pay_period_end).getUTCMonth();
            if (birthMonth === payrollEndMonth) {
                birthMonthBonus = BIRTH_MONTH_BONUS[empProfile.position as keyof typeof BIRTH_MONTH_BONUS] || 0;
            }
        }
        
        const row = [
            `"${empProfile.employee_id || ''}"`,
            `"${empProfile.first_name || ''} ${empProfile.middle_name || ''} ${empProfile.last_name || ''}"`,
            payroll.lateness_minutes,
            payroll.early_departure_minutes,
            birthMonthBonus,
            payroll.net_pay
        ];
        csvRows.push(row.join(','));
    }

    const csvContent = "data:text/csv;charset=utf-8," + csvRows.join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const fileName = `payroll_export_${group.id}.csv`;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
    }
    const videoEl = this.video()?.nativeElement;
    if (videoEl) {
        videoEl.srcObject = null;
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
    
    if (this.scanResultTimer) {
        clearTimeout(this.scanResultTimer);
    }

    try {
        const parsedData = JSON.parse(qrData);
        if (!parsedData.userId) {
            throw new Error('Invalid QR code format.');
        }
        
        const { profile, dtrEntry } = await this.supabaseService.handleQrCodeLogin(parsedData.userId);

        this.lastScanResult.set({
            profile,
            dtrEntry,
            type: dtrEntry.time_out ? 'out' : 'in',
        });
        
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