/**
 * Raised when a file changed between load and save.
 *
 * Both content stores use the same optimistic-concurrency scheme: reading a
 * file yields a digest, saving passes it back, and a digest that no longer
 * matches means someone else saved while this form was open. Rejecting is
 * better than silently overwriting their edit.
 */
export class ConflictError extends Error {
  constructor(message = "The file changed since you loaded it.") {
    super(message);
    this.name = "ConflictError";
  }
}
