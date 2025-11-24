import { Component, ChangeDetectionStrategy, input, output, signal, effect, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, SalaryRule } from '../../services/supabase.service';

type ModalState = 'form' | 'loading' | 'error';

@Component({
  selector: 'app-salary-adjustment-modal',
  templateUrl: './salary-adjustment-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
})
export class SalaryAdjustmentModalComponent {
  // Inputs & Outputs
  visible = input.required<boolean>();
  adjustmentToEdit = input<SalaryRule | null>();
  close = output<void>();
  saved = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  // Component State
  modalState = signal<ModalState>('form');
  errorMessage = signal<string | null>(null);
  
  // Form Signals
  ruleName = signal('');
  description = signal('');
  raiseAmount = signal<number | null>(null);
  startDate = signal('');
  endDate = signal('');
  isActive = signal(true);

  isEditMode = computed(() => !!this.adjustmentToEdit());
  
  isFormValid = computed(() => {
    return this.ruleName().trim() && this.raiseAmount() !== null && this.raiseAmount()! > 0 && this.startDate() && this.endDate() && this.startDate() <= this.endDate();
  });

  constructor() {
    effect(() => {
      if (this.visible()) {
        const rule = this.adjustmentToEdit();
        if (rule) {
          // Edit mode: populate form
          this.ruleName.set(rule.name);
          this.description.set(rule.description || '');
          this.raiseAmount.set(rule.raise_amount);
          this.startDate.set(rule.start_date);
          this.endDate.set(rule.end_date);
          this.isActive.set(rule.is_active);
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
      const ruleData = {
        name: this.ruleName(),
        description: this.description(),
        raise_amount: this.raiseAmount()!,
        start_date: this.startDate(),
        end_date: this.endDate(),
        is_active: this.isActive(),
      };

      if (this.isEditMode()) {
        const rule = this.adjustmentToEdit();
        if (!rule) throw new Error('Salary rule to edit not found.');
        
        const { error } = await this.supabaseService.updateSalaryRule(rule.id, ruleData);
        if (error) throw error;
      } else {
        const { error } = await this.supabaseService.createSalaryRule(ruleData as any);
        if (error) throw error;
      }

      this.saved.emit();
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
    this.ruleName.set('');
    this.description.set('');
    this.raiseAmount.set(null);
    this.startDate.set('');
    this.endDate.set('');
    this.isActive.set(true);
  }
}