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
    email: new FormControl('admin@gmail.com', [Validators.required, Validators.email]),
    password: new FormControl('123456', [Validators.required]),
  });

  // State Signals
  loading = signal(false);
  errorMessage = signal<string | null>(null);

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
  }

  // Helper getters for template
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
}