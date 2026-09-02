export class SpecError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "SpecError";
    this.line = line;
  }
}
