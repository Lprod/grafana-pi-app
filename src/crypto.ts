function unavailable(): never {
  throw new Error('The crypto module is not available in the browser. Use globalThis.crypto instead.');
}

export const randomFillSync = unavailable;
