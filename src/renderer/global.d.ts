import type { Command } from '../core/model.js';

declare global {
  interface Window {
    manager: {
      execute(command: Command): Promise<any>;
      choose(kind: 'config' | 'client' | 'core'): Promise<string | null>;
      ready(): void;
    };
  }
}
export {};
