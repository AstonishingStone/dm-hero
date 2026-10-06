import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { quoteFts5Term } from '../../server/utils/search-query-parser'
import { normalizeText } from '../../server/utils/normalize'

// User input with FTS5 syntax characters (apostrophes, hyphens, dots, quotes...)
// must be matched literally instead of throwing "fts5: syntax error".
let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec('CREATE VIRTUAL TABLE t USING fts5(name, tokenize=\'unicode61 remove_diacritics 2\')')
  const insert = db.prepare('INSERT INTO t (name) VALUES (?)')
  insert.run('L\'épée du roi')
  insert.run('Shield-of "Dawn"')
  insert.run('Dr. Strange (Sorcerer)')
})

function search(input: string): string[] {
  const terms = normalizeText(input).split(/\s+/).filter(Boolean)
  const query = terms.map(t => `${quoteFts5Term(t)}*`).join(' ')
  return (db.prepare('SELECT name FROM t WHERE t MATCH ?').all(query) as { name: string }[]).map(r => r.name)
}

describe('quoteFts5Term', () => {
  it('wraps the term in double quotes and escapes inner quotes', () => {
    expect(quoteFts5Term('sword')).toBe('"sword"')
    expect(quoteFts5Term('say "hi"')).toBe('"say ""hi"""')
  })

  it.each([
    ['l\'épée', 'L\'épée du roi'],
    ['l\'ép', 'L\'épée du roi'],
    ['shield-of', 'Shield-of "Dawn"'],
    ['"dawn"', 'Shield-of "Dawn"'],
    ['dr. strange', 'Dr. Strange (Sorcerer)'],
    ['(sorcerer)', 'Dr. Strange (Sorcerer)'],
  ])('matches %s without FTS5 syntax errors', (input, expected) => {
    expect(search(input)).toEqual([expected])
  })

  it.each(['\'', '"', '-', '*', ':', '()', 'AND', 'NOT'])('does not throw on lone %s', (input) => {
    expect(() => search(input)).not.toThrow()
  })
})
