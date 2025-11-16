import { Component, ChangeDetectionStrategy, input, output, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, DtrEntry, Payroll, Department, SalaryRule } from '../../services/supabase.service';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { SalaryAdjustmentModalComponent } from '../salary-adjustment-modal/salary-adjustment-modal.component';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';

interface PayrollPreview {
  employeeId: string;
  employeeName: string;
  daysWorked: number;
  totalHours: number;
  dailyRate: number;
  baseGrossPay: number;
  adjustmentAmount: number;
  grossPay: number; // baseGrossPay + adjustmentAmount
  totalMinutesLate: number;
  totalMinutesEarly: number;
  latenessDeductions: number;
  earlyDepartureDeductions: number;
  manualDeductions: number;
  netPay: number;
  selected: boolean;
  appliedRules: string[];
}

interface ConfirmModalConfig {
  title: string;
  message: string;
  onConfirm: () => void;
}

type ModalState = 'config' | 'preview' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-run-payroll-modal',
  templateUrl: './run-payroll-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CurrencyPipe, DatePipe, SalaryAdjustmentModalComponent, ConfirmationModalComponent],
})
export class RunPayrollModalComponent {
  visible = input.required<boolean>();
  departments = input.required<Department[]>();
  close = output<void>();
  payrollRun = output<void>();
  
  private readonly supabaseService = inject(SupabaseService);
  
  modalState = signal<ModalState>('config');
  errorMessage = signal<string | null>(null);

  // Config State
  startDate = signal<string>('');
  endDate = signal<string>('');
  applyAdjustments = signal(false);
  
  // Preview State
  payrollPreviews = signal<PayrollPreview[]>([]);
  totalPayrollCost = computed(() => this.payrollPreviews().filter(p => p.selected).reduce((sum, p) => sum + p.netPay, 0));
  selectedEmployeesCount = computed(() => this.payrollPreviews().filter(p => p.selected).length);
  isAllSelected = computed(() => this.payrollPreviews().length > 0 && this.payrollPreviews().every(p => p.selected));

  // Salary Rules State
  salaryRules = signal<SalaryRule[]>([]);
  salaryRulesLoading = signal(true);
  salaryRulesError = signal<string | null>(null);

  // Modals State
  isSalaryAdjustmentModalVisible = signal(false);
  adjustmentToEdit = signal<SalaryRule | null>(null);
  isConfirmModalVisible = signal(false);
  confirmModalConfig = signal<ConfirmModalConfig>({ title: '', message: '', onConfirm: () => {} });

  isConfigValid = computed(() => {
    return this.startDate() && this.endDate() && this.startDate() <= this.endDate();
  });

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.loadSalaryRules();
      }
    });
  }

  async loadSalaryRules(): Promise<void> {
    this.salaryRulesLoading.set(true);
    this.salaryRulesError.set(null);
    try {
      const { data, error } = await this.supabaseService.getAllSalaryRules();
      if (error) throw error;
      this.salaryRules.set(data || []);
    } catch (e: any) {
      this.salaryRulesError.set(`Failed to load salary rules: ${e.message}`);
    } finally {
      this.salaryRulesLoading.set(false);
    }
  }

  async onGeneratePreview(): Promise<void> {
    if (!this.isConfigValid()) {
      this.errorMessage.set('Please select a valid start and end date.');
      return;
    }
    
    this.modalState.set('loading');
    this.errorMessage.set(null);
    this.payrollPreviews.set([]);
    
    try {
      const start = new Date(this.startDate());
      const end = new Date(this.endDate());
      end.setDate(end.getDate() + 1); // Include the whole end day
      
      const { data: employees, error: empError } = await this.supabaseService.getAllUsersWithProfiles();
      if (empError) throw empError;
      
      const { data: dtrEntries, error: dtrError } = await this.supabaseService.getDtrEntriesForDateRange(start.toISOString(), end.toISOString());
      if (dtrError) throw dtrError;

      let activeAdjustments: SalaryRule[] = [];
      if (this.applyAdjustments()) {
        const { data: adjustments, error: adjError } = await this.supabaseService.getActiveSalaryRules();
        if(adjError) throw adjError;
        activeAdjustments = adjustments || [];
      }

      if (!employees || employees.length === 0) {
        throw new Error('No active employees found to run payroll for.');
      }
      
      const previews: PayrollPreview[] = [];
      
      for (const emp of employees) {
        if (!emp.id || !emp.daily_rate) continue;
        
        const empDtr = dtrEntries?.filter(d => d.user_id === emp.id) || [];
        if (empDtr.length === 0) continue;
        
        const department = emp.departments;

        let totalHours = 0;
        
        // FIX: Correctly type the initial value for the reduce function to ensure `dtrByDay` is properly typed. This resolves downstream type errors on `dailyEntries`.
        const dtrByDay = empDtr.reduce((acc, dtr) => {
          if (dtr.time_in) {
            const day = dtr.time_in.substring(0, 10);
            if (!acc[day]) acc[day] = [];
            acc[day].push(dtr);
          }
          return acc;
        }, {} as Record<string, DtrEntry[]>);

        const daysWorked = Object.keys(dtrByDay).length;
        if (daysWorked === 0) continue;

        const baseGrossPay = daysWorked * emp.daily_rate;
        let adjustmentAmount = 0;
        let totalMinutesLate = 0;
        let totalMinutesEarly = 0;
        const appliedRules = new Set<string>();
        
        Object.values(dtrByDay).forEach((dailyEntries) => {
          dailyEntries.sort((a, b) => new Date(a.time_in!).getTime() - new Date(b.time_in!).getTime());
          const firstEntry = dailyEntries[0];
          const lastEntry = dailyEntries[dailyEntries.length - 1];

          // --- Calculate Adjustments for the day ---
          if (this.applyAdjustments()) {
            const currentDate = new Date(firstEntry.time_in!);
            const applicableRules = activeAdjustments.filter(rule => {
              const ruleStart = new Date(rule.start_date);
              const ruleEnd = new Date(rule.end_date);
              return currentDate >= ruleStart && currentDate <= ruleEnd;
            });

            if (applicableRules.length > 0) {
              // Get the highest percentage raise if multiple rules apply
              const highestRaise = Math.max(...applicableRules.map(r => r.raise_percentage));
              const bestRule = applicableRules.find(r => r.raise_percentage === highestRaise)!;

              adjustmentAmount += emp.daily_rate * (bestRule.raise_percentage / 100);
              appliedRules.add(bestRule.name);
            }
          }

          // --- Calculate Total Hours & Deductions ---
          dailyEntries.forEach(dtr => {
            if (dtr.time_in && dtr.time_out) {
              totalHours += (new Date(dtr.time_out).getTime() - new Date(dtr.time_in).getTime()) / (1000 * 60 * 60);
            }
          });

          if (department?.work_start_time && firstEntry.time_in) {
            const timeIn = new Date(firstEntry.time_in);
            const [h, m, s] = department.work_start_time.split(':').map(Number);
            const expectedStart = new Date(timeIn);
            expectedStart.setHours(h, m, s, 0);
            const gracePeriodMs = (department.grace_period_minutes || 0) * 60 * 1000;
            if (timeIn.getTime() > expectedStart.getTime() + gracePeriodMs) {
              const lateDiffMs = timeIn.getTime() - expectedStart.getTime();
              totalMinutesLate += Math.round(lateDiffMs / (1000 * 60));
            }
          }
          
          if (department?.work_end_time && lastEntry.time_out) {
            const timeOut = new Date(lastEntry.time_out);
            const [h, m, s] = department.work_end_time.split(':').map(Number);
            const expectedEnd = new Date(timeOut);
            expectedEnd.setHours(h, m, s, 0);
            if (timeOut.getTime() < expectedEnd.getTime()) {
              const earlyDiffMs = expectedEnd.getTime() - timeOut.getTime();
              totalMinutesEarly += Math.round(earlyDiffMs / (1000 * 60));
            }
          }
        });

        const deductionRate = department?.deduction_rate_per_minute || 0;
        const latenessDeductions = totalMinutesLate * deductionRate;
        const earlyDepartureDeductions = totalMinutesEarly * deductionRate;
        const grossPay = baseGrossPay + adjustmentAmount;
        const netPay = grossPay - latenessDeductions - earlyDepartureDeductions;
        
        previews.push({
          employeeId: emp.id,
          employeeName: `${emp.first_name} ${emp.last_name}`,
          daysWorked,
          totalHours: parseFloat(totalHours.toFixed(2)),
          dailyRate: emp.daily_rate,
          baseGrossPay: parseFloat(baseGrossPay.toFixed(2)),
          adjustmentAmount: parseFloat(adjustmentAmount.toFixed(2)),
          grossPay: parseFloat(grossPay.toFixed(2)),
          totalMinutesLate,
          totalMinutesEarly,
          latenessDeductions: parseFloat(latenessDeductions.toFixed(2)),
          earlyDepartureDeductions: parseFloat(earlyDepartureDeductions.toFixed(2)),
          manualDeductions: 0,
          netPay: parseFloat(netPay.toFixed(2)),
          selected: true,
          appliedRules: Array.from(appliedRules),
        });
      }
      
      if (previews.length === 0) {
        this.errorMessage.set('No work hours recorded for any employee in the selected period.');
        this.modalState.set('config');
        return;
      }
      
      this.payrollPreviews.set(previews);
      this.modalState.set('preview');

    } catch (error: any) {
      this.errorMessage.set(error.message || 'Failed to generate payroll preview.');
      this.modalState.set('config');
    }
  }
  
  toggleSelectAll(): void {
    const newSelectedState = !this.isAllSelected();
    this.payrollPreviews.update(previews => 
        previews.map(p => ({ ...p, selected: newSelectedState }))
    );
  }

  toggleEmployeeSelection(employeeId: string): void {
      this.payrollPreviews.update(previews =>
          previews.map(p => p.employeeId === employeeId ? { ...p, selected: !p.selected } : p)
      );
  }

  updateManualDeduction(employeeId: string, event: Event): void {
    const newManualDeduction = parseFloat((event.target as HTMLInputElement).value);
    if (isNaN(newManualDeduction) || newManualDeduction < 0) return;
    
    this.payrollPreviews.update(previews => 
      previews.map(p => {
        if (p.employeeId === employeeId) {
          const netPay = p.grossPay - p.latenessDeductions - p.earlyDepartureDeductions - newManualDeduction;
          return { ...p, manualDeductions: newManualDeduction, netPay: parseFloat(netPay.toFixed(2)) };
        }
        return p;
      })
    );
  }

  async onConfirmRunPayroll(): Promise<void> {
    this.modalState.set('loading');
    this.errorMessage.set(null);
    
    try {
      const selectedPayrolls = this.payrollPreviews().filter(p => p.selected);
      
      const payrollsToInsert: Omit<Payroll, 'id' | 'created_at' | 'status'>[] = selectedPayrolls.map(p => ({
        user_id: p.employeeId,
        pay_period_start: new Date(this.startDate()).toISOString(),
        pay_period_end: new Date(this.endDate()).toISOString(),
        total_hours: p.totalHours,
        gross_pay: p.grossPay,
        lateness_minutes: p.totalMinutesLate,
        early_departure_minutes: p.totalMinutesEarly,
        lateness_deductions: p.latenessDeductions,
        early_departure_deductions: p.earlyDepartureDeductions,
        manual_deductions: p.manualDeductions,
        net_pay: p.netPay,
      }));
      
      if (payrollsToInsert.length === 0) {
        this.errorMessage.set('No employees selected to run payroll for.');
        this.modalState.set('preview');
        return;
      }
      
      const { error } = await this.supabaseService.runPayrollForEmployees(payrollsToInsert);
      if (error) throw error;
      
      this.modalState.set('success');
      this.payrollRun.emit();
      
    } catch (error: any) {
      this.errorMessage.set(error.message || 'Failed to run payroll.');
      this.modalState.set('preview');
    }
  }

  // --- Salary Rule Modal Management ---
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

  openDeleteSalaryRuleConfirmation(rule: SalaryRule): void {
    this.confirmModalConfig.set({
      title: 'Delete Salary Rule?',
      message: `Are you sure you want to delete the "${rule.name}" rule? This action cannot be undone.`,
      onConfirm: () => this.handleDeleteSalaryRule(rule.id),
    });
    this.isConfirmModalVisible.set(true);
  }

  async handleDeleteSalaryRule(id: number): Promise<void> {
    const { error } = await this.supabaseService.deleteSalaryRule(id);
    if (error) {
      alert(`Error deleting salary rule: ${error.message}`);
    } else {
      this.loadSalaryRules();
    }
    this.isConfirmModalVisible.set(false);
  }


  goBackToConfig(): void {
    this.modalState.set('config');
    this.errorMessage.set(null);
    this.payrollPreviews.set([]);
  }

  closeModal(): void {
    this.resetState();
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('config');
    this.errorMessage.set(null);
    this.startDate.set('');
    this.endDate.set('');
    this.applyAdjustments.set(false);
    this.payrollPreviews.set([]);
  }
}
