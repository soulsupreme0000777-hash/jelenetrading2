import { inject, effect, untracked } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from './services/supabase.service';

export const authGuard: CanActivateFn = () => {
  const supabaseService = inject(SupabaseService);
  // FIX: Explicitly type `router` to `Router` to fix type inference issues.
  const router: Router = inject(Router);

  // Use a promise that resolves once the Supabase service is initialized.
  return new Promise<boolean>((resolve) => {
    // This effect runs whenever the isInitialized signal changes.
    const watcher = effect(() => {
      // Wait for the service to signal that the initial auth state has been determined.
      if (supabaseService.isInitialized()) {
        const user = supabaseService.currentUser();
        untracked(() => {
          watcher.destroy(); // Stop watching for further changes.
          if (user) {
            resolve(true); // User is logged in, allow access.
          } else {
            router.navigate(['/login']);
            resolve(false); // User is not logged in, redirect.
          }
        });
      }
    });
  });
};
