import { Component, ChangeDetectionStrategy, inject, signal, viewChild, ElementRef, computed, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { SupabaseService, Profile, DtrEntry } from '../../services/supabase.service';

declare var jsQR: any;

type ScanResult = {
  profile: Profile;
  dtrEntry: DtrEntry;
  status: string;
  scanTime: Date;
};

@Component({
  selector: 'app-time-clock-page',
  imports: [CommonModule, DatePipe],
  templateUrl: './time-clock-page.component.html',
  styleUrl: './time-clock-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimeClockPageComponent implements OnDestroy, AfterViewInit {
  private readonly supabaseService = inject(SupabaseService);

  // --- State Signals & Properties ---
  video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  
  scannerLoading = signal(false);
  scannerErrorMessage = signal<string | null>(null);
  lastScanResult = signal<ScanResult | null>(null);

  breakCountdown = signal<number | null>(null);
  breakCountdownDisplay = computed(() => {
    const seconds = this.breakCountdown();
    if (seconds === null || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  });

  private stream: MediaStream | null = null;
  private isScanning = false;
  private scanResultTimer: any;
  private breakTimerInterval: any;

  ngAfterViewInit(): void {
    this.startScanner();
  }

  ngOnDestroy(): void {
    this.stopScanner();
  }

  private async startScanner(): Promise<void> {
    try {
        if (this.isScanning) return;
        this.stopScanner(); // Ensure any existing streams are stopped
        
        const videoEl = this.video()?.nativeElement;
        if (!videoEl || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('Camera not available or not supported by this browser.');
        }
        
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });

        videoEl.srcObject = this.stream;
        videoEl.setAttribute('playsinline', 'true');
        await videoEl.play();
        
        this.isScanning = true;
        this.scannerErrorMessage.set(null);
        this.lastScanResult.set(null);
        requestAnimationFrame(this.tick.bind(this));

    } catch (err: any) {
        console.error('Error starting scanner:', err.message || err);
        this.scannerErrorMessage.set(err.message || 'Could not access the camera. Check permissions.');
    }
  }

  private stopScanner(): void {
    this.isScanning = false;
    if (this.scanResultTimer) {
        clearTimeout(this.scanResultTimer);
    }
    this.stopBreakTimer();
    if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
    }
    const videoEl = this.video()?.nativeElement;
    if (videoEl) {
        videoEl.srcObject = null;
    }
  }

  private startBreakTimer(): void {
    this.stopBreakTimer();
    this.breakCountdown.set(3600); // 1 hour in seconds
    this.breakTimerInterval = setInterval(() => {
      this.breakCountdown.update(val => {
        if (val === null || val <= 0) {
          this.stopBreakTimer();
          return 0;
        }
        return val - 1;
      });
    }, 1000);
  }

  private stopBreakTimer(): void {
    if (this.breakTimerInterval) {
      clearInterval(this.breakTimerInterval);
      this.breakTimerInterval = null;
      this.breakCountdown.set(null);
    }
  }

  private tick(): void {
    if (!this.isScanning) return;

    const videoEl = this.video().nativeElement;
    const canvasEl = this.canvas().nativeElement;
    
    if (videoEl && videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && canvasEl) {
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        canvasEl.height = videoEl.videoHeight;
        canvasEl.width = videoEl.videoWidth;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });
        
        if (code) {
          this.isScanning = false; // Stop further scanning while processing
          this.handleQrCodeScan(code.data);
          return; // Exit the loop
        }
      }
    }
    
    requestAnimationFrame(this.tick.bind(this));
  }
  
  private async handleQrCodeScan(qrData: string): Promise<void> {
    this.scannerLoading.set(true);
    this.scannerErrorMessage.set(null);
    this.stopBreakTimer();
    
    if (this.scanResultTimer) {
        clearTimeout(this.scanResultTimer);
    }

    try {
        const parsedData = JSON.parse(qrData);
        if (!parsedData.userId) {
            throw new Error('Invalid QR code format.');
        }
        
        const { profile, dtrEntry, status } = await this.supabaseService.handleQrCodeLogin(parsedData.userId);

        this.lastScanResult.set({ profile, dtrEntry, status, scanTime: new Date() });
        
        if (status === 'CLOCK_OUT_BREAK') {
            this.startBreakTimer();
        }

        // Reset for the next scan after 7 seconds
        this.scanResultTimer = setTimeout(() => {
            this.lastScanResult.set(null);
            this.isScanning = true;
            requestAnimationFrame(this.tick.bind(this));
        }, 7000);

    } catch (error: any) {
        this.scannerErrorMessage.set(error.message || 'Failed to process QR code.');
        
        // Show error for 7 seconds, then reset for next scan
        this.scanResultTimer = setTimeout(() => {
            this.scannerErrorMessage.set(null);
            this.isScanning = true;
            requestAnimationFrame(this.tick.bind(this));
        }, 7000);
    } finally {
        this.scannerLoading.set(false);
    }
  }
}
