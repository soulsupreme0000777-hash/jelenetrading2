import { Component, ChangeDetectionStrategy, input, output, signal, inject, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService, Profile, EmployeeSchedule } from '../../services/supabase.service';

type ModalState = 'loaded' | 'loading' | 'error';

interface CalendarDay {
  date: Date;
  dateStr: string; // YYYY-MM-DD
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

const SCHEDULE_TEMPLATES = {
  '8AM-5PM': { work_start_time: '08:00:00', work_end_time: '17:00:00' },
  '9AM-6PM': { work_start_time: '09:00:00', work_end_time: '18:00:00' },
  '9:30AM-6:30PM': { work_start_time: '09:30:00', work_end_time: '18:30:00' },
} as const;

type ScheduleTemplateKey = keyof typeof SCHEDULE_TEMPLATES;

@Component({
  selector: 'app-set-schedule-modal',
  templateUrl: './set-schedule-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
})
export class SetScheduleModalComponent {
  // Inputs & Outputs
  visible = input.required<boolean>();
  employees = input.required<Profile[]>();
  close = output<void>();

  private readonly supabaseService = inject(SupabaseService);

  // Component State
  modalState = signal<ModalState>('loading');
  errorMessage = signal<string | null>(null);

  // Date & Calendar State
  currentDate = signal(new Date());
  calendarDays = signal<CalendarDay[]>([]);
  readonly weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly scheduleTemplates = Object.keys(SCHEDULE_TEMPLATES) as ScheduleTemplateKey[];

  // Selection State
  selectedEmployeeIds = signal(new Set<string>());
  selectedSchedule = signal<ScheduleTemplateKey>(this.scheduleTemplates[0]);

  // Data State
  schedules = signal<Map<string, ScheduleTemplateKey>>(new Map()); // Key: 'userId-dateStr'

  isAllSelected = computed(() => {
    const employees = this.employees();
    return employees.length > 0 && this.selectedEmployeeIds().size === employees.length;
  });

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.generateCalendar();
        this.loadSchedulesForMonth();
      } else {
        this.resetState();
      }
    });
  }
  
  generateCalendar(): void {
    const date = this.currentDate();
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    
    const startDate = new Date(firstDayOfMonth);
    startDate.setDate(startDate.getDate() - firstDayOfMonth.getDay());
    
    const endDate = new Date(lastDayOfMonth);
    endDate.setDate(endDate.getDate() + (6 - lastDayOfMonth.getDay()));

    const days: CalendarDay[] = [];
    let dayIterator = new Date(startDate);
    while (dayIterator <= endDate) {
      const dayOfWeek = dayIterator.getDay();
      days.push({
        date: new Date(dayIterator),
        dateStr: dayIterator.toISOString().slice(0, 10),
        dayOfMonth: dayIterator.getDate(),
        isCurrentMonth: dayIterator.getMonth() === month,
        isToday: dayIterator.toDateString() === new Date().toDateString(),
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      });
      dayIterator.setDate(dayIterator.getDate() + 1);
    }
    this.calendarDays.set(days);
  }

  async loadSchedulesForMonth(): Promise<void> {
    this.modalState.set('loading');
    const employees = this.employees();
    if (employees.length === 0) {
      this.modalState.set('loaded');
      return;
    }

    const firstDay = this.calendarDays()[0].dateStr;
    const lastDay = this.calendarDays().slice(-1)[0].dateStr;

    try {
      const { data, error } = await this.supabaseService.getSchedulesForDateRange(
        employees.map(e => e.id),
        firstDay,
        lastDay
      );
      if (error) throw error;
      
      const scheduleMap = new Map<string, ScheduleTemplateKey>();
      (data || []).forEach(s => {
        const templateKey = Object.entries(SCHEDULE_TEMPLATES).find(
          ([_, value]) => value.work_start_time === s.work_start_time
        )?.[0] as ScheduleTemplateKey | undefined;
        
        if (templateKey) {
          scheduleMap.set(`${s.user_id}-${s.date}`, templateKey);
        }
      });
      this.schedules.set(scheduleMap);
      this.modalState.set('loaded');
    } catch (e: any) {
      this.errorMessage.set('Failed to load existing schedules.');
      this.modalState.set('error');
    }
  }

  toggleAllEmployees(): void {
    const allSelected = this.isAllSelected();
    if (allSelected) {
      this.selectedEmployeeIds.set(new Set());
    } else {
      const allIds = new Set(this.employees().map(e => e.id));
      this.selectedEmployeeIds.set(allIds);
    }
  }

  toggleEmployeeSelection(id: string): void {
    this.selectedEmployeeIds.update(currentSet => {
      const newSet = new Set(currentSet);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }

  applyScheduleToDay(dateStr: string): void {
    if (this.selectedEmployeeIds().size === 0) return;
    this.schedules.update(currentMap => {
      const newMap = new Map(currentMap);
      this.selectedEmployeeIds().forEach(userId => {
        const key = `${userId}-${dateStr}`;
        newMap.set(key, this.selectedSchedule());
      });
      return newMap;
    });
  }
  
  clearScheduleForDay(dateStr: string): void {
     if (this.selectedEmployeeIds().size === 0) return;
     this.schedules.update(currentMap => {
      const newMap = new Map(currentMap);
      this.selectedEmployeeIds().forEach(userId => {
        const key = `${userId}-${dateStr}`;
        newMap.delete(key);
      });
      return newMap;
    });
  }

  applyToAllWeekdays(): void {
    if (this.selectedEmployeeIds().size === 0) return;
    const scheduleKey = this.selectedSchedule();
    this.schedules.update(currentMap => {
      const newMap = new Map(currentMap);
      this.calendarDays().forEach(day => {
        if (day.isCurrentMonth && !day.isWeekend) {
          this.selectedEmployeeIds().forEach(userId => {
            newMap.set(`${userId}-${day.dateStr}`, scheduleKey);
          });
        }
      });
      return newMap;
    });
  }

  async saveSchedules(): Promise<void> {
    this.modalState.set('loading');
    const schedulesToUpsert: Omit<EmployeeSchedule, 'id' | 'created_at'>[] = [];
    
    this.schedules().forEach((templateKey, key) => {
      const [user_id, date] = key.split('-');
      const template = SCHEDULE_TEMPLATES[templateKey];
      schedulesToUpsert.push({
        user_id,
        date,
        work_start_time: template.work_start_time,
        work_end_time: template.work_end_time,
      });
    });

    try {
      const { error } = await this.supabaseService.upsertSchedules(schedulesToUpsert);
      if (error) throw error;
      this.closeModal();
    } catch (e: any) {
      this.errorMessage.set('Failed to save schedules.');
      this.modalState.set('loaded');
    }
  }

  previousMonth(): void {
    this.currentDate.update(d => new Date(d.getFullYear(), d.getMonth() - 1, 15));
    this.generateCalendar();
    this.loadSchedulesForMonth();
  }

  nextMonth(): void {
    this.currentDate.update(d => new Date(d.getFullYear(), d.getMonth() + 1, 15));
    this.generateCalendar();
    this.loadSchedulesForMonth();
  }

  closeModal(): void {
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('loading');
    this.currentDate.set(new Date());
    this.selectedEmployeeIds.set(new Set());
    this.schedules.set(new Map());
    this.errorMessage.set(null);
  }
}
