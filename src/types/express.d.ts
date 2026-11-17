// Request augmentation for values attached by core middleware.
export {};

declare global {
  namespace Express {
    interface Request {
      /** Set by `requestId` middleware for every request (BACKEND_STRUCTURE.md §5.1 stage 1). */
      requestId: string;
      /** Parsed output of the `validate` middleware (params/query/body after Zod transforms). */
      validated?: {
        params?: unknown;
        query?: unknown;
        body?: unknown;
      };
    }
  }
}
