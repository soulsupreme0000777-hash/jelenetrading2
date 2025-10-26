import { Component, ChangeDetectionStrategy, input, output, signal, viewChild, ElementRef, computed, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, NewUserPayload, UserWithProfile, Department, Profile } from '../../services/supabase.service';
import QRCode from 'qrcode';

type ModalState = 'form' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-add-employee-modal',
  templateUrl: './add-employee-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
})
export class AddEmployeeModalComponent {
  // Inputs & Outputs
  visible = input.required<boolean>();
  departments = input.required<Department[]>();
  currentUserRole = input<'superadmin' | 'admin' | 'employee' | null>();
  employeeToEdit = input<Profile | null>();
  close = output<void>();
  employeeSaved = output<void>();

  private readonly supabaseService = inject(SupabaseService);
  
  isEditMode = computed(() => !!this.employeeToEdit());

  videoElement = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  captureCanvas = viewChild<ElementRef<HTMLCanvasElement>>('captureCanvas');
  qrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('qrCanvas');

  // Form state
  employeeId = signal('');
  firstName = signal('');
  middleName = signal('');
  lastName = signal('');
  email = signal('');
  password = signal('');
  position = signal('');
  dailyRate = signal<number | null>(null);
  selectedDepartmentId = signal<string>('');
  age = signal<number | null>(null);
  mobileNumber = signal('');
  selectedRole = signal<'admin' | 'employee'>('employee');
  
  modalState = signal<ModalState>('form');
  errorMessage = signal<string | null>(null);
  newUser = signal<UserWithProfile | null>(null);
  
  isFormValid = computed(() => {
    const passwordValid = this.isEditMode() || this.password();
    return this.employeeId() && this.firstName() && this.middleName() && this.lastName() && this.email() && passwordValid && this.selectedDepartmentId() && this.position() && this.age() !== null && this.mobileNumber() && this.dailyRate() !== null;
  });
  
  isCameraOn = signal(false);
  capturedImageDataUrl = signal<string | null>(null);
  private videoStream: MediaStream | null = null;
  
  constructor() {
    effect(() => {
      if (this.visible()) {
        const emp = this.employeeToEdit();
        if (emp) {
          this.populateForm(emp);
        } else {
          this.resetState();
        }
      } else {
        this.stopCamera();
      }
    });

    effect(() => {
        const videoEl = this.videoElement();
        if (this.isCameraOn() && videoEl && this.videoStream) {
            videoEl.nativeElement.srcObject = this.videoStream;
        }
    });
  }

  private populateForm(employee: Profile): void {
    this.resetState();
    this.employeeId.set(employee.employee_id || '');
    this.firstName.set(employee.first_name || '');
    this.middleName.set(employee.middle_name || '');
    this.lastName.set(employee.last_name || '');
    this.email.set(employee.email || '');
    this.age.set(employee.age || null);
    this.mobileNumber.set(employee.mobile_number || '');
    this.selectedRole.set(employee.role === 'admin' ? 'admin' : 'employee');
    this.capturedImageDataUrl.set(employee.avatar_url || null);
    this.dailyRate.set(employee.daily_rate || null);
    this.position.set(employee.position || '');
    this.selectedDepartmentId.set(employee.department_id ? employee.department_id.toString() : '');
  }

  async startCamera(): Promise<void> {
    try {
      if (this.isCameraOn() || !navigator.mediaDevices?.getUserMedia) return;
      this.videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      this.isCameraOn.set(true);
      this.capturedImageDataUrl.set(null);
    } catch (error) {
      console.error('Error accessing camera:', error);
      this.errorMessage.set('Could not access the camera. Please check permissions.');
    }
  }

  stopCamera(): void {
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
    }
    this.isCameraOn.set(false);
    this.videoStream = null;
  }

  capturePhoto(): void {
    if (!this.isCameraOn()) return;
    
    const video = this.videoElement()?.nativeElement;
    const canvas = this.captureCanvas()?.nativeElement;

    if (video && canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
      this.capturedImageDataUrl.set(canvas.toDataURL('image/png'));
      this.stopCamera();
    }
  }
  
  private async dataUrlToImageFile(dataUrl: string, filename: string): Promise<File> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: 'image/png' });
  }

  async onSubmit(): Promise<void> {
    if (!this.isFormValid()) {
      this.errorMessage.set('Please fill out all required fields.');
      return;
    }
    
    this.modalState.set('loading');
    this.errorMessage.set(null);
    
    try {
      if (this.isEditMode()) {
        await this.handleUpdateEmployee();
      } else {
        await this.handleCreateEmployee();
      }
    } catch (error: any) {
      let displayMessage: string;
      if (error instanceof Error) {
        displayMessage = error.message;
      } else if (error && typeof error.message === 'string') {
        // Handle Supabase error objects which aren't instances of Error
        displayMessage = error.message;
      } else if (typeof error === 'string') {
        displayMessage = error;
      } else {
        displayMessage = 'An unexpected error occurred. Check the console for details.';
        console.error('An error occurred during employee creation/update:', error);
      }
      this.errorMessage.set(displayMessage);
      this.modalState.set('form');
    }
  }

  private async handleCreateEmployee(): Promise<void> {
    let imageFile: File | null = null;
    if (this.capturedImageDataUrl()) {
      imageFile = await this.dataUrlToImageFile(this.capturedImageDataUrl()!, 'profile.png');
    }

    const payload: NewUserPayload = {
      email: this.email(),
      password: this.password(),
      imageFile: imageFile,
      profileData: {
        employee_id: this.employeeId(),
        first_name: this.firstName(),
        middle_name: this.middleName(),
        last_name: this.lastName(),
        age: this.age(),
        mobile_number: this.mobileNumber(),
        position: this.position(),
        department_id: +this.selectedDepartmentId(),
        daily_rate: this.dailyRate(),
        role: this.selectedRole()
      }
    };

    const { user, profile, qrData } = await this.supabaseService.createNewUser(payload);
    this.newUser.set({ ...user, profile } as UserWithProfile);
    this.modalState.set('success');
    
    setTimeout(() => this.generateQrCode(qrData), 0);
  }

  private async handleUpdateEmployee(): Promise<void> {
    const employee = this.employeeToEdit();
    if (!employee) throw new Error("No employee selected for editing.");
    
    const profileData: Partial<Profile> = {
      employee_id: this.employeeId(),
      first_name: this.firstName(),
      middle_name: this.middleName(),
      last_name: this.lastName(),
      age: this.age(),
      mobile_number: this.mobileNumber(),
      position: this.position(),
      department_id: +this.selectedDepartmentId(),
      daily_rate: this.dailyRate(),
      role: this.selectedRole()
    };
    
    const { error } = await this.supabaseService.updateUserProfile(employee.id, profileData);
    if (error) {
      console.error('Error updating employee profile:', error);
      // Re-throw the original Supabase error object so the catch block can handle it.
      throw error;
    }
    
    this.modalState.set('success');
  }
  
  private generateQrCode(data: string): void {
    const canvas = this.qrCanvas()?.nativeElement;
    if (canvas && data) {
      QRCode.toCanvas(canvas, data, { width: 200, margin: 2 }, (error: any) => {
        if (error) console.error('Failed to generate QR Code:', error);
      });
    }
  }
  
  downloadQrCode(): void {
    const canvas = this.qrCanvas()?.nativeElement;
    const newUser = this.newUser();
    if (canvas && newUser?.profile) {
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const firstName = newUser.profile.first_name || 'employee';
      const lastName = newUser.profile.last_name || '';
      link.download = `qr-code-${firstName}-${lastName}.png`.replace(/ /g, '-').toLowerCase();
      link.href = dataUrl;
      link.click();
    }
  }

  finish(): void {
    this.employeeSaved.emit();
    this.closeModal();
  }

  closeModal(): void {
    this.stopCamera();
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('form');
    this.errorMessage.set(null);
    this.employeeId.set('');
    this.firstName.set('');
    this.middleName.set('');
    this.lastName.set('');
    this.email.set('');
    this.password.set('');
    this.position.set('');
    this.dailyRate.set(null);
    this.selectedDepartmentId.set('');
    this.age.set(null);
    this.mobileNumber.set('');
    this.capturedImageDataUrl.set(null);
    this.newUser.set(null);
    this.selectedRole.set('employee');
  }
}
