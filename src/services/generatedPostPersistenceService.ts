import type { Prisma } from '@prisma/client';

export class GeneratedPostMemoryPersistenceError extends Error {
  readonly recoverable = true;
  readonly code = 'POST_MEMORY_TRANSACTION_FAILED';

  constructor(message: string, readonly causeValue: unknown) {
    super(message);
    this.name = 'GeneratedPostMemoryPersistenceError';
  }
}

export type GeneratedPostTransactionRunner = {
  $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

/** Post creation and its future-memory records succeed or roll back together. */
export async function persistGeneratedPostWithMemory<T>(
  runner: GeneratedPostTransactionRunner,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  context: { userId: string; scheduledAt?: Date },
): Promise<T> {
  try {
    return await runner.$transaction(operation);
  } catch (error) {
    console.error('[post-memory-persistence] transaction failed; no partial post should remain', {
      userId: context.userId,
      scheduledAt: context.scheduledAt?.toISOString(),
      recoverable: true,
      code: 'POST_MEMORY_TRANSACTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    throw new GeneratedPostMemoryPersistenceError(
      'Generated post and memory persistence failed atomically; the slot can be retried safely.',
      error,
    );
  }
}
