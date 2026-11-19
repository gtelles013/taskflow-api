import type { Task } from './task-repository';

export type TaskCreationResponse = Omit<Task, 'createdAt'> & { createdAt: string };

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
