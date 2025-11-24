import { Component, ChangeDetectionStrategy, input, output, signal, inject, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, DtrEntry } from '../../services/supabase.service';

interface DtrDay {
  day: number;
  amArrival: string | null;
  amDeparture: string | null;
  pmArrival: string | null;
  pmDeparture: string | null;
  totalHours: number | null;
}

interface EmployeeDtrReport {
  employee: Profile;
  dtrData: DtrDay[];
  officialHours: string;
}

type ModalState = 'setup' | 'loading' | 'view' | 'error';

@Component({
  selector: 'app-dtr-bulk-export-modal',
  templateUrl: './dtr-bulk-export-modal.component.html',
  styleUrl: './dtr-bulk-export-modal.component.css',
  imports: [CommonModule, FormsModule, DatePipe],
  standalone: true,
})
export class DtrBulkExportModalComponent {
  visible = input.required<boolean>();
  employeeIds = input.required<string[]>();
  employees = input.required<Profile[]>();
  close = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  modalState = signal<ModalState>('setup');
  errorMessage = signal<string | null>(null);

  currentYear = new Date().getFullYear();
  selectedYear = signal(this.currentYear);
  selectedMonth = signal(new Date().getMonth());
  years = Array.from({ length: 10 }, (_, i) => this.currentYear - i);
  months = [
    { value: 0, name: 'January' }, { value: 1, name: 'February' },
    { value: 2, name: 'March' }, { value: 3, name: 'April' },
    { value: 4, name: 'May' }, { value: 5, name: 'June' },
    { value: 6, name: 'July' }, { value: 7, name: 'August' },
    { value: 8, name: 'September' }, { value: 9, name: 'October' },
    { value: 10, name: 'November' }, { value: 11, name: 'December' },
  ];

  reports = signal<EmployeeDtrReport[]>([]);
  monthName = computed(() => this.months[this.selectedMonth()].name);

  async generateReport(): Promise<void> {
    const ids = this.employeeIds();
    if (!ids || ids.length === 0) {
      this.errorMessage.set('No employees selected.');
      this.modalState.set('error');
      return;
    }

    this.modalState.set('loading');
    this.errorMessage.set(null);

    const year = this.selectedYear();
    const month = this.selectedMonth();
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, month + 1, 1));

    try {
      const { data, error } = await this.supabaseService.getDtrEntriesForUsersInDateRange(
        ids,
        startDate.toISOString(),
        endDate.toISOString()
      );

      if (error) throw error;
      const allEntries = data || [];
      const generatedReports: EmployeeDtrReport[] = [];

      for (const employeeId of ids) {
        const employee = this.employees().find(e => e.id === employeeId);
        if (!employee) continue;

        const employeeEntries = allEntries.filter(e => e.user_id === employeeId);
        const dtrData = this.processDtrDataForEmployee(employeeEntries, year, month);
        
        generatedReports.push({
          employee,
          dtrData,
          officialHours: '8:00 AM - 5:00 PM' // Assuming a default for now
        });
      }

      this.reports.set(generatedReports);
      this.modalState.set('view');
    } catch (e: any) {
      this.errorMessage.set(`Failed to generate reports: ${e.message}`);
      this.modalState.set('error');
    }
  }

  private processDtrDataForEmployee(entries: DtrEntry[], year: number, month: number): DtrDay[] {
    const groupedByDay: { [day: number]: DtrEntry[] } = {};
    for (const entry of entries) {
      if (entry.time_in) {
        const day = new Date(entry.time_in).getUTCDate();
        if (!groupedByDay[day]) groupedByDay[day] = [];
        groupedByDay[day].push(entry);
      }
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const processedData: DtrDay[] = [];

    for (let i = 1; i <= 31; i++) {
      if (i > daysInMonth) {
        processedData.push({ day: i, amArrival: null, amDeparture: null, pmArrival: null, pmDeparture: null, totalHours: null });
        continue;
      }
      
      const dayEntries = groupedByDay[i] || [];
      dayEntries.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      const formatTime = (dateStr: string | null) => {
        if (!dateStr) return null;
        return new Date(dateStr).toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).replace(' ', '');
      };

      let totalWorkMs = 0;
      if (dayEntries[0]?.time_in && dayEntries[0]?.time_out) {
          totalWorkMs += new Date(dayEntries[0].time_out).getTime() - new Date(dayEntries[0].time_in).getTime();
      }
      if (dayEntries[1]?.time_in && dayEntries[1]?.time_out) {
          totalWorkMs += new Date(dayEntries[1].time_out).getTime() - new Date(dayEntries[1].time_in).getTime();
      }
      const totalHours = totalWorkMs > 0 ? Math.floor(totalWorkMs / 3600000) : null;

      processedData.push({
        day: i,
        amArrival: formatTime(dayEntries[0]?.time_in),
        amDeparture: formatTime(dayEntries[0]?.time_out),
        pmArrival: formatTime(dayEntries[1]?.time_in),
        pmDeparture: formatTime(dayEntries[1]?.time_out),
        totalHours
      });
    }
    return processedData;
  }

  printReport(): void {
    window.print();
  }

  closeModal(): void {
    this.modalState.set('setup');
    this.reports.set([]);
    this.close.emit();
  }

  backToSetup(): void {
    this.modalState.set('setup');
    this.reports.set([]);
    this.errorMessage.set(null);
  }
}