import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { SupabaseService } from '../../services/supabase.service';
import { AdminDashboardComponent } from '../admin-dashboard/admin-dashboard.component';
import { EmployeeDashboardComponent } from '../employee-dashboard/employee-dashboard.component';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminDashboardComponent, EmployeeDashboardComponent],
})
export class DashboardComponent {
  private readonly supabaseService = inject(SupabaseService);

  userProfile = this.supabaseService.currentUserProfile;
  profileError = this.supabaseService.profileError;
  
  /**
   * Checks if the currently logged-in user is an administrator
   * by inspecting their role from the centralized service state.
   */
  isAdmin = computed(() => {
    const role = this.supabaseService.currentUserRole();
    return role === 'admin' || role === 'superadmin';
  });
}