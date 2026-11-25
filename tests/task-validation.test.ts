import { describe, expect, it } from 'vitest';
import { TaskValidationError, validateTaskInput } from '../src/task-validation';

describe('task input structure', () => {
  it.each([undefined, null, [], 'title', 1, true, {}])('rejects invalid body %j', (body) => {
    expect(() => validateTaskInput(body)).toThrow(TaskValidationError);
  });

  it.each([null, 123, true, false, {}, [], undefined])('rejects non-string title %j without coercion', (title) => {
    expect(() => validateTaskInput({ title })).toThrow(TaskValidationError);
  });

  it.each([
    ['id', '00000000-0000-4000-8000-000000000000'],
    ['status', 'pending'],
    ['createdAt', '2026-11-17T00:00:00.000Z'],
    ['id', null], ['status', null], ['createdAt', null],
    ['priority', 'high'], ['dueDate', '2026-12-01'], ['extra', undefined],
  ])('rejects extra field %s with value %j', (field, value) => {
    const body = Object.freeze({ title: 'Example', [field as string]: value });
    expect(() => validateTaskInput(body)).toThrow(TaskValidationError);
    expect(Object.hasOwn(body, field as string)).toBe(true);
  });

  it('does not mutate or add defaults to the input', () => {
    const body = Object.freeze({ title: '  Example  ' });
    expect(validateTaskInput(body)).toEqual({ title: 'Example', description: null });
    expect(body).toEqual({ title: '  Example  ' });
    expect(Object.hasOwn(body, 'description')).toBe(false);
  });
});

describe('title normalization and Unicode limits', () => {
  it.each(['a', 'a'.repeat(120), '\u{1F600}'.repeat(120), 'e\u0301'.repeat(60)])('accepts valid title %#', (title) => {
    expect(validateTaskInput({ title: ' \t' + title + '\n ' }).title).toBe(title);
  });

  it.each(['', ' \t\n ', 'a'.repeat(121), '\u{1F600}'.repeat(121), 'e\u0301'.repeat(61)])('rejects invalid title %#', (title) => {
    expect(() => validateTaskInput({ title })).toThrow(TaskValidationError);
  });

  it('trims Unicode whitespace and preserves internal spaces', () => {
    expect(validateTaskInput({ title: '\u00A0a  b\uFEFF' }).title).toBe('a  b');
  });
});

describe('description validation', () => {
  it('maps omission to null without modifying the body', () => {
    expect(validateTaskInput({ title: 'Example' }).description).toBeNull();
  });

  it.each(['', '   ', '  description \n ', 'a'.repeat(500), '\u{1F600}'.repeat(500), 'e\u0301'.repeat(250)])('preserves valid description %#', (description) => {
    expect(validateTaskInput({ title: 'Example', description }).description).toBe(description);
  });

  it.each([null, 123, true, false, {}, []])('rejects non-string description %j', (description) => {
    expect(() => validateTaskInput({ title: 'Example', description })).toThrow(TaskValidationError);
  });

  it.each(['a'.repeat(501), '\u{1F600}'.repeat(501), 'e\u0301'.repeat(251)])('rejects overlong description %#', (description) => {
    expect(() => validateTaskInput({ title: 'Example', description })).toThrow(TaskValidationError);
  });
});

describe('Unicode text integrity', () => {
  const invalidText = [
    { name: 'leading NUL', value: '\u0000text' },
    { name: 'embedded NUL', value: 'a\u0000b' },
    { name: 'trailing NUL', value: 'text\u0000' },
    { name: 'NUL only', value: '\u0000' },
    { name: 'multiple NULs', value: 'a\u0000b\u0000c' },
    { name: 'NUL with surrounding spaces', value: '  a\u0000b  ' },
    { name: 'lowest isolated high surrogate', value: '\uD800' },
    { name: 'highest isolated high surrogate', value: '\uDBFF' },
    { name: 'lowest isolated low surrogate', value: '\uDC00' },
    { name: 'highest isolated low surrogate', value: '\uDFFF' },
    { name: 'two high surrogates', value: '\uD800\uDBFF' },
    { name: 'two low surrogates', value: '\uDC00\uDFFF' },
    { name: 'reversed surrogate pair', value: '\uDC00\uD800' },
    { name: 'isolated high surrogate before a valid pair', value: '\uD800\uD83D\uDE00' },
    { name: 'isolated low surrogate after a valid pair', value: '\uD83D\uDE00\uDFFF' },
    { name: 'isolated surrogate between valid characters', value: 'a\uD800b' },
  ];
  const fields = ['title', 'description'] as const;

  it.each(fields.flatMap((field) => invalidText.map((fixture) => ({ field, ...fixture }))))(
    'rejects $name in $field',
    ({ field, value }) => {
      expect.assertions(2);
      try {
        validateTaskInput({ title: 'Example', [field]: value });
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect(error).toHaveProperty('field', field);
      }
    },
  );

  it.each([
    { name: 'first and last supplementary code points', value: '\uD800\uDC00\uDBFF\uDFFF' },
    { name: 'explicit replacement character', value: '\uFFFD' },
    { name: 'interior tab and newline', value: 'a\tb\nc' },
    { name: 'mixed valid Unicode', value: '\u{10000}\u{1F600}e\u0301\uFFFD\tline\n\u{10FFFF}' },
  ])('preserves $name in both text fields', ({ value }) => {
    const description = '  ' + value + '  ';
    expect(validateTaskInput({ title: ' \t' + value + '\n ', description }))
      .toEqual({ title: value, description });
  });
});
