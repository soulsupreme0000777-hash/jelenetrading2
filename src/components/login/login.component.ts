import { Component, ChangeDetectionStrategy, signal, inject, effect, untracked } from '@angular/core';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule]
})
export class LoginComponent {
  // Form Group for password login
  loginForm = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required]),
  });

  // State Signals
  loading = signal(false);
  errorMessage = signal<string | null>(null);
  passwordVisible = signal(false);

  // Services & Router
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);

  constructor() {
    // This effect handles two scenarios:
    // 1. If the user is already logged in (e.g., has a valid session in localStorage),
    //    it redirects them from the login page to the dashboard automatically.
    // 2. After a successful sign-in, the supabaseService updates the currentUser signal,
    //    which triggers this effect to navigate to the dashboard.
    effect(() => {
      if (this.supabaseService.isInitialized() && this.supabaseService.currentUser()) {
        untracked(() => {
          this.router.navigate(['/dashboard']);
        });
      }
    });

    // Disable form when loading to prevent multiple submissions
    effect(() => {
      const isLoading = this.loading();
      if (isLoading) {
        this.loginForm.disable();
      } else {
        this.loginForm.enable();
      }
    });
  }

  // Helper getters for template to simplify access
  get email() { return this.loginForm.get('email'); }
  get password() { return this.loginForm.get('password'); }

  togglePasswordVisibility(): void {
    this.passwordVisible.update(visible => !visible);
  }

  async onSubmit(): Promise<void> {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched(); // Show validation errors
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
      if (error) {
        // Throw the error to be caught by the catch block
        throw error;
      }
      // On success, the effect in the constructor will handle the redirection.
    } catch (error: any) {
      // Set a user-friendly error message
      if (error.message === 'Invalid login credentials') {
          this.errorMessage.set('Incorrect email or password. Please try again.');
      } else {
          this.errorMessage.set(error.message || 'An unexpected error occurred during login.');
      }
    } finally {
      this.loading.set(false);
    }
  }
}
