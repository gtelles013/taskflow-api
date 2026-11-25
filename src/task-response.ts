import type { Task } from './task-repository';

export type TaskCreationResponse = Omit<Task, 'createdAt'> & { createdAt: string };

export interface TaskListResponse {
  items: TaskCreationResponse[];
  nextOffset: number | null;
  truncated: boolean;
}

export function toTaskResponse(task: Task): TaskCreationResponse {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
  };
}

export const taskCreationResponseSchema = {
  type: 'object',
  required: ['id', 'title', 'description', 'status', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['pending'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const taskListResponseSchema = {
  type: 'object',
  required: ['items', 'nextOffset', 'truncated'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: taskCreationResponseSchema },
    nextOffset: { type: ['integer', 'null'] },
    truncated: { type: 'boolean' },
  },
} as const;
