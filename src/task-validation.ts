import Ajv from 'ajv';

export const strictValidationOptions = {
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
} as const;

export const taskCreationBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
} as const;

interface TaskCreationBody {
  title: string;
  description?: string;
}

export interface ValidatedTaskInput {
  title: string;
  description: string | null;
}

export class TaskValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

const validateBody = new Ajv(strictValidationOptions)
  .compile<TaskCreationBody>(taskCreationBodySchema);

function validateTextIntegrity(value: string, field: 'title' | 'description'): void {
  // The u flag matches a valid pair as one code point outside the surrogate range.
  if (/[\u0000\uD800-\uDFFF]/u.test(value)) {
    throw new TaskValidationError(field, 'Text must not contain NUL or isolated UTF-16 surrogates');
  }
}

export function validateTaskInput(input: unknown): ValidatedTaskInput {
  if (!validateBody(input)) {
    const issue = validateBody.errors?.[0];
    const field = issue?.keyword === 'additionalProperties'
      ? String(issue.params.additionalProperty)
      : issue?.keyword === 'required'
        ? String(issue.params.missingProperty)
        : issue?.instancePath.slice(1) || 'body';
    throw new TaskValidationError(field, 'Invalid task input');
  }

  const title = input.title.trim();
  const titleLength = Array.from(title).length;
  if (titleLength < 1 || titleLength > 120) {
    throw new TaskValidationError('title', 'Title must contain 1 to 120 Unicode code points after trim');
  }

  validateTextIntegrity(title, 'title');

  const description = input.description;
  if (description !== undefined) {
    if (Array.from(description).length > 500) {
      throw new TaskValidationError('description', 'Description must contain at most 500 Unicode code points');
    }
    validateTextIntegrity(description, 'description');
  }

  return { title, description: description ?? null };
}
