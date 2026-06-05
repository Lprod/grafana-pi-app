function unavailable(): never {
  throw new Error('The path module is not available in the browser.');
}

export const resolve = unavailable;
export const join = unavailable;
export const dirname = unavailable;
export const basename = unavailable;
