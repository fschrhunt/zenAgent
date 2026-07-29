/** FIFO serialization for operations that may conflict. */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public idle(): Promise<void> {
    return this.#tail;
  }
}
