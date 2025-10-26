import { Component, ChangeDetectionStrategy, input, output, signal, effect, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Department } from '../../services/supabase.service';

type ModalState = 'form' | 'loading' | 'error';

@Component({
  selector: 'app-add-department-modal',
  templateUrl: './add-department-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
})
export class AddDepartmentModalComponent {
  // Inputs & Outputs
  visible = input.required<boolean>();
  departmentToEdit = input<Department | null>();
  close = output<void>();
  departmentSaved = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  // Component State
  modalState = signal<ModalState>('form');
  errorMessage = signal<string | null>(null);
  
  // Form Signals
  departmentName = signal('');
  workStartTime = signal('');
  workEndTime = signal('');
  gracePeriodMinutes = signal<number | null>(0);
  deductionRatePerMinute = signal<number | null>(null);
  
  isEditMode = computed(() => !!this.departmentToEdit());
  
  isFormValid = computed(() => {
    return this.departmentName().trim() && this.workStartTime() && this.workEndTime() && this.gracePeriodMinutes()! >= 0 && this.deductionRatePerMinute() !== null && this.deductionRatePerMinute()! >= 0;
  });

  constructor() {
    effect(() => {
      if (this.visible()) {
        const dept = this.departmentToEdit();
        if (dept) {
          // Edit mode: populate form
          this.departmentName.set(dept.name);
          this.workStartTime.set(dept.work_start_time || '');
          this.workEndTime.set(dept.work_end_time || '');
          this.gracePeriodMinutes.set(dept.grace_period_minutes || 0);
          this.deductionRatePerMinute.set(dept.deduction_rate_per_minute ?? null);
        } else {
          // Add mode: reset form
          this.resetState();
        }
      }
    });
  }

  async onSubmit(): Promise<void> {
    if (!this.isFormValid()) {
      this.errorMessage.set('Please fill in all fields with valid values.');
      return;
    }

    this.modalState.set('loading');
    this.errorMessage.set(null);

    try {
      const departmentData = {
        name: this.departmentName(),
        work_start_time: this.workStartTime(),
        work_end_time: this.workEndTime(),
        grace_period_minutes: this.gracePeriodMinutes(),
        deduction_rate_per_minute: this.deductionRatePerMinute(),
      };

      if (this.isEditMode()) {
        const dept = this.departmentToEdit();
        if (!dept) throw new Error('Department to edit not found.');
        
        const { error } = await this.supabaseService.updateDepartment(dept.id, departmentData);
        if (error) throw error;
      } else {
        const { error } = await this.supabaseService.createDepartment(departmentData);
        if (error) throw error;
      }

      this.departmentSaved.emit();
      this.closeModal();

    } catch (error: any) {
      this.errorMessage.set(error.message || 'An unexpected error occurred.');
      this.modalState.set('form'); // Revert to form on error
    }
  }

  closeModal(): void {
    this.resetState();
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('form');
    this.errorMessage.set(null);
    this.departmentName.set('');
    this.workStartTime.set('');
    this.workEndTime.set('');
    this.gracePeriodMinutes.set(0);
    this.deductionRatePerMinute.set(null);
  }
}