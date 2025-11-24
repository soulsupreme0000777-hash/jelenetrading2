import { Component, ChangeDetectionStrategy, input, output, effect, viewChildren, ElementRef, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Profile } from '../../services/supabase.service';
import QRCode from 'qrcode';

@Component({
  selector: 'app-id-card-bulk-view-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './id-card-bulk-view-modal.component.html',
  styleUrl: './id-card-bulk-view-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IdCardBulkViewModalComponent {
  visible = input.required<boolean>();
  employees = input.required<Profile[]>();
  close = output<void>();

  qrCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('qrCanvas');
  largeQrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('largeQrCanvas');
  enlargedQrEmployee = signal<Profile | null>(null);

  constructor() {
    effect(() => {
      // Small QRs
      if (this.visible() && this.employees().length > 0) {
        // Use a macrotask to ensure canvases are in the DOM after ngFor renders.
        setTimeout(() => this.generateSmallQrCodes(), 0);
      }
    });

    effect(() => {
      // Large QR
      const employeeToEnlarge = this.enlargedQrEmployee();
      const canvasEl = this.largeQrCanvas()?.nativeElement;
      if (employeeToEnlarge && canvasEl) {
        const qrData = JSON.stringify({ userId: employeeToEnlarge.id, email: employeeToEnlarge.email });
        // Use timeout to ensure canvas is ready after the @if block renders it
        setTimeout(() => {
          QRCode.toCanvas(canvasEl, qrData, { width: 320, margin: 2 }, (error: any) => {
            if (error) console.error(`Failed to generate large QR Code for ${employeeToEnlarge.first_name}:`, error);
          });
        }, 0);
      }
    });
  }

  private generateSmallQrCodes(): void {
    this.qrCanvases().forEach((canvasRef, index) => {
      const employee = this.employees()[index];
      if (employee && canvasRef) {
        const qrData = JSON.stringify({ userId: employee.id, email: employee.email });
        QRCode.toCanvas(canvasRef.nativeElement, qrData, { width: 80, margin: 1 }, (error: any) => {
          if (error) console.error(`Failed to generate QR Code for ${employee.first_name}:`, error);
        });
      }
    });
  }

  printCards(): void {
    window.print();
  }

  closeModal(): void {
    this.close.emit();
  }

  enlargeQrCode(employee: Profile): void {
    this.enlargedQrEmployee.set(employee);
  }

  closeEnlargedQr(): void {
    this.enlargedQrEmployee.set(null);
  }

  downloadQrCode(): void {
    const canvas = this.largeQrCanvas()?.nativeElement;
    const emp = this.enlargedQrEmployee();
    if (canvas && emp) {
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        const firstName = emp.first_name || 'employee';
        const lastName = emp.last_name || '';
        link.download = `qr-code-${firstName}-${lastName}.png`.replace(/ /g, '-').toLowerCase();
        link.href = dataUrl;
        link.click();
    }
  }
}
