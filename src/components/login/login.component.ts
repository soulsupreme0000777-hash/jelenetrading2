import { Component, ChangeDetectionStrategy, signal, inject, effect, OnDestroy, viewChild, ElementRef } from '@angular/core';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService, Profile, DtrEntry } from '../../services/supabase.service';
import { QrLoginSuccessModalComponent } from '../qr-login-success-modal/qr-login-success-modal.component';

// jsQR is loaded from a script tag in index.html
declare var jsQR: any;

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, QrLoginSuccessModalComponent]
})
export class LoginComponent implements OnDestroy {
  // Form Group
  loginForm = new FormGroup({
    email: new FormControl('admin@gmail.com', [Validators.required, Validators.email]),
    password: new FormControl('123456', [Validators.required]),
  });

  // State Signals
  loading = signal(false);
  errorMessage = signal<string | null>(null);
  viewMode = signal<'form' | 'qr'>('form');

  // Services & Router
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);
  
  // QR Scanner related properties
  videoElement = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  canvasElement = viewChild<ElementRef<HTMLCanvasElement>>('canvasElement');
  
  isScanning = signal(false);
  qrError = signal<string | null>(null);
  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  
  // QR Success Modal State
  isQrSuccessModalVisible = signal(false);
  qrSuccessProfile = signal<Profile | null>(null);
  qrSuccessDtrEntry = signal<DtrEntry | null>(null);

  constructor() {
    // This effect handles redirection for existing user sessions and after a successful login.
    effect(() => {
      // Only redirect if the service is initialized and there is a user.
      if (this.supabaseService.isInitialized() && this.supabaseService.currentUser()) {
        this.router.navigate(['/dashboard']);
      }
    });

    // Effect to manage form state based on loading signal
    effect(() => {
      const isLoading = this.loading();
      if (isLoading) {
        this.loginForm.disable();
      } else {
        this.loginForm.enable();
      }
    });
    
    // Effect to start/stop camera when view mode changes
    effect((onCleanup) => {
        if (this.viewMode() === 'qr') {
            this.startScan();
        } else {
            this.stopScan();
        }
        
        onCleanup(() => {
          this.stopScan();
        });
    });
  }
  
  ngOnDestroy(): void {
    this.stopScan();
  }

  // Helper getters for easy access in the template
  get email() { return this.loginForm.get('email'); }
  get password() { return this.loginForm.get('password'); }
  
  async onSubmit(): Promise<void> {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const { email, password } = this.loginForm.value;
      const { data, error } = await this.supabaseService.signInWithPassword({
        email: email!,
        password: password!,
      });

      if (error) throw error;
      if (!data.user) {
        throw new Error('Login failed. Please try again.');
      }
      
      // The component's effect will now handle redirection when currentUser() state changes.
      // This creates a single, reliable source for redirection logic.

    } catch (error: any) {
      this.errorMessage.set(error.message || 'An unexpected error occurred.');
      this.loading.set(false);
    }
  }
  
  // --- QR Scanner Methods ---
  
  showQrScanner(): void {
    this.viewMode.set('qr');
    this.errorMessage.set(null); // Clear form errors
  }
  
  showLoginForm(): void {
    this.viewMode.set('form');
  }

  async startScan(): Promise<void> {
    this.qrError.set(null);
    const video = this.videoElement()?.nativeElement;
    
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      this.qrError.set('Camera not available or not supported by your browser.');
      return;
    }
    
    try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = this.stream;
        video.setAttribute('playsinline', 'true'); // Required for iOS
        await video.play();
        this.isScanning.set(true);
        this.animationFrameId = requestAnimationFrame(this.tick.bind(this));
    } catch(err: any) {
        console.error("Camera error:", err);
        if (err.name === 'NotAllowedError') {
             this.qrError.set('Camera permission denied. Please allow camera access in your browser settings.');
        } else {
             this.qrError.set('Could not access camera. Is it being used by another application?');
        }
        this.isScanning.set(false);
    }
  }

  stopScan(): void {
    if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
    }
    if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
    }
    const video = this.videoElement()?.nativeElement;
    if (video) {
        video.srcObject = null;
    }
    this.isScanning.set(false);
  }

  private tick(): void {
    const video = this.videoElement()?.nativeElement;
    const canvasEl = this.canvasElement()?.nativeElement;
    
    if (video && video.readyState === video.HAVE_ENOUGH_DATA && canvasEl) {
        const canvas = canvasEl.getContext('2d', { willReadFrequently: true });
        if (canvas) {
            canvasEl.height = video.videoHeight;
            canvasEl.width = video.videoWidth;
            canvas.drawImage(video, 0, 0, canvasEl.width, canvasEl.height);
            const imageData = canvas.getImageData(0, 0, canvasEl.width, canvasEl.height);
            
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert',
            });
            
            if (code) {
                this.handleQrCode(code.data);
                return; // Stop scanning
            }
        }
    }
    // Continue scanning
    if (this.isScanning()) {
        this.animationFrameId = requestAnimationFrame(this.tick.bind(this));
    }
  }

  private async handleQrCode(qrData: string): Promise<void> {
    this.stopScan();
    this.loading.set(true); // Use main loading signal to show processing
    this.qrError.set(null);
    
    try {
        const parsedData = JSON.parse(qrData);
        if (!parsedData.userId) {
            throw new Error('Invalid QR code format.');
        }

        const { profile, dtrEntry } = await this.supabaseService.handleQrCodeLogin(parsedData.userId);

        this.qrSuccessProfile.set(profile);
        this.qrSuccessDtrEntry.set(dtrEntry);
        this.isQrSuccessModalVisible.set(true);
        
    } catch(err: any) {
        this.qrError.set(err.message || 'Failed to process QR code.');
        // Briefly show error then allow rescanning
        setTimeout(() => {
          if (this.viewMode() === 'qr') { // only restart if user hasn't switched away
             this.startScan();
          }
        }, 3000);
    } finally {
        this.loading.set(false);
    }
  }
  
  onCloseSuccessModal(): void {
    this.isQrSuccessModalVisible.set(false);
    this.qrSuccessProfile.set(null);
    this.qrSuccessDtrEntry.set(null);
    // After closing modal, go back to form view
    this.showLoginForm();
  }
}