import { Component, ChangeDetectionStrategy, input, output, signal, inject, computed, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { SupabaseService, Profile, DtrEntry, PayrollPreviewItem, Payroll, Department } from '../../services/supabase.service';

type ModalStep = 'period' | 'deductions' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-run-payroll-modal',
  templateUrl: './run-payroll-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CurrencyPipe, DecimalPipe],
})
export class RunPayrollModalComponent {
  visible = input.required<boolean>();
  departments = input.required<Department[]>();
  close = output<void>();
  payrollRun = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  modalStep = signal<ModalStep>('period');
  startDate = signal('');
  endDate = signal('');
  
  payrollPreview = signal<PayrollPreviewItem[]>([]);
  errorMessage = signal<string | null>(null);
  isCalculating = signal(false);

  isPeriodValid = computed(() => this.startDate() && this.endDate() && new Date(this.startDate()) <= new Date(this.endDate()));

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.resetState();
      }
    });
  }

  async calculatePreview(): Promise<void> {
    if (!this.isPeriodValid()) {
      this.errorMessage.set('Please select a valid date range.');
      return;
    }
    this.isCalculating.set(true);
    this.errorMessage.set(null);
    this.modalStep.set('loading');

    try {
      const { data: dtrEntries, error } = await this.supabaseService.getDtrEntriesForPeriod(this.startDate(), this.endDate());
      if (error) throw error;
      if (!dtrEntries || dtrEntries.length === 0) {
        this.errorMessage.set('No completed DTR entries found for the selected period.');
        this.modalStep.set('period');
        return;
      }
      
      this.processDtrEntries(dtrEntries);
      this.modalStep.set('deductions');

    } catch (e: any) {
      this.errorMessage.set(e.message);
      this.modalStep.set('period');
    } finally {
      this.isCalculating.set(false);
    }
  }

  private processDtrEntries(entries: (DtrEntry & { profiles: Profile })[]): void {
    const departmentMap = new Map<string, Department>(this.departments().map(dept => [dept.name, dept]));
    const userPayrollData = new Map<string, { profile: Profile, totalMillis: number, latenessDeduction: number }>();

    for (const entry of entries) {
      if (!entry.profiles || !entry.time_out || !entry.profiles.position) continue;

      const department = departmentMap.get(entry.profiles.position);
      const timeIn = new Date(entry.time_in);
      const timeOut = new Date(entry.time_out);
      const durationMillis = timeOut.getTime() - timeIn.getTime();

      let currentLatenessDeduction = 0;
      if (department && department.work_start_time) {
        const [hours, minutes] = department.work_start_time.split(':').map(Number);
        
        const workStartTime = new Date(timeIn);
        workStartTime.setHours(hours, minutes, 0, 0);

        const minutesLate = (timeIn.getTime() - workStartTime.getTime()) / (1000 * 60);

        if (minutesLate > department.grace_period_minutes) {
          const chargeableMinutes = minutesLate - department.grace_period_minutes;
          currentLatenessDeduction = chargeableMinutes * department.lateness_deduction_per_minute;
        }
      }

      const existing = userPayrollData.get(entry.user_id);
      if (existing) {
        existing.totalMillis += durationMillis;
        existing.latenessDeduction += currentLatenessDeduction;
      } else {
        userPayrollData.set(entry.user_id, { 
          profile: entry.profiles, 
          totalMillis: durationMillis,
          latenessDeduction: currentLatenessDeduction 
        });
      }
    }

    const preview: PayrollPreviewItem[] = [];
    for (const [userId, data] of userPayrollData.entries()) {
      const totalHours = data.totalMillis / (1000 * 60 * 60);
      const grossPay = totalHours * (data.profile.hourly_rate || 0);
      const autoDeductions = data.latenessDeduction;
      
      preview.push({
        user_id: userId,
        profile: data.profile,
        total_hours: totalHours,
        gross_pay: grossPay,
        auto_lateness_deductions: autoDeductions,
        deductions: Math.max(0, autoDeductions), // Initialize with auto deductions, ensure non-negative
        net_pay: grossPay - Math.max(0, autoDeductions),
      });
    }

    this.payrollPreview.set(preview);
  }

  onDeductionChange(userId: string, deductions: number | null): void {
    this.payrollPreview.update(currentPreview => {
      return currentPreview.map(item => {
        if (item.user_id === userId) {
          const newDeductions = deductions ?? 0;
          return {
            ...item,
            deductions: newDeductions,
            net_pay: item.gross_pay - newDeductions,
          };
        }
        return item;
      });
    });
  }

  async onFinalize(): Promise<void> {
    this.isCalculating.set(true);
    this.errorMessage.set(null);
    this.modalStep.set('loading');

    try {
      const payrollsToCreate: Omit<Payroll, 'id' | 'profiles'>[] = this.payrollPreview().map(item => ({
        user_id: item.user_id,
        pay_period_start: new Date(this.startDate()).toISOString(),
        pay_period_end: new Date(this.endDate()).toISOString(),
        total_hours: item.total_hours,
        gross_pay: item.gross_pay,
        deductions: item.deductions,
        net_pay: item.net_pay,
        status: 'paid', // Or 'processing' if there is an approval step
      }));
      
      const { error } = await this.supabaseService.finalizePayrolls(payrollsToCreate);
      if (error) throw error;
      
      this.modalStep.set('success');
      this.payrollRun.emit();

    } catch (e: any) {
      this.errorMessage.set(e.message);
      this.modalStep.set('error');
    } finally {
      this.isCalculating.set(false);
    }
  }

  closeModal(): void {
    this.close.emit();
  }

  private resetState(): void {
    this.modalStep.set('period');
    this.errorMessage.set(null);
    const today = new Date().toISOString().split('T')[0];
    this.startDate.set(today);
    this.endDate.set(today);
    this.payrollPreview.set([]);
    this.isCalculating.set(false);
  }
}