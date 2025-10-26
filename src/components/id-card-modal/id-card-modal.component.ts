import { Component, ChangeDetectionStrategy, input, output, viewChild, ElementRef, effect } from '@angular/core';
import { Profile } from '../../services/supabase.service';
import QRCode from 'qrcode';

@Component({
  selector: 'app-id-card-modal',
  templateUrl: './id-card-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IdCardModalComponent {
  visible = input.required<boolean>();
  employee = input<Profile | null>();
  close = output<void>();

  qrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('qrCanvas');

  constructor() {
    effect(() => {
      if (this.visible() && this.employee()) {
        this.generateQrCode();
      }
    });
  }

  private generateQrCode(): void {
    const emp = this.employee();
    if (!emp) return;

    const qrData = JSON.stringify({ userId: emp.id, email: emp.email });
    const canvas = this.qrCanvas()?.nativeElement;

    if (canvas && qrData) {
      setTimeout(() => { // Allow canvas to be rendered first
        QRCode.toCanvas(canvas, qrData, { width: 96, margin: 1 }, (error: any) => {
          if (error) console.error('Failed to generate QR Code:', error);
        });
      }, 50);
    }
  }

  printIdCard() {
    alert('This is a placeholder for the ID card printing functionality. A new template will be applied here soon.');
  }

  closeModal(): void {
    this.close.emit();
  }
}