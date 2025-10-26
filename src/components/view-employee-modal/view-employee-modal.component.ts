import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { Profile } from '../../services/supabase.service';
import { CurrencyPipe } from '@angular/common';

@Component({
  selector: 'app-view-employee-modal',
  templateUrl: './view-employee-modal.component.html',
  imports: [CurrencyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewEmployeeModalComponent {
  visible = input.required<boolean>();
  employee = input<Profile | null>();
  close = output<void>();

  closeModal(): void {
    this.close.emit();
  }
}
