import { startServer } from './server-runtime';

if (require.main === module) {
  void startServer();
}
