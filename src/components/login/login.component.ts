import { Component, ChangeDetectionStrategy, signal, inject, effect, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService } from '../../services/supabase.service';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
})
export class LoginComponent {
  // State Signals
  loading = signal(false);
  errorMessage = signal<string | null>(null);

  // Services & Router
  private readonly supabaseService = inject(SupabaseService);
  private readonly router: Router = inject(Router);
  // FIX: Explicitly type `FormBuilder` to prevent the compiler from inferring it as `unknown`.
  private readonly fb: FormBuilder = inject(FormBuilder);

  loginForm: FormGroup;

  constructor() {
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required]],
    });
    
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
  }
  
  async onSubmit(): Promise<void> {
    if (this.loginForm.invalid) {
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    this.loginForm.disable();

    try {
      const { email, password } = this.loginForm.value;
      
      const { error } = await this.supabaseService.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw error;
      }
      // On success, the effect in the constructor will handle the redirection.
    } catch (error: any) {
      if (error.message === 'Invalid login credentials') {
          this.errorMessage.set(`Invalid email or password. Please try again.`);
      } else {
          this.errorMessage.set(error.message || 'An unexpected error occurred during login.');
      }
    } finally {
      this.loading.set(false);
      this.loginForm.enable();
    }
  }
}
