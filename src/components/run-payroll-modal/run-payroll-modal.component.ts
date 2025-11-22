import { Component, ChangeDetectionStrategy, input, output, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, DtrEntry, Payroll, SalaryRule, EmployeeSchedule, EmployeeStatus } from '../../services/supabase.service';
import { CurrencyPipe, DatePipe } from '@angular/common';

interface PayrollPreview {
  employeeId: string;
  employeeName: string;
  daysWorked: number;
  leaveDays: number;
  totalHours: number;
  dailyRate: number;
  baseGrossPay: number;
  salaryRaise: number;
  birthMonthBonus: number;
  raiseDetails: { name: string; amount: number }[];
  totalGrossPay: number;
  totalMinutesLate: number;
  totalMinutesUnderTime: number;
  latenessDeductions: number;
  underTimeDeductions: number;
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

      const [dtrRes, schedulesRes, salaryRulesRes, statusesRes] = await Promise.all([
          this.supabaseService.getDtrEntriesForDateRange(payrollStartDate.toISOString(), payrollEndDate.toISOString()),
          this.supabaseService.getSchedulesForDateRange(employeeIds, payrollStartDate.toISOString().slice(0, 10), payrollEndDate.toISOString().slice(0, 10)),
          this.supabaseService.getActiveSalaryRules(),
          this.supabaseService.getAllStatusesForDateRange(employeeIds, payrollStartDate.toISOString().slice(0, 10), payrollEndDate.toISOString().slice(0, 10))
      ]);

      if (dtrRes.error) throw dtrRes.error;
      const dtrEntries = dtrRes.data || [];
      
      if (schedulesRes.error) throw schedulesRes.error;
      const schedules = schedulesRes.data || [];
      
      if(salaryRulesRes.error) throw salaryRulesRes.error;
      const activeSalaryRules = salaryRulesRes.data || [];

      if (statusesRes.error) throw statusesRes.error;
      const leaveStatuses = statusesRes.data || [];

      const schedulesMap = new Map<string, EmployeeSchedule>();
      schedules.forEach(s => schedulesMap.set(`${s.user_id}|${s.date}`, s));

      const leaveMap = new Map<string, EmployeeStatus>();
      leaveStatuses.forEach(s => leaveMap.set(`${s.user_id}|${s.date}`, s));
      
      const previews: PayrollPreview[] = [];
      
      for (const emp of employees) {
        if (!emp.id || !emp.daily_rate) continue;
        
        const empDtr = dtrEntries.filter(d => d.user_id === emp.id);
        
        const dtrByDay: Record<string, DtrEntry[]> = {};
        empDtr.forEach(dtr => {
            if (dtr.time_in) {
                const day = new Date(dtr.time_in).toISOString().slice(0, 10);
                if (!dtrByDay[day]) dtrByDay[day] = [];
                dtrByDay[day].push(dtr);
            }
        });
        
        let daysWorkedInPeriod = 0;
        let leaveDaysInPeriod = 0;
        let totalHoursInPeriod = 0;
        let totalMinutesLate = 0;
        let totalMinutesUnderTime = 0;
        let baseGrossPay = 0;
        let salaryRaise = 0;
        const raiseDetails: { name: string; amount: number }[] = [];

        // Iterate through each day of the pay period
        for (let day = new Date(payrollStartDate); day <= payrollEndDate; day.setDate(day.getDate() + 1)) {
            const dateKey = day.toISOString().slice(0, 10);
            const schedule = schedulesMap.get(`${emp.id}|${dateKey}`);
            const leave = leaveMap.get(`${emp.id}|${dateKey}`);

            if (leave) {
                leaveDaysInPeriod++;
                continue; // Skip DTR calculations for leave days
            }

            if (!schedule) continue; // Not a scheduled workday

            const dailyEntries = dtrByDay[dateKey] || [];
            if (dailyEntries.length === 0) continue; // Absent

            daysWorkedInPeriod++;
            dailyEntries.sort((a, b) => new Date(a.time_in!).getTime() - new Date(b.time_in!).getTime());
            
            let dailyWorkDurationMs = 0;
            // First work period
            if (dailyEntries[0]?.time_in && dailyEntries[0]?.time_out) {
                dailyWorkDurationMs += new Date(dailyEntries[0].time_out).getTime() - new Date(dailyEntries[0].time_in).getTime();
            }

            // Second work period (after break)
            if (dailyEntries[1]?.time_in) {
                const timeIn2 = new Date(dailyEntries[1].time_in);
                let timeOut2: Date | null = null;
                
                if (dailyEntries[1].time_out) {
                    // Manual clock-out exists
                    timeOut2 = new Date(dailyEntries[1].time_out);
                } else {
                    // Auto clock-out: use scheduled end time, as overtime is not paid
                    timeOut2 = new Date(`${dateKey}T${schedule.work_end_time}+08:00`);
                }

                if (timeOut2) {
                    dailyWorkDurationMs += Math.max(0, timeOut2.getTime() - timeIn2.getTime());
                }
            }

            const dailyWorkDurationHours = dailyWorkDurationMs / (1000 * 60 * 60);
            totalHoursInPeriod += dailyWorkDurationHours;

            const expectedStart = new Date(`${dateKey}T${schedule.work_start_time}+08:00`);
            const expectedEnd = new Date(`${dateKey}T${schedule.work_end_time}+08:00`);

            const timeIn = new Date(dailyEntries[0].time_in!);
            const minutesLate = (timeIn.getTime() - expectedStart.getTime()) / (1000 * 60);
            if (minutesLate > GRACE_PERIOD_MINUTES) {
                totalMinutesLate += Math.round(minutesLate);
            }

            const requiredWorkHours = (expectedEnd.getTime() - expectedStart.getTime() - (3600 * 1000)) / (1000*60*60); // Assume 1-hour break

            if (dailyWorkDurationHours < requiredWorkHours) {
                 const undertimeHours = Math.max(0, requiredWorkHours - dailyWorkDurationHours);
                 totalMinutesUnderTime += Math.round(undertimeHours * 60);
            }

            for (const rule of activeSalaryRules) {
              const ruleStart = new Date(rule.start_date);
              const ruleEnd = new Date(rule.end_date);
              if (day >= ruleStart && day <= ruleEnd) {
                const raiseAmount = emp.daily_rate * (rule.raise_percentage / 100);
                salaryRaise += raiseAmount;

                const existingRaise = raiseDetails.find(r => r.name === rule.name);
                if (existingRaise) {
                    existingRaise.amount += raiseAmount;
                } else {
                    raiseDetails.push({ name: rule.name, amount: raiseAmount });
                }
              }
            }
        }

        if (daysWorkedInPeriod === 0 && leaveDaysInPeriod === 0) continue;
        
        baseGrossPay = (daysWorkedInPeriod + leaveDaysInPeriod) * emp.daily_rate;

        const latenessDeductions = totalMinutesLate * DEDUCTION_RATE_PER_MINUTE;
        const underTimeDeductions = totalMinutesUnderTime * DEDUCTION_RATE_PER_MINUTE;

        let birthMonthBonus = 0;
        if (emp.birth_date && emp.position) {
            const birthMonth = parseInt(emp.birth_date.split('-')[1], 10) - 1;
            const payPeriodStartMonth = payrollStartDate.getUTCMonth();
            const payPeriodEndMonth = payrollEndDate.getUTCMonth();

            if (birthMonth === payPeriodStartMonth || birthMonth === payPeriodEndMonth) {
                birthMonthBonus = BIRTH_MONTH_BONUS[emp.position as keyof typeof BIRTH_MONTH_BONUS] || 0;
                if (birthMonthBonus > 0) {
                    raiseDetails.push({ name: 'Birth Month Bonus', amount: birthMonthBonus });
                }
            }
        }

        const totalGrossPay = baseGrossPay + salaryRaise + birthMonthBonus;
        const netPay = Math.max(0, totalGrossPay - latenessDeductions - underTimeDeductions);
        
        previews.push({
          employeeId: emp.id,
          employeeName: `${emp.first_name} ${emp.last_name}`,
          daysWorked: daysWorkedInPeriod,
          leaveDays: leaveDaysInPeriod,
          totalHours: parseFloat(totalHoursInPeriod.toFixed(2)),
          dailyRate: emp.daily_rate,
          baseGrossPay: parseFloat(baseGrossPay.toFixed(2)),
          salaryRaise: parseFloat(salaryRaise.toFixed(2)),
          birthMonthBonus: parseFloat(birthMonthBonus.toFixed(2)),
          raiseDetails: raiseDetails.map(r => ({ ...r, amount: parseFloat(r.amount.toFixed(2)) })),
          totalGrossPay: parseFloat(totalGrossPay.toFixed(2)),
          totalMinutesLate,
          totalMinutesUnderTime,
          latenessDeductions: parseFloat(latenessDeductions.toFixed(2)),
          underTimeDeductions: parseFloat(underTimeDeductions.toFixed(2)),
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
          const totalDeductions = p.latenessDeductions + p.underTimeDeductions + newManualDeduction;
          const netPay = Math.max(0, p.totalGrossPay - totalDeductions);
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
      
      const payrollsToInsert = selectedPayrolls.map(p => {
        const payrollData: any = {
          user_id: p.employeeId,
          pay_period_start: period.start.toISOString(),
          pay_period_end: period.end.toISOString(),
          total_hours: p.totalHours,
          gross_pay: p.totalGrossPay,
          salary_raise: p.salaryRaise,
          lateness_minutes: p.totalMinutesLate,
          undertime_minutes: p.totalMinutesUnderTime,
          lateness_deductions: p.latenessDeductions,
          undertime_deductions: p.underTimeDeductions,
          manual_deductions: p.manualDeductions,
          net_pay: p.netPay,
          raise_details: p.raiseDetails,
        };
        
        // --- FIX for recurring "early_departure_minutes" database error ---
        // To prevent crashes from an out-of-sync database schema, we explicitly add
        // default values for old, deprecated columns that might still have a
        // NOT-NULL constraint in the user's database. The correct data is still
        // saved in the 'undertime_minutes' and 'undertime_deductions' columns.
        payrollData.early_departure_minutes = 0;
        payrollData.early_departure_deductions = 0;
        
        return payrollData;
      });
      
      if (payrollsToInsert.length === 0) {
        this.errorMessage.set('No employees selected to run payroll for.');
        this.modalState.set('preview');
        return;
      }
      
      const { error } = await this.supabaseService.runPayrollForEmployees(payrollsToInsert as any);
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
