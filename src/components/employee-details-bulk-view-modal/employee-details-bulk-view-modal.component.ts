import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { Profile } from '../../services/supabase.service';

@Component({
  selector: 'app-employee-details-bulk-view-modal',
  standalone: true,
  imports: [CommonModule, CurrencyPipe],
  templateUrl: './employee-details-bulk-view-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmployeeDetailsBulkViewModalComponent {
  visible = input.required<boolean>();
  employees = input.required<Profile[]>();
  close = output<void>();

  closeModal(): void {
    this.close.emit();
  }
}
