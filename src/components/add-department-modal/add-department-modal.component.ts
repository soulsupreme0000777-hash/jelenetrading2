import { Component, ChangeDetectionStrategy, input, output, signal, effect, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
// FIX: Removed `Department` from import as it is no longer exported from `SupabaseService`.
import { SupabaseService } from '../../services/supabase.service';

// FIX: Added local `Department` interface to resolve type errors.
// This component appears to rely on deprecated functionality, as the concept of
// a department has been merged into the Profile entity.
interface Department {
  id: number;
  name: string;
  work_start_time?: string | null;
  work_end_time?: string | null;
  grace_period_minutes?: number | null;
  deduction_rate_per_minute?: number | null;
}

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

    // FIX: The functionality for creating/updating departments has been removed.
    // The related methods `createDepartment` and `updateDepartment` do not exist on the service.
    // This displays an error message instead of attempting to call non-existent functions.
    this.errorMessage.set('This feature has been deprecated and is no longer available.');
    this.modalState.set('form');
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
