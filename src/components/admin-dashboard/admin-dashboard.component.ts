import { Component, ChangeDetectionStrategy, inject, signal, effect, computed } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry, Payroll, Department } from '../../services/supabase.service';
import { AddEmployeeModalComponent } from '../add-employee-modal/add-employee-modal.component';
import { AddDepartmentModalComponent } from '../add-department-modal/add-department-modal.component';
import { RunPayrollModalComponent } from '../run-payroll-modal/run-payroll-modal.component';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';
import { DatePipe, CurrencyPipe } from '@angular/common';

type AdminTab = 'employees' | 'dtr' | 'payroll' | 'departments';

interface EnrichedProfile extends Profile {
  clockStatus: 'Clocked In' | 'Clocked Out';
  lastEventTimestamp: string | null;
}

interface DepartmentWithEmployees extends Department {
  employees: EnrichedProfile[];
}

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
}

@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddEmployeeModalComponent, AddDepartmentModalComponent, RunPayrollModalComponent, ConfirmationModalComponent, DatePipe, CurrencyPipe],
})
export class AdminDashboardComponent {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  readonly currentUserRole = this.supabaseService.currentUserRole;
  activeTab = signal<AdminTab>('employees');

  // Search functionality
  searchTerm = signal<string>('');

  employees = signal<Profile[]>([]);
  employeesLoading = signal(true);
  employeesError = signal<string | null>(null);
  
  filteredEmployees = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    if (!term) {
      return this.employees();
    }
    return this.employees().filter(emp =>
      (emp.first_name?.toLowerCase().includes(term)) ||
      (emp.last_name?.toLowerCase().includes(term)) ||
      (emp.email?.toLowerCase().includes(term)) ||
      (emp.id.toLowerCase().includes(term))
    );
  });

  dtrEntries = signal<(DtrEntry & { profiles: Profile })[]>([]);
  dtrLoading = signal(true);
  dtrError = signal<string | null>(null);
  
  payrolls = signal<(Payroll & { profiles: Profile })[]>([]);
  payrollsLoading = signal(true);
  payrollsError = signal<string | null>(null);

  departments = signal<Department[]>([]);
  departmentsLoading = signal(true);
  departmentsError = signal<string | null>(null);
  
  openDtrEntries = signal<DtrEntry[]>([]);
  openDtrLoading = signal(true);
  openDtrError = signal<string | null>(null);
  departmentsWithEmployees = signal<DepartmentWithEmployees[]>([]);
  
  isAddEmployeeModalVisible = signal(false);
  isAddDepartmentModalVisible = signal(false);
  isRunPayrollModalVisible = signal(false); 
  
  logoutError = signal<string | null>(null);
  
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
    }, { allowSignalWrites: true });

    effect(() => {
      const depts = this.departments();
      const emps = this.filteredEmployees(); // Use filtered employees
      const openDtrs = this.openDtrEntries();
      
      if (this.departmentsLoading() || this.employeesLoading() || this.openDtrLoading()) return;

      this.processAndGroupData(depts, emps, openDtrs);
    }, { allowSignalWrites: true });
  }

  loadInitialData(): void {
    this.loadDepartments();
    this.loadEmployees();
    this.loadOpenDtrEntries();
  }
  
  onSearchTermChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchTerm.set(value);
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
  
  async loadOpenDtrEntries(): Promise<void> {
    this.openDtrLoading.set(true);
    this.openDtrError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllOpenDtrEntries();
      if (error) throw error;
      this.openDtrEntries.set(data || []);
    } catch (e: any) {
      this.openDtrError.set(`Failed to load clock-in status: ${e.message}`);
    } finally {
      this.openDtrLoading.set(false);
    }
  }

  processAndGroupData(departments: Department[], employees: Profile[], openDtrEntries: DtrEntry[]): void {
    const openDtrMap = new Map<string, DtrEntry>(
      openDtrEntries.map(dtr => [dtr.user_id, dtr])
    );

    const enrichedEmployees = employees.map(emp => {
      const openDtr = openDtrMap.get(emp.id);
      return {
        ...emp,
        clockStatus: openDtr ? 'Clocked In' : 'Clocked Out',
        lastEventTimestamp: openDtr ? openDtr.time_in : null,
      } as EnrichedProfile;
    });

    const groupedData = departments.map(dept => ({
      ...dept,
      employees: enrichedEmployees.filter(emp => emp.position === dept.name)
    }));
    
    this.departmentsWithEmployees.set(groupedData);
  }
  
  refreshAllData(): void {
    this.loadInitialData();
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
      onConfirm: () => this.handleDeleteEmployee(employee.id),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteEmployee(id: string): Promise<void> {
    const { error } = await this.supabaseService.updateUserProfile(id, { status: 'inactive' });
    if (error) {
      alert(`Error deactivating employee: ${error.message}`);
    } else {
      this.loadEmployees();
    }
    this.isConfirmModalVisible.set(false);
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
