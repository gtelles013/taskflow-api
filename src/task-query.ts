import type { TaskListInput } from './task-repository';

export const MAX_TASK_OFFSET = 100000;

export class TaskQueryValidationError extends Error {
  constructor() {
    super('Invalid task query');
    this.name = 'TaskQueryValidationError';
  }
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    throw new TaskQueryValidationError();
  }
}

function readDecimal(value: string, min: number, max: number): number {
  if (value.length > String(max).length || !/^(?:0|[1-9][0-9]*)(?![\s\S])/.test(value)) {
    throw new TaskQueryValidationError();
  }
  const number = Number(value);
  if (number < min || number > max) throw new TaskQueryValidationError();
  return number;
}

export function validateTaskQuery(url: string | undefined): TaskListInput {
  const separator = url?.indexOf('?') ?? -1;
  const query = separator < 0 ? '' : url?.slice(separator + 1);
  let limit: number | undefined;
  let offset: number | undefined;

  if (query) {
    for (const segment of query.split('&')) {
      const equals = segment.indexOf('=');
      if (equals < 0) throw new TaskQueryValidationError();
      const name = decodeQueryPart(segment.slice(0, equals));
      const value = decodeQueryPart(segment.slice(equals + 1));

      if (name === 'limit' && limit === undefined) limit = readDecimal(value, 1, 100);
      else if (name === 'offset' && offset === undefined) offset = readDecimal(value, 0, MAX_TASK_OFFSET);
      else throw new TaskQueryValidationError();
    }
  }

  return { limit: limit ?? 50, offset: offset ?? 0 };
}
