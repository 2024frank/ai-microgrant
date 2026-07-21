import { CalendarShell } from '@/components/ai-calendar/shell';

export default function CalendarLayout({ children }: { children: React.ReactNode }) {
  return <CalendarShell>{children}</CalendarShell>;
}
