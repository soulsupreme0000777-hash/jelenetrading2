import { Component, ChangeDetectionStrategy, input, output, signal, inject, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, DtrEntry } from '../../services/supabase.service';

// Data structure for the form
interface DtrDay {
  day: number;
  amArrival: string | null;
  amDeparture: string | null;
  pmArrival: string | null;
  pmDeparture: string | null;
  totalHours: number | null;
}

type ModalState = 'setup' | 'loading' | 'view' | 'error';

@Component({
  selector: 'app-dtr-export-modal',
  templateUrl: './dtr-export-modal.component.html',
  styleUrl: './dtr-export-modal.component.css',
  imports: [CommonModule, FormsModule, DatePipe],
})
export class DtrExportModalComponent {
  visible = input.required<boolean>();
  employee = input<Profile | null>();
  close = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  modalState = signal<ModalState>('setup');
  errorMessage = signal<string | null>(null);

  // Setup state
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

  // View state
  dtrDataForMonth = signal<DtrDay[]>([]);
  officialHours = signal<string>('8:00 AM - 5:00 PM'); // Default, will try to get from schedule
  monthName = computed(() => this.months[this.selectedMonth()].name);
  fullName = computed(() => {
    const emp = this.employee();
    if (!emp) return '';
    return `${emp.first_name || ''} ${emp.middle_name || ''} ${emp.last_name || ''}`.trim().toUpperCase();
  });

  async generateReport(): Promise<void> {
    const emp = this.employee();
    if (!emp) {
      this.errorMessage.set('No employee selected.');
      this.modalState.set('error');
      return;
    }

    this.modalState.set('loading');
    this.errorMessage.set(null);

    const year = this.selectedYear();
    const month = this.selectedMonth();

    // Dates are in UTC to avoid timezone issues when querying
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, month + 1, 1)); // Query up to the start of the next month

    try {
      const { data, error } = await this.supabaseService.getDtrEntriesForDateRange(
        startDate.toISOString(),
        endDate.toISOString()
      );

      if (error) throw error;

      const employeeEntries = (data || []).filter(d => d.user_id === emp.id);
      this.processDtrData(employeeEntries, year, month);

      this.modalState.set('view');
    } catch (e: any) {
      this.errorMessage.set(`Failed to generate report: ${e.message}`);
      this.modalState.set('error');
    }
  }
  
  private processDtrData(entries: DtrEntry[], year: number, month: number): void {
    const groupedByDay: { [day: number]: DtrEntry[] } = {};
    for (const entry of entries) {
      if (entry.time_in) {
        const entryDate = new Date(entry.time_in);
        const day = entryDate.getUTCDate();
        if (!groupedByDay[day]) {
          groupedByDay[day] = [];
        }
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
      
      const dayEntries = groupedByDay[i];
      if (!dayEntries || dayEntries.length === 0) {
        processedData.push({ day: i, amArrival: null, amDeparture: null, pmArrival: null, pmDeparture: null, totalHours: null });
        continue;
      }

      // Sort entries by time to ensure correct order
      dayEntries.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      const formatTime = (dateStr: string | null) => {
        if (!dateStr) return null;
        const date = new Date(dateStr);
        return date.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).replace(' ', '');
      };

      const amArrival = formatTime(dayEntries[0]?.time_in);
      const amDeparture = formatTime(dayEntries[0]?.time_out);
      const pmArrival = formatTime(dayEntries[1]?.time_in);
      const pmDeparture = formatTime(dayEntries[1]?.time_out);

      let totalWorkMs = 0;
      if (dayEntries[0]?.time_in && dayEntries[0]?.time_out) {
          totalWorkMs += new Date(dayEntries[0].time_out).getTime() - new Date(dayEntries[0].time_in).getTime();
      }
      if (dayEntries[1]?.time_in && dayEntries[1]?.time_out) {
          totalWorkMs += new Date(dayEntries[1].time_out).getTime() - new Date(dayEntries[1].time_in).getTime();
      }
      
      // Calculate total hours, rounding down to the nearest whole number as per the example image.
      const totalHours = totalWorkMs > 0 ? Math.floor(totalWorkMs / (1000 * 60 * 60)) : null;

      processedData.push({ day: i, amArrival, amDeparture, pmArrival, pmDeparture, totalHours });
    }

    this.dtrDataForMonth.set(processedData);
  }

  printReport(): void {
    window.print();
  }
  
  closeModal(): void {
    this.modalState.set('setup');
    this.close.emit();
  }

  backToSetup(): void {
    this.modalState.set('setup');
    this.errorMessage.set(null);
  }
}