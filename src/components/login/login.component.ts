import { Component, ChangeDetectionStrategy, signal, inject, effect, OnDestroy, viewChild, ElementRef, untracked } from '@angular/core';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry } from '../../services/supabase.service';
import { QrLoginSuccessModalComponent } from '../qr-login-success-modal/qr-login-success-modal.component';

declare var jsQR: any;

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, QrLoginSuccessModalComponent]
})
export class LoginComponent implements OnDestroy {
  // View Children for QR Scanner
  video = viewChild<ElementRef<HTMLVideoElement>>('video');
  canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  // Form Group for password login
  loginForm = new FormGroup({
    email: new FormControl('admin@gmail.com', [Validators.required, Validators.email]),
    password: new FormControl('123456', [Validators.required]),
  });

  // State Signals
  loading = signal(false);
  errorMessage = signal<string | null>(null);
  viewMode = signal<'password' | 'qr'>('password');

  // QR Success Modal State
  isQrSuccessModalVisible = signal(false);
  qrScannedProfile = signal<Profile | null>(null);
  qrScannedDtrEntry = signal<DtrEntry | null>(null);

  // Private properties for QR scanner
  private stream: MediaStream | null = null;
  private isScanning = false;

  // Services & Router
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  constructor() {
    // Redirect if user is already logged in
    effect(() => {
      if (this.supabaseService.isInitialized() && this.supabaseService.currentUser()) {
        untracked(() => {
          this.router.navigate(['/dashboard']);
        });
      }
    });

    // Disable form when loading
    effect(() => {
      const isLoading = this.loading();
      if (isLoading) {
        this.loginForm.disable();
      } else {
        this.loginForm.enable();
      }
    });

    // Start/stop scanner when view mode changes
    effect((onCleanup) => {
        const mode = this.viewMode();
        if (mode === 'qr') {
            this.startScanner();
        } else {
            this.stopScanner();
        }
        onCleanup(() => this.stopScanner());
    });
  }

  ngOnDestroy(): void {
    this.stopScanner();
  }

  // Helper getters for template
  get email() { return this.loginForm.get('email'); }
  get password() { return this.loginForm.get('password'); }

  setViewMode(mode: 'password' | 'qr'): void {
    this.errorMessage.set(null); // Clear errors when switching modes
    this.viewMode.set(mode);
  }

  async onSubmit(): Promise<void> {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const { email, password } = this.loginForm.value;
      const { error } = await this.supabaseService.signInWithPassword({
        email: email!,
        password: password!,
      });
      if (error) throw error;
      // Effect handles redirection
    } catch (error: any) {
      this.errorMessage.set(error.message || 'An unexpected error occurred.');
    } finally {
      this.loading.set(false);
    }
  }

  // --- QR Scanner Logic ---

  private async startScanner(): Promise<void> {
    try {
      if (this.stream) this.stopScanner(); // Ensure no existing stream
      
      const videoEl = this.video()?.nativeElement;
      if (!videoEl || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera not available or not supported by this browser.');
      }
      
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });

      videoEl.srcObject = this.stream;
      videoEl.setAttribute('playsinline', 'true'); // Required for iOS
      await videoEl.play();
      
      this.isScanning = true;
      requestAnimationFrame(this.tick.bind(this));
    } catch (err: any) {
      console.error('Error starting scanner:', err);
      this.errorMessage.set(err.message || 'Could not access the camera. Please check permissions.');
      this.viewMode.set('password'); // Revert to password mode on error
    }
  }

  private stopScanner(): void {
    this.isScanning = false;
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    const videoEl = this.video()?.nativeElement;
    if (videoEl) {
        videoEl.srcObject = null;
    }
  }

  private tick(): void {
    if (!this.isScanning) return;

    const videoEl = this.video()?.nativeElement;
    const canvasEl = this.canvas()?.nativeElement;
    
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
          this.isScanning = false; // Stop further scanning
          this.handleQrCodeLogin(code.data);
          return; // Exit the loop
        }
      }
    }
    
    requestAnimationFrame(this.tick.bind(this));
  }
  
  private async handleQrCodeLogin(qrData: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.stopScanner(); // Stop the camera feed

    try {
      const parsedData = JSON.parse(qrData);
      if (!parsedData.userId) {
        throw new Error('Invalid QR code format.');
      }
      
      const { profile, dtrEntry } = await this.supabaseService.handleQrCodeLogin(parsedData.userId);

      this.qrScannedProfile.set(profile);
      this.qrScannedDtrEntry.set(dtrEntry);
      this.isQrSuccessModalVisible.set(true);

    } catch (error: any) {
      console.error('QR Login Error:', error);
      this.errorMessage.set(error.message || 'Failed to process QR code.');
    } finally {
      this.loading.set(false);
    }
  }
  
  closeQrSuccessModal(): void {
    this.isQrSuccessModalVisible.set(false);
    this.qrScannedProfile.set(null);
    this.qrScannedDtrEntry.set(null);
    this.setViewMode('password'); // Go back to password login after modal closes
  }
}