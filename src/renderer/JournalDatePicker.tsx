import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { dateFromISO } from './dailyNote.js';

// Anchored popover wrapping the shadcn Calendar (react-day-picker under the
// hood — it owns the calendar math: DST, locale-first-day-of-week).
// Closes on Esc or outside click. `anchor` is a {x, y} client-coords point
// (from a right-click), so this positions itself manually rather than using a
// Radix popover, which needs a DOM anchor element.
//
// `today` is a YYYY-MM-DD calendar date from App, in the user's configured
// timezone. react-day-picker wants a `Date`, so it's converted at local midnight
// — the calendar is a grid of labelled days, not a set of instants, and the day
// highlighted as today must be the day the calendar button would open.
export default function JournalDatePicker({ open, anchor, today, initialDate, onPick, onClose }: any) {
  const ref = useRef<any>(null);
  // Derived from primitives (an ISO string) rather than a shared Date object, so
  // the effect below keys on a value that's stable across renders.
  // `dateFromISO` returns null for anything malformed, hence the final fallback.
  const shown = initialDate ?? dateFromISO(today) ?? new Date();
  const [month, setMonth] = useState(shown);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!open) return;
    setMonth(initialDate ?? dateFromISO(today) ?? new Date());
  }, [open, initialDate, today]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !anchor) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + margin > window.innerWidth) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = window.innerHeight - rect.height - margin;
    }
    left = Math.max(margin, left);
    top = Math.max(margin, top);
    setPos({ left, top });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="fixed z-50 rounded-md border bg-popover text-popover-foreground shadow-md"
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label="Pick a journal date"
    >
      <Calendar
        mode="single"
        month={month}
        onMonthChange={setMonth}
        selected={shown}
        onSelect={(d) => { if (d) onPick(d); }}
        showOutsideDays
        captionLayout="label"
      />
    </div>
  );
}
