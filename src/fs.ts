function unavailable(): never {
  throw new Error('The fs module is not available in the browser.');
}

export const readFileSync = unavailable;
