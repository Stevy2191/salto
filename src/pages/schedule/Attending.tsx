import type { GymClass, Program, Schedule } from '../../../shared/types.ts'
import { Button } from '../../components/ui.tsx'

/**
 * Which classes are in this session. This is the step before Generate: pick
 * a whole program or individual classes, and each lands on its own window
 * (its own clock, else its program's, else the session's), packed into lanes.
 */
export function Attending({
  programs,
  classes,
  schedule,
  busy,
  onChange,
}: {
  programs: Program[]
  classes: GymClass[]
  schedule: Schedule
  busy: boolean
  onChange: (classIds: number[]) => void
}) {
  const attending = new Set(schedule.placements.map((p) => p.classId))
  const set = (ids: Set<number>) => onChange([...ids])

  const toggle = (classId: number) => {
    const next = new Set(attending)
    if (next.has(classId)) next.delete(classId)
    else next.add(classId)
    set(next)
  }

  const toggleProgram = (program: Program, allIn: boolean) => {
    const ids = classes.filter((c) => c.programId === program.id).map((c) => c.id)
    const next = new Set(attending)
    for (const id of ids) {
      if (allIn) next.delete(id)
      else next.add(id)
    }
    set(next)
  }

  const groups = [
    ...programs.map((program) => ({
      program,
      items: classes.filter((c) => c.programId === program.id),
    })),
    { program: null as Program | null, items: classes.filter((c) => c.programId === null) },
  ].filter((g) => g.items.length > 0)

  if (classes.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No classes yet — add some on the Classes page, then bring them into this session.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {groups.map(({ program, items }) => {
        const allIn = items.every((c) => attending.has(c.id))
        return (
          <div key={program?.id ?? 'none'}>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {program?.name ?? 'No program'}
              </span>
              {program?.defaultStartTime && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {program.defaultStartTime}–{program.defaultEndTime}
                </span>
              )}
              {program && (
                <Button
                  variant="secondary"
                  className="min-h-8 px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => toggleProgram(program, allIn)}
                >
                  {allIn ? 'Remove all' : 'Add whole program'}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {items.map((cls) => {
                const active = attending.has(cls.id)
                return (
                  <button
                    key={cls.id}
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => toggle(cls.id)}
                    className={`min-h-10 rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                      active
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'
                    }`}
                  >
                    {cls.name}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
