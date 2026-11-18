export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending';
  createdAt: Date;
}

export interface TaskRepository {
  create(input: { title: string; description: string | null }): Promise<Task>;
  close?(): Promise<void>;
}
