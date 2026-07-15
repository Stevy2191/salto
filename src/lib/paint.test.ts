import { describe, expect, it } from 'vitest'
import type { EventBlock, Placement, Schedule } from '../../shared/types.ts'
import {
  addPlacement,
  columnFree,
  eraseSpan,
  movePlacement,
  paintSpan,
  removeColumn,
  removePlacement,
  resizeBlock,
  resizePlacement,
  swapColumns,
  toggleBlockLock,
} from './paint.ts'

const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

let seq = 1
const block = (eventId: number, from: string, to: string): EventBlock => ({
  id: seq++,
  eventId,
  coachId: null,
  startMin: T(from),
  endMin: T(to),
  locked: false,
})

const placement = (
  id: number,
  classId: number,
  columnIndex: number,
  from: string,
  to: string,
  blocks: EventBlock[] = [],
): Placement => ({ id, classId, columnIndex, startMin: T(from), endMin: T(to), blocks })

const schedule = (placements: Placement[]): Schedule => ({ placements })

/** Readable shape for assertions: [event, start, end]. */
const shape = (s: Schedule, placementId = 1) =>
  s.placements
    .find((p) => p.id === placementId)!
    .blocks.map((b) => [b.eventId, b.startMin, b.endMin])

describe('paintSpan', () => {
  const base = schedule([placement(1, 1, 0, '16:00', '17:00')])

  it('paints an event across a span', () => {
    const after = paintSpan(base, 1, 5, T('16:10'), T('16:40'))
    expect(shape(after)).toEqual([[5, T('16:10'), T('16:40')]])
  })

  it('works dragged upward as well as downward', () => {
    const up = paintSpan(base, 1, 5, T('16:40'), T('16:10'))
    expect(shape(up)).toEqual([[5, T('16:10'), T('16:40')]])
  })

  it('snaps to 5-minute boundaries', () => {
    const after = paintSpan(base, 1, 5, T('16:02'), T('16:38'))
    expect(shape(after)).toEqual([[5, T('16:00'), T('16:40')]])
  })

  it('clamps to the class window — a drag off the end just stops', () => {
    const after = paintSpan(base, 1, 5, T('16:30'), T('18:00'))
    expect(shape(after)).toEqual([[5, T('16:30'), T('17:00')]])
  })

  it('ignores a drag shorter than one row', () => {
    expect(paintSpan(base, 1, 5, T('16:10'), T('16:10'))).toBe(base)
  })

  it('needs no required events set up — any event, any span', () => {
    const after = paintSpan(base, 1, 99, T('16:00'), T('17:00'))
    expect(shape(after)).toEqual([[99, T('16:00'), T('17:00')]])
  })
})

describe('painting over existing work', () => {
  it('overwrites a block entirely when covered', () => {
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '16:30')])])
    const after = paintSpan(base, 1, 6, T('16:00'), T('16:30'))
    expect(shape(after)).toEqual([[6, T('16:00'), T('16:30')]])
  })

  it('trims a block it overlaps at the end', () => {
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '16:40')])])
    const after = paintSpan(base, 1, 6, T('16:20'), T('16:50'))
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:20')],
      [6, T('16:20'), T('16:50')],
    ])
  })

  it('splits a block painted through the middle', () => {
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '17:00')])])
    const after = paintSpan(base, 1, 6, T('16:20'), T('16:40'))
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:20')],
      [6, T('16:20'), T('16:40')],
      [5, T('16:40'), T('17:00')],
    ])
  })

  it('leaves two consecutive blocks on the same event as two blocks', () => {
    // The boundary is the user's, not an accident — never merge it away.
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '16:30')])])
    const after = paintSpan(base, 1, 5, T('16:30'), T('17:00'))
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:30')],
      [5, T('16:30'), T('17:00')],
    ])
  })

  it('never leaves overlapping blocks behind', () => {
    let s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    s = paintSpan(s, 1, 5, T('16:00'), T('16:40'))
    s = paintSpan(s, 1, 6, T('16:30'), T('16:50'))
    s = paintSpan(s, 1, 7, T('16:10'), T('16:35'))
    const blocks = s.placements[0]!.blocks
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.startMin).toBeGreaterThanOrEqual(blocks[i - 1]!.endMin)
    }
  })
})

describe('eraseSpan', () => {
  it('clears a span, splitting what it cuts through', () => {
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '17:00')])])
    const after = eraseSpan(base, 1, T('16:20'), T('16:40'))
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:20')],
      [5, T('16:40'), T('17:00')],
    ])
  })

  it('removes a block it fully covers', () => {
    const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:10', '16:30')])])
    expect(shape(eraseSpan(base, 1, T('16:00'), T('17:00')))).toEqual([])
  })
})

describe('resizeBlock', () => {
  const base = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:20', '16:40')])])

  it('drags the end edge later', () => {
    expect(shape(resizeBlock(base, 1, base.placements[0]!.blocks[0]!.id, 'end', T('16:55')))).toEqual([
      [5, T('16:20'), T('16:55')],
    ])
  })

  it('drags the start edge earlier', () => {
    expect(
      shape(resizeBlock(base, 1, base.placements[0]!.blocks[0]!.id, 'start', T('16:05'))),
    ).toEqual([[5, T('16:05'), T('16:40')]])
  })

  it('will not shrink below one row', () => {
    const after = resizeBlock(base, 1, base.placements[0]!.blocks[0]!.id, 'end', T('16:00'))
    expect(shape(after)).toEqual([[5, T('16:20'), T('16:25')]])
  })

  it('will not grow outside the class window', () => {
    const after = resizeBlock(base, 1, base.placements[0]!.blocks[0]!.id, 'end', T('18:00'))
    expect(shape(after)).toEqual([[5, T('16:20'), T('17:00')]])
  })

  it('eats a neighbour it grows into', () => {
    const b1 = block(5, '16:00', '16:20')
    const b2 = block(6, '16:20', '16:40')
    const s = schedule([placement(1, 1, 0, '16:00', '17:00', [b1, b2])])
    const after = resizeBlock(s, 1, b2.id, 'start', T('16:10'))
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:10')],
      [6, T('16:10'), T('16:40')],
    ])
  })
})

describe('block flags', () => {
  it('toggles the lock', () => {
    const b = block(5, '16:00', '16:30')
    const s = schedule([placement(1, 1, 0, '16:00', '17:00', [b])])
    const after = toggleBlockLock(s, 1, b.id)
    expect(after.placements[0]!.blocks[0]!.locked).toBe(true)
    expect(toggleBlockLock(after, 1, b.id).placements[0]!.blocks[0]!.locked).toBe(false)
  })
})

describe('placements in columns', () => {
  it('stacks classes in one column when they do not overlap', () => {
    let s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    const after = addPlacement(s, 2, 0, T('17:00'), T('18:00'))
    expect(after).not.toBeNull()
    expect(after!.placements).toHaveLength(2)
  })

  it('refuses to add a class over another in the same column', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    expect(addPlacement(s, 2, 0, T('16:30'), T('17:30'))).toBeNull()
  })

  it('allows the same window in a different column', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    expect(addPlacement(s, 2, 1, T('16:00'), T('17:00'))).not.toBeNull()
  })

  it('treats touching windows as free, not overlapping', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    expect(columnFree(s, 0, T('17:00'), T('18:00'))).toBe(true)
    expect(columnFree(s, 0, T('16:55'), T('18:00'))).toBe(false)
  })

  it('moves a class to another column, keeping its painted work', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '16:30')])])
    const after = movePlacement(s, 1, 2)!
    expect(after.placements[0]!.columnIndex).toBe(2)
    expect(after.placements[0]!.blocks).toHaveLength(1)
  })

  it('refuses a move into an occupied lane', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00'), placement(2, 2, 1, '16:30', '17:30')])
    expect(movePlacement(s, 1, 1)).toBeNull()
  })

  it('removes a placement', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    expect(removePlacement(s, 1).placements).toEqual([])
  })
})

describe('resizePlacement', () => {
  it('changes a class window', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00')])
    const after = resizePlacement(s, 1, T('16:30'), T('18:00'))!
    expect([after.placements[0]!.startMin, after.placements[0]!.endMin]).toEqual([
      T('16:30'),
      T('18:00'),
    ])
  })

  it('trims painted work that no longer fits', () => {
    const s = schedule([
      placement(1, 1, 0, '16:00', '17:00', [block(5, '16:00', '16:30'), block(6, '16:30', '17:00')]),
    ])
    const after = resizePlacement(s, 1, T('16:00'), T('16:40'))!
    expect(shape(after)).toEqual([
      [5, T('16:00'), T('16:30')],
      [6, T('16:30'), T('16:40')],
    ])
  })

  it('drops work that falls entirely outside the new window', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00', [block(5, '16:40', '17:00')])])
    expect(shape(resizePlacement(s, 1, T('16:00'), T('16:30'))!)).toEqual([])
  })

  it('refuses a resize that would collide in its lane', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00'), placement(2, 2, 0, '17:00', '18:00')])
    expect(resizePlacement(s, 1, T('16:00'), T('17:30'))).toBeNull()
  })
})

describe('columns', () => {
  it('swaps two columns with everything in them', () => {
    const s = schedule([placement(1, 1, 0, '16:00', '17:00'), placement(2, 2, 1, '16:00', '17:00')])
    const after = swapColumns(s, 0, 1)
    expect(after.placements.find((p) => p.id === 1)!.columnIndex).toBe(1)
    expect(after.placements.find((p) => p.id === 2)!.columnIndex).toBe(0)
  })

  it('removes a column and shifts the rest left', () => {
    const s = schedule([
      placement(1, 1, 0, '16:00', '17:00'),
      placement(2, 2, 1, '16:00', '17:00'),
      placement(3, 3, 2, '16:00', '17:00'),
    ])
    const after = removeColumn(s, 1)
    expect(after.placements.map((p) => [p.id, p.columnIndex])).toEqual([
      [1, 0],
      [3, 1],
    ])
  })
})
