import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { DtrEntry, Profile } from '../../services/supabase.service';
import { DatePipe } from '@angular/common';

@Component({
  selector: 'app-qr-login-success-modal',
  templateUrl: './qr-login-success-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
})
export class QrLoginSuccessModalComponent {
  visible = input.required<boolean>();
  profile = input.required<Profile | null>();
  dtrEntry = input.required<DtrEntry | null>();
  close = output<void>();

  closeModal(): void {
    this.close.emit();
  }
}