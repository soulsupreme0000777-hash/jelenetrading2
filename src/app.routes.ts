import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { authGuard } from './auth.guard';
import { TimeClockPageComponent } from './components/time-clock-page/time-clock-page.component';

export const routes: Routes = [
  { 
    path: 'login', 
    component: LoginComponent
  },
  { 
    path: 'dashboard', 
    component: DashboardComponent,
    canActivate: [authGuard] 
  },
  {
    path: 'time-clock',
    component: TimeClockPageComponent,
    canActivate: [authGuard]
  },
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: '**', redirectTo: '/login' }
];