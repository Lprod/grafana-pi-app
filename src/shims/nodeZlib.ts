const unsupported = () => {
  throw new Error('node:zlib is not available in the browser workspace shell.');
};

export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
};

export const gzipSync = unsupported;
export const gunzipSync = unsupported;
