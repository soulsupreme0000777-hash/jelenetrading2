import { Component, ChangeDetectionStrategy, input, output, viewChild, ElementRef, effect, signal, inject } from '@angular/core';
import { Profile, SupabaseService } from '../../services/supabase.service';
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

  private readonly supabaseService = inject(SupabaseService);

  smallQrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('smallQrCanvas');
  largeQrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('largeQrCanvas');
  
  isQrEnlarged = signal(false);

  constructor() {
    // Effect 1: Handle modal visibility changes for data loading and state reset.
    effect(() => {
      const isVisible = this.visible();
      
      if (!isVisible) {
        this.isQrEnlarged.set(false); // Reset on close
      }
    });

    // Effect 2: Draw QR codes when their respective canvases are ready.
    // This runs whenever the employee data changes or the canvas elements become available.
    effect(() => {
      const emp = this.employee();
      if (!emp) return; // Don't do anything if there's no employee data.

      const qrData = JSON.stringify({ userId: emp.id, email: emp.email });

      const smallCanvas = this.smallQrCanvas();
      if (smallCanvas) {
        const smallCanvasEl = smallCanvas.nativeElement;
        QRCode.toCanvas(smallCanvasEl, qrData, { width: 80, margin: 1 }, (error: any) => {
          if (error) console.error('Failed to generate small QR Code:', error.message || error);
        });
      }

      // The large canvas is optional. This runs when `largeQrCanvas` signal resolves.
      const largeCanvas = this.largeQrCanvas();
      if (largeCanvas) {
        const largeCanvasEl = largeCanvas.nativeElement;
        QRCode.toCanvas(largeCanvasEl, qrData, { width: 320, margin: 2 }, (error: any) => {
          if (error) console.error('Failed to generate large QR Code:', error.message || error);
        });
      }
    });
  }
  
  downloadQrCode() {
    const canvas = this.largeQrCanvas()?.nativeElement;
    const emp = this.employee();
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
  
  printIdCard(): void {
    window.print();
  }

  closeModal(): void {
    this.close.emit();
  }
}