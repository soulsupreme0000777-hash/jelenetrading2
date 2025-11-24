import { Component, ChangeDetectionStrategy, input, output, signal, viewChild, ElementRef, computed, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SupabaseService, NewUserPayload, UserWithProfile, Profile, Position, Branch, PositionRate } from '../../services/supabase.service';
import QRCode from 'qrcode';
import { ConfirmationModalComponent } from '../confirmation-modal/confirmation-modal.component';

type ModalState = 'form' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-add-employee-modal',
  templateUrl: './add-employee-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmationModalComponent],
})
export class AddEmployeeModalComponent {
  // Inputs & Outputs
  visible = input.required<boolean>();
  currentUserRole = input<'superadmin' | 'admin' | 'employee' | null>();
  employeeToEdit = input<Profile | null>();
  close = output<void>();
  employeeSaved = output<void>();

  private readonly supabaseService = inject(SupabaseService);
  
  // Dynamic data from DB
  positions = signal<Position[]>([]);
  branches = signal<Branch[]>([]);
  positionRates = signal<PositionRate[]>([]);

  isEditMode = computed(() => !!this.employeeToEdit());

  qrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('qrCanvas');

  // Form state
  employeeId = signal('');
  firstName = signal('');
  middleName = signal('');
  lastName = signal('');
  email = signal('');
  password = signal('');
  confirmPassword = signal('');
  positionId = signal<number | ''>('');
  branchId = signal<number | ''>('');
  mobileNumber = signal('');
  hireDate = signal('');
  birthDate = signal('');
  selectedRole = signal<'admin' | 'employee'>('employee');
  avatarPreviewUrl = signal<string | null>(null);
  selectedFile = signal<File | null>(null);
  
  modalState = signal<ModalState>('form');
  errorMessage = signal<string | null>(null);
  newUser = signal<UserWithProfile | null>(null);
  
  isConfirmCancelVisible = signal(false);
  private initialFormState = signal<Partial<Profile & { password?: string, confirmPassword?: string }>>({});
  
  age = computed<number | null>(() => {
    const birthDateStr = this.birthDate();
    if (!birthDateStr) return null;

    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDateStr)) return null;
      const birthDate = new Date(birthDateStr);
      const today = new Date();
      if (isNaN(birthDate.getTime()) || birthDate > today) return null;
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDifference = today.getMonth() - birthDate.getMonth();
      if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
      return age >= 0 ? age : null;
    } catch (e) {
      return null;
    }
  });

  dailyRate = computed<number | null>(() => {
    const posId = this.positionId();
    const braId = this.branchId();
    if (posId && braId) {
      const rate = this.positionRates().find(r => r.position_id === posId && r.branch_id === braId);
      return rate ? rate.daily_rate : null;
    }
    return null;
  });

  passwordMatch = computed(() => this.isEditMode() || this.password() === this.confirmPassword());
  
  isFormValid = computed(() => {
    const passwordValid = this.isEditMode() || (this.password() && this.password().length >= 6 && this.passwordMatch());
    return this.employeeId() && this.firstName() && this.middleName() && this.lastName() && this.email() && passwordValid && this.positionId() && this.branchId() && this.age() !== null && this.mobileNumber() && this.hireDate() && this.birthDate();
  });

  isDirty = computed(() => {
    const initial = this.initialFormState();
    if (this.selectedFile() !== null) {
      return true;
    }

    if (this.isEditMode()) {
        return (
            this.employeeId() !== (initial.employee_id || '') ||
            this.firstName() !== (initial.first_name || '') ||
            this.middleName() !== (initial.middle_name || '') ||
            this.lastName() !== (initial.last_name || '') ||
            this.mobileNumber() !== (initial.mobile_number || '') ||
            this.hireDate() !== (initial.hire_date || '') ||
            this.birthDate() !== (initial.birth_date || '') ||
            this.selectedRole() !== (initial.role === 'admin' ? 'admin' : 'employee') ||
            this.positionId() !== ((initial.position_id as number | null) || '') ||
            this.branchId() !== ((initial.branch_id as number | null) || '')
        );
    } else {
        return (
            this.employeeId() !== '' ||
            this.firstName() !== '' ||
            this.middleName() !== '' ||
            this.lastName() !== '' ||
            this.email() !== '' ||
            this.password() !== '' ||
            this.confirmPassword() !== '' ||
            this.mobileNumber() !== '' ||
            this.hireDate() !== '' ||
            this.birthDate() !== '' ||
            this.positionId() !== '' ||
            this.branchId() !== ''
        );
    }
  });
  
  constructor() {
    this.loadDynamicData();

    effect(() => {
      if (this.visible()) {
        const emp = this.employeeToEdit();
        if (emp) {
          this.populateForm(emp);
          this.initialFormState.set({ // Store initial state for dirty checking
            employee_id: emp.employee_id,
            first_name: emp.first_name,
            middle_name: emp.middle_name,
            last_name: emp.last_name,
            mobile_number: emp.mobile_number,
            hire_date: emp.hire_date,
            birth_date: emp.birth_date,
            role: emp.role,
            position_id: emp.position_id,
            branch_id: emp.branch_id,
            avatar_url: emp.avatar_url,
          });
        } else {
          this.resetState();
          this.initialFormState.set({}); // Reset for "add" mode
        }
      }
    });
  }

  async loadDynamicData() {
    try {
        const [positionsRes, branchesRes, ratesRes] = await Promise.all([
            this.supabaseService.getPositions(),
            this.supabaseService.getBranches(),
            this.supabaseService.getPositionRates()
        ]);
        if (positionsRes.error) throw positionsRes.error;
        this.positions.set(positionsRes.data || []);
        if (branchesRes.error) throw branchesRes.error;
        this.branches.set(branchesRes.data || []);
        if (ratesRes.error) throw ratesRes.error;
        this.positionRates.set(ratesRes.data || []);
    } catch (e: any) {
        this.errorMessage.set(`Failed to load form data: ${e.message}`);
    }
  }


  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        this.errorMessage.set('File is too large. Maximum size is 5MB.');
        return;
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        this.errorMessage.set('Invalid file type. Only JPG, PNG, and WEBP are allowed.');
        return;
      }
      
      this.selectedFile.set(file);
      this.avatarPreviewUrl.set(URL.createObjectURL(file));
      this.errorMessage.set(null); // Clear previous errors

      input.value = ''; // Reset input so the same file can be chosen again
    }
  }

  private populateForm(employee: Profile): void {
    this.resetState();
    this.employeeId.set(employee.employee_id || '');
    this.firstName.set(employee.first_name || '');
    this.middleName.set(employee.middle_name || '');
    this.lastName.set(employee.last_name || '');
    this.email.set(employee.email || '');
    this.mobileNumber.set(employee.mobile_number || '');
    this.hireDate.set(employee.hire_date || '');
    this.birthDate.set(employee.birth_date || '');
    this.selectedRole.set(employee.role === 'admin' ? 'admin' : 'employee');
    this.positionId.set(employee.position_id || '');
    this.branchId.set(employee.branch_id || '');
    this.avatarPreviewUrl.set(employee.avatar_url || null);
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
    } catch (error: unknown) {
      let displayMessage = 'An unexpected error occurred. Please try again.';

      console.error('Caught error during employee submission:', error);

      if (error instanceof Error) {
        displayMessage = error.message;
      } else if (error && typeof error === 'object' && 'message' in error && typeof (error as any).message === 'string') {
        displayMessage = (error as { message: string }).message;
      } else if (typeof error === 'string' && error) {
        displayMessage = error;
      }
      
      if (displayMessage.includes('duplicate key value violates unique constraint')) {
        if (displayMessage.includes('profiles_employee_id_key')) {
          displayMessage = 'This Employee ID is already in use. Please choose a different one.';
        } else {
          displayMessage = 'A profile with this Employee ID or Email already exists.';
        }
      } else if (displayMessage.includes('User already registered')) {
          displayMessage = 'A user with this email address already exists.';
      } else if (displayMessage.includes('Password should be at least 6 characters')) {
          displayMessage = 'Password must be at least 6 characters long.';
      }

      this.errorMessage.set(displayMessage);
      this.modalState.set('form');
    }
  }

  private async handleCreateEmployee(): Promise<void> {
    const selectedPosition = this.positions().find(p => p.id === this.positionId());
    const selectedBranch = this.branches().find(b => b.id === this.branchId());

    const payload: NewUserPayload = {
      email: this.email(),
      password: this.password(),
      profileData: {
        employee_id: this.employeeId(),
        first_name: this.firstName(),
        middle_name: this.middleName(),
        last_name: this.lastName(),
        age: this.age(),
        mobile_number: this.mobileNumber(),
        position: selectedPosition?.name as Profile['position'],
        branch: selectedBranch?.name as Profile['branch'],
        position_id: this.positionId() as number,
        branch_id: this.branchId() as number,
        daily_rate: this.dailyRate(),
        role: this.selectedRole(),
        hire_date: this.hireDate(),
        birth_date: this.birthDate(),
        day_off_balance: 3,
        sil_balance: 0,
      }
    };

    const { user, profile, qrData } = await this.supabaseService.createNewUser(payload);
    
    if (this.selectedFile()) {
      const avatarUrl = await this.supabaseService.uploadAvatar(user.id, this.selectedFile()!);
      const { error } = await this.supabaseService.updateUserProfile(user.id, { avatar_url: avatarUrl });
      if (error) {
          // Log the error but continue, as the user is already created.
          console.error('User created, but failed to update avatar:', error.message);
      } else {
          profile.avatar_url = avatarUrl;
      }
    }
    
    this.newUser.set({ ...user, profile } as UserWithProfile);
    this.modalState.set('success');
    
    setTimeout(() => this.generateQrCode(qrData), 0);
  }

  private async handleUpdateEmployee(): Promise<void> {
    const employee = this.employeeToEdit();
    if (!employee) throw new Error("No employee selected for editing.");
    
    const selectedPosition = this.positions().find(p => p.id === this.positionId());
    const selectedBranch = this.branches().find(b => b.id === this.branchId());

    const profileData: Partial<Profile> = {
      first_name: this.firstName(),
      middle_name: this.middleName(),
      last_name: this.lastName(),
      age: this.age(),
      mobile_number: this.mobileNumber(),
      position: selectedPosition?.name as Profile['position'],
      branch: selectedBranch?.name as Profile['branch'],
      position_id: this.positionId() as number,
      branch_id: this.branchId() as number,
      daily_rate: this.dailyRate(),
      role: this.selectedRole(),
      birth_date: this.birthDate(),
    };
    
    if (this.selectedFile()) {
        profileData.avatar_url = await this.supabaseService.uploadAvatar(employee.id, this.selectedFile()!);
    }

    const { error } = await this.supabaseService.updateUserProfile(employee.id, profileData);
    if (error) {
      console.error('Error updating employee profile:', error);
      throw error;
    }
    
    this.modalState.set('success');
  }
  
  private generateQrCode(data: string): void {
    const canvas = this.qrCanvas()?.nativeElement;
    if (canvas && data) {
      QRCode.toCanvas(canvas, data, { width: 200, margin: 2 }, (error: any) => {
        if (error) console.error('Failed to generate QR Code:', error.message || error);
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
    this.closeModalAndReset();
  }

  closeModal(): void {
    if (this.isDirty() && this.modalState() === 'form') {
      this.isConfirmCancelVisible.set(true);
    } else {
      this.close.emit();
    }
  }

  handleConfirmCancel(): void {
    this.isConfirmCancelVisible.set(false);
    this.close.emit();
  }

  handleAbortCancel(): void {
    this.isConfirmCancelVisible.set(false);
  }

  private closeModalAndReset(): void {
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
    this.confirmPassword.set('');
    this.positionId.set('');
    this.branchId.set('');
    this.mobileNumber.set('');
    this.hireDate.set('');
    this.birthDate.set('');
    this.newUser.set(null);
    this.selectedRole.set('employee');
    this.avatarPreviewUrl.set(null);
    this.selectedFile.set(null);
  }
}