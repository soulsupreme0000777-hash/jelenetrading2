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

  // This signal tracks the month/year being viewed, anchored to PST.
  // 'en-US' is a safe locale for parsing the date string.
  currentDate = signal(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })));
  calendarDays = signal<CalendarDay[]>([]);
  readonly weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly scheduleTemplates = Object.keys(SCHEDULE_TEMPLATES) as ScheduleTemplateKey[];

  // Selection State
  selectedEmployeeIds = signal(new Set<string>());
  selectedSchedule = signal<ScheduleTemplateKey>(this.scheduleTemplates[0]);

  // Data State
  schedules = signal<Map<string, ScheduleTemplateKey>>(new Map()); // Key: 'userId|dateStr'
  initialSchedules = signal<Map<string, ScheduleTemplateKey>>(new Map());

  isAllSelected = computed(() => {
    const employees = this.employees();
    return employees.length > 0 && this.selectedEmployeeIds().size === employees.length;
  });

  constructor() {
    effect(() => {
      if (this.visible()) {
        // Reset to current PST month when modal opens for consistency
        this.currentDate.set(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })));
        this.generateCalendar();
        this.loadSchedulesForMonth();
      } else {
        this.resetState();
      }
    });
  }
  
  generateCalendar(): void {
    const viewingDate = this.currentDate();
    const year = viewingDate.getFullYear();
    const month = viewingDate.getMonth();

    // Use LOCAL date parts from our PST-based date to construct UTC dates.
    // This prevents the user's local timezone from interfering with calendar generation.
    const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0));
    
    const startDayOfWeek = firstDayOfMonth.getUTCDay();
    const startDate = new Date(firstDayOfMonth);
    startDate.setUTCDate(startDate.getUTCDate() - startDayOfWeek);
    
    const endDayOfWeek = lastDayOfMonth.getUTCDay();
    const endDate = new Date(lastDayOfMonth);
    endDate.setUTCDate(endDate.getUTCDate() + (6 - endDayOfWeek));

    const days: CalendarDay[] = [];
    let dayIterator = new Date(startDate);
    
    // --- DEFINITIVE FIX: Use Intl.DateTimeFormat for robust, standards-based timezone handling. ---
    const timeZone = 'Asia/Manila';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());

    const yearToday = parts.find(p => p.type === 'year')!.value;
    const monthToday = parts.find(p => p.type === 'month')!.value;
    const dayToday = parts.find(p => p.type === 'day')!.value;
    const todayPstStr = `${yearToday}-${monthToday}-${dayToday}`;


    while (dayIterator <= endDate) {
      // The iterator is built from UTC components, so its ISO string's date part
      // correctly represents the date in our target timezone (PST).
      const dateStr = dayIterator.toISOString().slice(0, 10);
      const dayOfWeek = dayIterator.getUTCDay();
      
      days.push({
        date: new Date(dayIterator),
        dateStr: dateStr,
        dayOfMonth: dayIterator.getUTCDate(),
        isCurrentMonth: dayIterator.getUTCMonth() === month,
        isToday: dateStr === todayPstStr,
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      });
      dayIterator.setUTCDate(dayIterator.getUTCDate() + 1);
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
          scheduleMap.set(`${s.user_id}|${s.date}`, templateKey);
        }
      });
      this.schedules.set(scheduleMap);
      this.initialSchedules.set(new Map(scheduleMap));
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
        const key = `${userId}|${dateStr}`;
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
        const key = `${userId}|${dateStr}`;
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
            newMap.set(`${userId}|${day.dateStr}`, scheduleKey);
          });
        }
      });
      return newMap;
    });
  }

  async saveSchedules(): Promise<void> {
    this.modalState.set('loading');
    
    const schedulesToUpsert: Omit<EmployeeSchedule, 'id' | 'created_at'>[] = [];
    const finalScheduleKeys = new Set<string>();

    // Prepare all current schedules for upsert
    this.schedules().forEach((templateKey, key) => {
      const [user_id, date] = key.split('|');
      const template = SCHEDULE_TEMPLATES[templateKey];
      schedulesToUpsert.push({
        user_id,
        date,
        work_start_time: template.work_start_time,
        work_end_time: template.work_end_time,
      });
      finalScheduleKeys.add(key);
    });

    // Determine which schedules to delete by comparing the initial state to the final state
    const schedulesToDelete: { userId: string; date: string }[] = [];
    this.initialSchedules().forEach((_, key) => {
      if (!finalScheduleKeys.has(key)) {
        // This key was in the initial map but not the final one, so it was cleared.
        const [userId, date] = key.split('|');
        schedulesToDelete.push({ userId, date });
      }
    });

    try {
      const upsertPromise = this.supabaseService.upsertSchedules(schedulesToUpsert);
      const deletePromise = this.supabaseService.deleteSchedules(schedulesToDelete);

      const [upsertResult, deleteResults] = await Promise.all([upsertPromise, deletePromise]);

      if (upsertResult.error) throw upsertResult.error;
      const deleteError = (deleteResults as any[]).find(res => res.error);
      if (deleteError) throw deleteError.error;

      this.closeModal();
    } catch (e: any) {
      this.errorMessage.set(`Failed to save schedules: ${e.message}`);
      this.modalState.set('loaded');
    }
  }

  previousMonth(): void {
    this.currentDate.update(d => {
      const newDate = new Date(d);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
    this.generateCalendar();
    this.loadSchedulesForMonth();
  }

  nextMonth(): void {
    this.currentDate.update(d => {
      const newDate = new Date(d);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
    this.generateCalendar();
    this.loadSchedulesForMonth();
  }

  closeModal(): void {
    this.close.emit();
  }

  private resetState(): void {
    this.modalState.set('loading');
    this.currentDate.set(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })));
    this.selectedEmployeeIds.set(new Set());
    this.schedules.set(new Map());
    this.initialSchedules.set(new Map());
    this.errorMessage.set(null);
  }
}
