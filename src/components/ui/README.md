# UI Primitives (`@/components/ui`)

A small, typed, accessible component layer for the app. It exists to kill the
inline-`style={{…}}` sprawl that re-implemented the same green design system in
every page, and to give us reusable building blocks with consistent loading,
empty, and error states.

```ts
import { Button, Badge, Card, Input, Select, DataTable, EmptyState } from '@/components/ui';
```

---

## Architecture

```
src/components/ui/
  index.ts            ← barrel: import everything from here
  cn.ts               ← classname joiner (no deps)
  README.md           ← you are here
  <Component>.tsx     ← one component per file, JSDoc'd props
  <Component>.module.css
  Field.module.css    ← shared by Input + Select
```

**Three layers, by design:**

1. **Tokens** — CSS custom properties in [`src/app/globals.css`](../../app/globals.css)
   (`--green-primary`, `--radius-md`, `--shadow-md`, `--tone-amber-bg`, …). The
   single source of truth for the look. Re-theme the whole system by editing
   these; no component hardcodes a hex value.
2. **Styling** — **CSS Modules** (`*.module.css`), locally scoped so class names
   never collide. We use CSS Modules (not Tailwind, which is installed but
   unused here) because it matches the codebase's existing CSS-variable
   convention and supports `:hover` / `:focus-visible` / `@media` /
   `prefers-reduced-motion` natively — things inline styles can't express.
3. **Components** — thin, typed React wrappers that map a small prop API onto
   token-driven classes via `cn(...)`.

**Server/Client boundary.** Most primitives have **no `'use client'`** directive,
so they render in either a Server or Client tree (they adopt their importer's
environment). Only `Input` and `Select` are client components, because they call
the `useId` hook. Keep new primitives directive-free unless they genuinely need
hooks or browser APIs.

---

## Conventions (the component contract)

Every component follows the same rules so they're predictable to use:

- **Extends the native element.** Props extend `React.ButtonHTMLAttributes`,
  `InputHTMLAttributes`, etc. — so `aria-*`, `data-*`, `onClick`, `name`,
  `disabled`, … all pass straight through.
- **`className` is always merged, never replaced** — you can extend any
  component from the outside without fighting it.
- **Refs are forwarded** on focusable form controls (`Button`, `Input`,
  `Select`) for focus management and composition.
- **Variants are props, not new components** (`variant`, `tone`, `size`) — one
  import, many looks.
- **Sensible, safe defaults**: `Button` is `type="button"`, form fields wire
  their own `id`/`aria-describedby`, `Pagination` renders nothing for ≤1 page.

---

## Components & key props

| Component | What it replaces | Notable props |
|---|---|---|
| `Button` | `.btn-*` classes, inline buttons | `variant` `primary\|ghost\|danger\|subtle`, `size`, `loading`, `leftIcon`/`rightIcon`, `fullWidth` |
| `Badge` | `STATUS_STYLES` maps, inline pills | `status` (auto tone+label), `tone`, `icon`, `size` |
| `Card` | `.card` | `as`, `padding none\|sm\|md\|lg`, `interactive` |
| `Avatar` | inline initials circle | `name`, `src`, `size`, `tone` |
| `Input` | inline `<input>` + search icon | `label`, `hideLabel`, `error`, `hint`, `leftIcon`/`rightIcon` |
| `Select` | inline `<select>` filters | `label`, `placeholder`, `error`, `hint` |
| `Spinner` | "Loading…" text | `size`, `label` (announce vs decorative) |
| `Skeleton` | — (new) | `width`, `height`, `circle`, `radius` |
| `EmptyState` | inline empty `<div>`s | `icon`, `title`, `description`, `action` |
| `Pagination` | inline prev/next | `page` (0-indexed), `pageCount`, `onPageChange` |
| `DataTable<T>` | hand-rolled `<table>`s | `columns`, `data`, `getRowId`, `loading`, `empty`, `onRowClick` |

---

## Usage examples

### Buttons

```tsx
<Button onClick={save}>Save</Button>
<Button variant="ghost" leftIcon={<Plus size={14} />}>Add source</Button>
<Button variant="danger" loading={deleting} loadingText="Deleting…">Delete</Button>
```

### Status badge

```tsx
<Badge status={event.status} />          {/* auto colour + label */}
<Badge tone="green">Hyper-local</Badge>
```

### Accessible form fields

```tsx
<Input
  label="Search events"
  hideLabel                 // label kept for screen readers
  placeholder="Search events…"
  leftIcon={<Search size={14} />}
  value={q}
  onChange={(e) => setQ(e.target.value)}
/>

<Select label="Source" placeholder="All sources" value={sourceId} onChange={…}>
  {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
</Select>
```

### Data table with loading + empty states

```tsx
<DataTable
  data={events}
  getRowId={(e) => e.id}
  loading={loading}
  onRowClick={(e) => router.push(`/reviewer/events/${e.id}`)}
  getRowLabel={(e) => `Open ${e.title}`}
  caption="Pending events awaiting review"
  empty={<EmptyState icon="📋" title="No pending events" description="You're all caught up." />}
  columns={[
    { key: 'title',  header: 'Title',  cell: (e) => e.title },
    { key: 'status', header: 'Status', cell: (e) => <Badge status={e.status} /> },
    { key: 'date',   header: 'Date',   cell: (e) => fmt(e.date), nowrap: true, hideBelow: 'sm' },
  ]}
/>
```

---

## Best practices

- **Always pass a label to form fields.** Use `hideLabel` when the design has no
  room — the label still reaches screen readers. Never rely on `placeholder`
  alone as a label.
- **Let state drive the UI through props**, not branches in the page. Tables take
  `loading`/`empty`; buttons take `loading`. Pages stay declarative.
- **Use `Badge status={…}`** for event states instead of re-deriving colours —
  the tone mapping lives in one place.
- **Keep cell interactives self-contained.** Inside a clickable `DataTable` row,
  call `e.stopPropagation()` on inner links/buttons so the row handler doesn't
  swallow them. For the strongest semantics, prefer a real `<a>`/`<button>` in a
  cell over a whole-row click.
- **Style from the outside via `className`**, or add a token — don't fork a
  component to change one colour.
- **Reduced motion is handled for you.** Spinner, Skeleton, and hover/transition
  effects all respect `prefers-reduced-motion`.
- **Add new primitives here, directive-free**, unless they need hooks/browser
  APIs (then add `'use client'`). Extend the matching native element's props and
  forward refs on focusable controls.
```
