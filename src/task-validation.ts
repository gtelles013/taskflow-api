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

  const description = input.description;
  if (description !== undefined && Array.from(description).length > 500) {
    throw new TaskValidationError('description', 'Description must contain at most 500 Unicode code points');
  }

  return { title, description: description ?? null };
}
