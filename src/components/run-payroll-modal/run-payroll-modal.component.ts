import { Component, ChangeDetectionStrategy, input, output, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, DtrEntry, Payroll, SalaryRule, EmployeeSchedule } from '../../services/supabase.service';
import { CurrencyPipe, DatePipe } from '@angular/common';

interface PayrollPreview {
  employeeId: string;
  employeeName: string;
  daysWorked: number;
  totalHours: number;
  dailyRate: number;
  baseGrossPay: number;
  thirteenthMonthPay: number;
  birthMonthBonus: number;
  totalGrossPay: number;
  totalMinutesLate: number;
  totalMinutesEarly: number;
  latenessDeductions: number;
  earlyDepartureDeductions: number;
  manualDeductions: number;
  netPay: number;
  selected: boolean;
}

type ModalState = 'preview' | 'loading' | 'success' | 'error';

const GRACE_PERIOD_MINUTES = 15;
const DEDUCTION_RATE_PER_MINUTE = 1.60;

const BIRTH_MONTH_BONUS = {
  'branch officer': 1200,
  'team leader': 1000,
  'regular staff': 500,
} as const;


@Component({
  selector: 'app-run-payroll-modal',
  templateUrl: './run-payroll-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CurrencyPipe, DatePipe],
})
export class RunPayrollModalComponent {
  visible = input.required<boolean>();
  payPeriod = input<{start: Date, end: Date} | null>();
  close = output<void>();
  payrollRun = output<void>();
  
  private readonly supabaseService = inject(SupabaseService);
  
  modalState = signal<ModalState>('loading');
  errorMessage = signal<string | null>(null);

  // Preview State
  payrollPreviews = signal<PayrollPreview[]>([]);
  totalPayrollCost = computed(() => this.payrollPreviews().filter(p => p.selected).reduce((sum, p) => sum + p.netPay, 0));
  selectedEmployeesCount = computed(() => this.payrollPreviews().filter(p => p.selected).length);
  isAllSelected = computed(() => this.payrollPreviews().length > 0 && this.payrollPreviews().every(p => p.selected));

  constructor() {
    effect(() => {
      if (this.visible() && this.payPeriod()) {
        this.onGeneratePreview();
      } else if (!this.visible()) {
        this.resetState();
      }
    });
  }

  async onGeneratePreview(): Promise<void> {
    const period = this.payPeriod();
    if (!period) return;

    this.modalState.set('loading');
    this.errorMessage.set(null);
    this.payrollPreviews.set([]);
    
    try {
      const payrollStartDate = period.start;
      const payrollEndDate = period.end;
      
      const { data: employees, error: empError } = await this.supabaseService.getAllUsersWithProfiles();
      if (empError) throw empError;
      if (!employees || employees.length === 0) throw new Error('No active employees found.');

      const employeeIds = employees.map(e => e.id);

      // --- Determine date range for data fetching ---
      const currentYear = payrollEndDate.getFullYear();
      const yearStartDate = new Date(Date.UTC(currentYear, 0, 1));
      
      const { data: yearlyDtrEntries, error: dtrError } = await this.supabaseService.getDtrEntriesForDateRange(yearStartDate.toISOString(), payrollEndDate.toISOString());
      if (dtrError) throw dtrError;

      const { data: yearlySchedules, error: schedError } = await this.supabaseService.getSchedulesForDateRange(employeeIds, yearStartDate.toISOString().slice(0, 10), payrollEndDate.toISOString().slice(0, 10));
      if(schedError) throw schedError;

      const schedulesMap = new Map<string, EmployeeSchedule>();
      yearlySchedules?.forEach(s => schedulesMap.set(`${s.user_id}-${s.date}`, s));
      
      const previews: PayrollPreview[] = [];
      
      for (const emp of employees) {
        if (!emp.id || !emp.daily_rate) continue;
        
        const empDtr = yearlyDtrEntries?.filter(d => d.user_id === emp.id) || [];
        if (empDtr.length === 0) continue;
        
        // --- Calculations for current pay period ---
        let daysWorkedInPeriod = 0;
        let totalHoursInPeriod = 0;
        let totalMinutesLate = 0;
        let totalMinutesEarly = 0;

        const dtrByDay: Record<string, DtrEntry[]> = {};
        for (const dtr of empDtr) {
            if (dtr.time_in) {
                const entryDate = new Date(dtr.time_in);
                if (entryDate >= payrollStartDate && entryDate <= payrollEndDate) {
                    const day = entryDate.toISOString().slice(0, 10);
                    if (!dtrByDay[day]) dtrByDay[day] = [];
                    dtrByDay[day].push(dtr);
                }
            }
        }
        
        for (const dateKey of Object.keys(dtrByDay)) {
          const schedule = schedulesMap.get(`${emp.id}-${dateKey}`);
          if (!schedule) continue; // Skip days without a schedule

          const dailyEntries = dtrByDay[dateKey];
          dailyEntries.sort((a, b) => new Date(a.time_in!).getTime() - new Date(b.time_in!).getTime());

          let dailyWorkDurationHours = 0;
          dailyEntries.forEach(dtr => {
            if (dtr.time_in && dtr.time_out) {
              dailyWorkDurationHours += (new Date(dtr.time_out).getTime() - new Date(dtr.time_in).getTime()) / (1000 * 60 * 60);
            }
          });

          if (dailyWorkDurationHours < 8) continue;
          
          daysWorkedInPeriod++;
          totalHoursInPeriod += Math.min(dailyWorkDurationHours, 8); // Cap payable hours at 8

          const timeIn = new Date(dailyEntries[0].time_in!);
          const expectedStart = new Date(`${dateKey}T${schedule.work_start_time}Z`);
          if (timeIn.getTime() > expectedStart.getTime() + (GRACE_PERIOD_MINUTES * 60 * 1000)) {
            totalMinutesLate += Math.round((timeIn.getTime() - expectedStart.getTime()) / (1000 * 60));
          }
          
          if (dailyEntries[dailyEntries.length - 1].time_out) {
            const timeOut = new Date(dailyEntries[dailyEntries.length - 1].time_out!);
            const expectedEnd = new Date(`${dateKey}T${schedule.work_end_time}Z`);
            if (timeOut.getTime() < expectedEnd.getTime()) {
              totalMinutesEarly += Math.round((expectedEnd.getTime() - timeOut.getTime()) / (1000 * 60));
            }
          }
        }

        if (daysWorkedInPeriod === 0) continue;

        const baseGrossPay = daysWorkedInPeriod * emp.daily_rate;
        const latenessDeductions = totalMinutesLate * DEDUCTION_RATE_PER_MINUTE;
        const earlyDepartureDeductions = totalMinutesEarly * DEDUCTION_RATE_PER_MINUTE;

        // --- Bonus Calculations ---
        let birthMonthBonus = 0;
        if (emp.birth_date && emp.position) {
            const birthMonth = new Date(emp.birth_date).getUTCMonth();
            const payrollEndMonth = payrollEndDate.getUTCMonth();
            if (birthMonth === payrollEndMonth) {
                birthMonthBonus = BIRTH_MONTH_BONUS[emp.position as keyof typeof BIRTH_MONTH_BONUS] || 0;
            }
        }

        // 13th month is no longer a checkbox, so it's always 0 here.
        const thirteenthMonthPay = 0;

        const totalGrossPay = baseGrossPay + thirteenthMonthPay + birthMonthBonus;
        const netPay = totalGrossPay - latenessDeductions - earlyDepartureDeductions;
        
        previews.push({
          employeeId: emp.id,
          employeeName: `${emp.first_name} ${emp.last_name}`,
          daysWorked: daysWorkedInPeriod,
          totalHours: parseFloat(totalHoursInPeriod.toFixed(2)),
          dailyRate: emp.daily_rate,
          baseGrossPay: parseFloat(baseGrossPay.toFixed(2)),
          thirteenthMonthPay: parseFloat(thirteenthMonthPay.toFixed(2)),
          birthMonthBonus: parseFloat(birthMonthBonus.toFixed(2)),
          totalGrossPay: parseFloat(totalGrossPay.toFixed(2)),
          totalMinutesLate,
          totalMinutesEarly,
          latenessDeductions: parseFloat(latenessDeductions.toFixed(2)),
          earlyDepartureDeductions: parseFloat(earlyDepartureDeductions.toFixed(2)),
          manualDeductions: 0,
          netPay: parseFloat(netPay.toFixed(2)),
          selected: true,
        });
      }
      
      if (previews.length === 0) {
        this.errorMessage.set('No employees met payroll criteria for the selected period.');
        this.modalState.set('error');
        return;
      }
      
      this.payrollPreviews.set(previews);
      this.modalState.set('preview');

    } catch (error: any) {
      this.errorMessage.set(error.message || 'Failed to generate payroll preview.');
      this.modalState.set('error');
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
          const netPay = p.totalGrossPay - p.latenessDeductions - p.earlyDepartureDeductions - newManualDeduction;
          return { ...p, manualDeductions: newManualDeduction, netPay: parseFloat(netPay.toFixed(2)) };
        }
        return p;
      })
    );
  }

  async onConfirmRunPayroll(): Promise<void> {
    const period = this.payPeriod();
    if (!period) return;
    this.modalState.set('loading');
    this.errorMessage.set(null);
    
    try {
      const selectedPayrolls = this.payrollPreviews().filter(p => p.selected);
      
      const payrollsToInsert: Omit<Payroll, 'id' | 'created_at' | 'status'>[] = selectedPayrolls.map(p => ({
        user_id: p.employeeId,
        pay_period_start: period.start.toISOString(),
        pay_period_end: period.end.toISOString(),
        total_hours: p.totalHours,
        gross_pay: p.totalGrossPay,
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
      
    } catch (error: any) {
      this.errorMessage.set(error.message || 'Failed to run payroll.');
      this.modalState.set('preview');
    }
  }

  finishAndClose(): void {
    this.payrollRun.emit();
    this.closeModal();
  }

  closeModal(): void {
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('loading');
    this.errorMessage.set(null);
    this.payrollPreviews.set([]);
  }
}