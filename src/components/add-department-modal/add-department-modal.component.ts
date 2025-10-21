import { Component, ChangeDetectionStrategy, input, output, signal, effect, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Department } from '../../services/supabase.service';

type ModalState = 'form' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-add-department-modal',
  template: `
    @if (visible()) {
      <div class="fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm z-40" (click)="closeModal()"></div>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg" (click)="$event.stopPropagation()">
          
          <div class="flex justify-between items-center mb-6">
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">{{ isEditMode() ? 'Edit' : 'Add New' }} Department</h2>
            <button (click)="closeModal()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-2xl leading-none">&times;</button>
          </div>

          @switch (modalState()) {
            @case ('form') {
              <form (ngSubmit)="onSubmit()" class="space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label for="departmentName" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Department Name</label>
                    <input id="departmentName" type="text" [(ngModel)]="departmentName" name="departmentName" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                  <div>
                    <label for="dailyRate" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Daily Rate (PHP)</label>
                    <input id="dailyRate" type="number" [(ngModel)]="defaultHourlyRate" name="dailyRate" required min="0" step="0.01" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                  <div>
                    <label for="workStartTime" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Work Start Time</label>
                    <input id="workStartTime" type="time" [(ngModel)]="workStartTime" name="workStartTime" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                   <div>
                    <label for="workEndTime" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Work End Time</label>
                    <input id="workEndTime" type="time" [(ngModel)]="workEndTime" name="workEndTime" required class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                  <div>
                    <label for="gracePeriod" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Grace Period (minutes)</label>
                    <input id="gracePeriod" type="number" [(ngModel)]="gracePeriod" name="gracePeriod" required min="0" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                  <div>
                    <label for="latenessDeduction" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Deduction per Minute Late (PHP)</label>
                    <input id="latenessDeduction" type="number" [(ngModel)]="latenessDeduction" name="latenessDeduction" required min="0" step="0.01" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-200">
                  </div>
                </div>

                @if (errorMessage()) {
                  <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mt-4" role="alert">
                    <span class="block sm:inline">{{ errorMessage() }}</span>
                  </div>
                }

                <div class="flex justify-end gap-2 pt-4">
                  <button type="button" (click)="closeModal()" class="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-md hover:bg-gray-300 dark:hover:bg-gray-500">Cancel</button>
                  <button type="submit" [disabled]="!isFormValid()" class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed">
                    {{ isEditMode() ? 'Save Changes' : 'Add Department' }}
                  </button>
                </div>
              </form>
            }
            @case ('loading') {
              <div class="text-center py-8">
                <p class="text-gray-700 dark:text-gray-300">{{ isEditMode() ? 'Saving changes...' : 'Creating department...' }}</p>
              </div>
            }
            @case ('success') {
              <div class="text-center py-8">
                <p class="text-green-600 font-semibold">Department {{ isEditMode() ? 'updated' : 'created' }} successfully!</p>
              </div>
            }
          }
        </div>
      </div>
    }
  `,
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

  isEditMode = computed(() => !!this.departmentToEdit());

  // Form state
  departmentName = signal('');
  defaultHourlyRate = signal<number | null>(null);
  workStartTime = signal('09:00');
  workEndTime = signal('18:00');
  gracePeriod = signal<number | null>(15);
  latenessDeduction = signal<number | null>(null);

  modalState = signal<ModalState>('form');
  errorMessage = signal<string | null>(null);
  
  isFormValid = computed(() => {
    const name = this.departmentName().trim();
    const rate = this.defaultHourlyRate();
    const grace = this.gracePeriod();
    const deduction = this.latenessDeduction();
    return name !== '' && rate !== null && rate >= 0 && this.workStartTime() && this.workEndTime() && grace !== null && grace >= 0 && deduction !== null && deduction >= 0;
  });

  constructor() {
    effect(() => {
      const dept = this.departmentToEdit();
      if (this.visible() && dept) {
        this.populateForm(dept);
      } else {
        this.resetState();
      }
    });
  }
  
  private populateForm(dept: Department): void {
    this.departmentName.set(dept.name);
    this.defaultHourlyRate.set(dept.default_hourly_rate);
    this.workStartTime.set(dept.work_start_time);
    this.workEndTime.set(dept.work_end_time);
    this.gracePeriod.set(dept.grace_period_minutes);
    this.latenessDeduction.set(dept.lateness_deduction_per_minute);
    this.modalState.set('form');
  }

  async onSubmit(): Promise<void> {
    if (!this.isFormValid()) {
      this.errorMessage.set('Please fill out all fields with valid, non-negative values.');
      return;
    }

    this.modalState.set('loading');
    this.errorMessage.set(null);
    
    const departmentData = {
      name: this.departmentName(),
      default_hourly_rate: this.defaultHourlyRate()!,
      work_start_time: this.workStartTime(),
      work_end_time: this.workEndTime(),
      grace_period_minutes: this.gracePeriod()!,
      lateness_deduction_per_minute: this.latenessDeduction()!,
    };

    try {
      if (this.isEditMode()) {
        const dept = this.departmentToEdit();
        if (!dept) throw new Error("Department to edit not found.");
        const { error } = await this.supabaseService.updateDepartment(dept.id, departmentData);
        if (error) throw error;
      } else {
        const { error } = await this.supabaseService.createDepartment(departmentData);
        if (error) throw error;
      }
      
      this.modalState.set('success');
      this.departmentSaved.emit();
      setTimeout(() => this.closeModal(), 1500);

    } catch (error: any) {
      this.errorMessage.set(error.message || 'An unknown error occurred.');
      this.modalState.set('form');
    }
  }

  closeModal(): void {
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('form');
    this.errorMessage.set(null);
    this.departmentName.set('');
    this.defaultHourlyRate.set(null);
    this.workStartTime.set('09:00');
    this.workEndTime.set('18:00');
    this.gracePeriod.set(15);
    this.latenessDeduction.set(null);
  }
}