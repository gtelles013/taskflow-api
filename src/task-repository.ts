export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending';
  createdAt: Date;
}

export interface TaskListInput {
  limit: number;
  offset: number;
}

export interface TaskListResult {
  items: Task[];
  hasMore: boolean;
}

export interface TaskRepository {
  create(input: { title: string; description: string | null }): Promise<Task>;
  list(input: TaskListInput): Promise<TaskListResult>;
  close?(): Promise<void>;
}
