import { describe, expect, it } from 'vitest';
import { TaskQueryValidationError, validateTaskQuery } from '../src/task-query';

describe('task list query', () => {
  it.each([
    ['/tasks', 50, 0], ['/tasks?', 50, 0], ['/tasks?limit=2', 2, 0],
    ['/tasks?offset=3', 50, 3], ['/tasks?limit=1&offset=0', 1, 0],
    ['/tasks?offset=100000&limit=100', 100, 100000],
    ['/tasks?l%69mit=%35%30', 50, 0],
  ])('accepts %s with the correct defaults and bounds', (url, limit, offset) => {
    expect(validateTaskQuery(url)).toEqual({ limit, offset });
  });

  it.each([
    'limit=+5', 'limit=%2B5', 'limit=1%26offset%3D0', 'limit=%2531',
    'lim%ZZit=1', 'limit=%ZZ', '%FF=1', 'limit=%FF', 'limit=%C0%AF',
    'limit=1&&offset=0', '&limit=1', 'limit=1&', 'limit=1=2',
    'limit=1&limit=1', 'limit=1&l%69mit=2', 'offset=0&%6Fffset=0',
    '=1', 'Limit=1', 'limit%5B%5D=1', 'limit[x]=1', '__proto__=1',
    'constructor=1', 'prototype=1', 'sort=1', 'limit', 'limit=',
    'limit=-1', 'limit=%205', 'limit=1.0', 'limit=1e1', 'limit=01',
    'limit=0', 'limit=101', 'offset=-1', 'offset=00', 'offset=100001',
    'limit=1%0A', 'limit=1%0D', 'limit=1%09', 'limit=1%00',
    'limit=1\n', 'offset=1%E2%80%A8', 'limit=%EF%BC%91', 'offset=' + '9'.repeat(80),
  ])('rejects invalid query %#', (query) => {
    expect(() => validateTaskQuery('/tasks?' + query)).toThrow(TaskQueryValidationError);
  });
});
